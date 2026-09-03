import { Browser, normalizeBlocked, normalizeUrls } from "./browser/browser.js";
import type { CreateWebSocket } from "./browser/cdp.js";
import type { PoolHandler, PoolOptions, PoolOutcome } from "./browser/pool.js";
import { BrowserPool } from "./browser/pool.js";
import { ConfigurationError } from "./errors.js";
import { Account } from "./resources/account.js";
import { Extensions } from "./resources/extensions.js";
import { Fingerprints } from "./resources/fingerprints.js";
import type { SessionOptions } from "./resources/profiles.js";
import { Profiles, stopSession } from "./resources/profiles.js";
import { Proxies } from "./resources/proxies.js";
import type { Logger, Params, Spec } from "./transport.js";
import { AUTH_HEADER, makeLogger, result, send } from "./transport.js";
import type { Session } from "./types.js";
import { VERSION } from "./version.js";

export interface SurfskyOptions {
  /** Falls back to `SURFSKY_API_TOKEN`. */
  apiToken?: string;
  /** Falls back to `SURFSKY_API_BASE_URL`. */
  baseUrl?: string;
  /** Per-request timeout in ms. Default 30_000. */
  timeout?: number;
  /** Default 3. */
  maxRetries?: number;
  /** Base retry delay in ms, doubled per attempt. Default 500. */
  backoff?: number;
  headers?: Record<string, string>;
  /** Warnings and errors go to the console by default; `null` silences the SDK. */
  logger?: Partial<Logger> | null;
  /** Mostly for tests. */
  fetch?: typeof fetch;
}

export interface RequestOptions {
  json?: unknown;
  params?: Params;
  body?: BodyInit;
  headers?: Record<string, string>;
  timeout?: number;
}

export interface SessionStartOptions extends SessionOptions {
  /** A saved profile to start; a one-time session when absent. */
  profileUuid?: string;
}

export interface BrowserStartOptions extends SessionStartOptions {
  /** CDP resource types to drop: `["image", "font", "media"]` saves proxy traffic. */
  blockResources?: Iterable<string> | null;
  /** Fetch URL patterns to drop (`*` wildcards). */
  blockUrls?: readonly string[] | null;
  /** ms, default 30_000 */
  connectTimeout?: number;
  /** ms per CDP command, default 60_000; `null` for none */
  commandTimeout?: number | null;
  createWebSocket?: CreateWebSocket;
}

function userAgent(): string {
  const bun = (globalThis as { Bun?: { version: string } }).Bun;
  const runtime = bun ? `bun/${bun.version}` : `node/${process.versions.node}`;
  return `surfsky-js/${VERSION} ${runtime}`;
}

export function connection(
  apiToken?: string,
  baseUrl?: string,
): { baseUrl: string; headers: Record<string, string> } {
  const token = apiToken || process.env.SURFSKY_API_TOKEN;
  if (!token) throw new ConfigurationError("pass apiToken or set SURFSKY_API_TOKEN");
  const url = baseUrl || process.env.SURFSKY_API_BASE_URL;
  if (!url) throw new ConfigurationError("pass baseUrl or set SURFSKY_API_BASE_URL");
  return {
    baseUrl: url.replace(/\/+$/, ""),
    headers: {
      [AUTH_HEADER]: token,
      Accept: "application/json",
      "User-Agent": userAgent(),
    },
  };
}

/** A started session that stops itself on `stop()` or `await using`. */
export type ManagedSession = Session & AsyncDisposable & { stop(): Promise<void> };

export class Surfsky implements AsyncDisposable {
  readonly baseUrl: string;
  readonly headers: Record<string, string>;
  readonly timeout: number;
  readonly maxRetries: number;
  readonly backoff: number;
  readonly logger: Logger;
  readonly fetch: typeof fetch;
  readonly profiles: Profiles;
  readonly proxies: Proxies;
  readonly fingerprints: Fingerprints;
  readonly extensions: Extensions;
  readonly account: Account;

  constructor(options: SurfskyOptions = {}) {
    const { baseUrl, headers } = connection(options.apiToken, options.baseUrl);
    this.baseUrl = baseUrl;
    this.headers = { ...headers, ...options.headers };
    this.timeout = options.timeout ?? 30_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.backoff = options.backoff ?? 500;
    this.logger = makeLogger(options.logger);
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.profiles = new Profiles(this);
    this.proxies = new Proxies(this);
    this.fingerprints = new Fingerprints(this);
    this.extensions = new Extensions(this);
    this.account = new Account(this);
  }

  withOptions(options: {
    timeout?: number;
    maxRetries?: number;
    headers?: Record<string, string>;
  }): Surfsky {
    return new Surfsky({
      apiToken: this.headers[AUTH_HEADER],
      baseUrl: this.baseUrl,
      timeout: options.timeout ?? this.timeout,
      maxRetries: options.maxRetries ?? this.maxRetries,
      backoff: this.backoff,
      headers: { ...this.headers, ...options.headers },
      logger: this.logger,
      fetch: this.fetch,
    });
  }

  async call<T>(spec: Spec<T>): Promise<T> {
    return result(spec, await this.#send(spec));
  }

  /** A raw call for endpoints the SDK does not cover. Never throws on status. */
  request(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const spec: Spec<unknown> = {
      method,
      path,
      json: options.json,
      params: options.params,
      body: options.body,
      timeout: options.timeout,
    };
    return this.#send(spec, options.headers);
  }

  #send(spec: Spec<unknown>, headers?: Record<string, string>): Promise<Response> {
    return send(spec, {
      fetch: this.fetch,
      baseUrl: this.baseUrl,
      headers: { ...this.headers, ...headers },
      retries: this.maxRetries,
      backoff: this.backoff,
      timeout: this.timeout,
      logger: this.logger,
    });
  }

  /** Start a session; `stop()` it (or `await using`) so it does not keep billing. */
  async session(options: SessionStartOptions = {}): Promise<ManagedSession> {
    const { profileUuid, ...rest } = options;
    const session =
      profileUuid === undefined
        ? await this.profiles.startOneTime(rest)
        : await this.profiles.start(profileUuid, rest);
    let stopping: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      stopping ??= stopSession(this, session.internal_uuid);
      return stopping;
    };
    return { ...session, stop, [Symbol.asyncDispose]: stop };
  }

  /** Start a session and connect a `Browser` to it. `close()` stops the session. */
  async browser(options: BrowserStartOptions = {}): Promise<Browser> {
    const {
      profileUuid,
      blockResources,
      blockUrls,
      connectTimeout,
      commandTimeout,
      createWebSocket,
      ...sessionOptions
    } = options;
    // validate before a session is billed
    const blocked = normalizeBlocked(blockResources);
    const urls = normalizeUrls(blockUrls);
    const session = await this.session({ profileUuid, ...sessionOptions });
    const browser = new Browser(session, {
      blockResources: blocked,
      blockUrls: urls,
      connectTimeout,
      commandTimeout,
      createWebSocket,
      logger: this.logger,
      onClose: () => session.stop(),
    });
    await browser.connect(); // a failure closes the browser, which stops the session
    return browser;
  }

  /** An open `BrowserPool`. `close()` stops every browser in it. */
  async browsers(options: PoolOptions = {}): Promise<BrowserPool> {
    return new BrowserPool(this, options).open();
  }

  /** `browsers()` and `pool.map()` in 1 call. */
  async map<I, R>(
    handler: PoolHandler<I, R>,
    items: Iterable<I>,
    options: PoolOptions = {},
  ): Promise<PoolOutcome<I, R>[]> {
    const pool = await this.browsers(options);
    try {
      return await pool.map(handler, items);
    } finally {
      await pool.close();
    }
  }

  /** Nothing to release with fetch; here for `await using` symmetry. */
  async close(): Promise<void> {}

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
