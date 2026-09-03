/**
 * A bounded pool of live cloud browsers.
 *
 * The pool starts browsers, keeps their number inside the plan's parallel limit,
 * gives each a fresh fingerprint and stops every paid session on the way out.
 * `lease()` hands out a live browser and takes it back:
 *
 *     await using pool = await client.browsers();
 *     await pool.lease(async (browser) => {
 *       await browser.goto(url);
 *     });
 *
 * `map()` is a thin wrapper over the lease for the common case.
 */

import type { Surfsky } from "../client.js";
import { BrowserTimeoutError, RateLimitError } from "../errors.js";
import { isProxySource } from "../proxy.js";
import type { SessionOptions } from "../resources/profiles.js";
import { stopSession } from "../resources/profiles.js";
import { PLAN_FULL } from "../transport.js";
import { parseOneTimeStartRequest } from "../types.js";
import { withTimeout } from "../util.js";
import { Browser, normalizeBlocked, normalizeUrls } from "./browser.js";
import type { CreateWebSocket } from "./cdp.js";

export type PoolHandler<I, R> = (browser: Browser, item: I) => Promise<R>;

export interface PoolOptions extends SessionOptions {
  /** Live browsers at most; `"auto"` (default) is the plan's cap. */
  concurrency?: number | "auto";
  blockResources?: Iterable<string> | null;
  blockUrls?: readonly string[] | null;
  createWebSocket?: CreateWebSocket;
}

/** Throw from a `map` handler to end the run after this item. */
export class StopRun extends Error {
  constructor(message = "run stopped") {
    super(message);
    this.name = "StopRun";
  }
}

export type PoolOutcome<I, R> =
  | { ok: true; item: I; index: number; value: R }
  | { ok: false; item: I; index: number; error: unknown };

function planIsFull(err: unknown): boolean {
  return err instanceof RateLimitError && err.code === PLAN_FULL;
}

class Semaphore {
  #free: number;
  readonly #waiters: (() => void)[] = [];

  constructor(slots: number) {
    this.#free = slots;
  }

  acquire(): Promise<void> {
    if (this.#free > 0) {
      this.#free -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  release(): void {
    const next = this.#waiters.shift();
    if (next !== undefined)
      next(); // the slot goes straight to the next in line
    else this.#free += 1;
  }
}

export class BrowserPool implements AsyncDisposable {
  readonly sessionOptions: SessionOptions;
  readonly blockedResources: ReadonlySet<string>;
  readonly blockedUrls: readonly string[];
  readonly #client: Surfsky;
  readonly #concurrency: number | "auto";
  readonly #createWebSocket: CreateWebSocket | undefined;
  #idle: Browser[] = [];
  #owned = 0;
  #planFull = false;
  #planFullError: unknown;
  #waiters: (() => void)[] = [];
  #capacity = 0;
  #slots: Semaphore | undefined;

  constructor(client: Surfsky, options: PoolOptions = {}) {
    const {
      concurrency = "auto",
      blockResources,
      blockUrls,
      createWebSocket,
      ...sessionOptions
    } = options;
    if (concurrency !== "auto" && !Number.isInteger(concurrency)) {
      throw new TypeError('concurrency must be a whole number or "auto"');
    }
    this.#client = client;
    this.#concurrency = concurrency;
    this.blockedResources = normalizeBlocked(blockResources);
    this.blockedUrls = normalizeUrls(blockUrls);
    this.#createWebSocket = createWebSocket;
    const { proxy } = sessionOptions;
    parseOneTimeStartRequest({
      ...sessionOptions,
      proxy: typeof proxy === "function" || isProxySource(proxy) ? undefined : proxy,
    });
    this.sessionOptions = sessionOptions;
  }

  /** Max live browsers. */
  get capacity(): number {
    this.#requireOpen();
    return this.#capacity;
  }

  #requireOpen(): Semaphore {
    if (this.#slots === undefined) {
      throw new Error("the pool is not open: use `await client.browsers()` or `open()`");
    }
    return this.#slots;
  }

  async open(): Promise<this> {
    const total =
      this.#concurrency === "auto"
        ? await this.#client.account.maxBrowsers()
        : this.#concurrency;
    this.#capacity = Math.max(1, total);
    this.#slots = new Semaphore(this.#capacity);
    this.#planFull = false;
    this.#planFullError = undefined;
    this.#owned = 0;
    return this;
  }

  /** Stop every idle browser. A browser still on lease is stopped when its lease ends. */
  async close(): Promise<void> {
    this.#slots = undefined;
    const idle = this.#idle;
    this.#idle = [];
    this.#owned -= idle.length;
    await Promise.all(idle.map((browser) => this.#teardown(browser)));
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  /** Run `fn` on a live browser, then hand the browser back. Waits while all are busy. */
  async lease<R>(fn: (browser: Browser) => Promise<R>): Promise<R> {
    const slots = this.#requireOpen();
    await slots.acquire();
    try {
      if (this.#slots !== slots)
        throw new Error("the pool was closed while waiting for a slot");
      const browser = await this.#acquire();
      browser._lease();
      try {
        return await fn(browser);
      } finally {
        await this.#release(browser);
      }
    } finally {
      slots.release();
    }
  }

  #wait(): Promise<void> {
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  #notifyAll(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const wake of waiters) wake();
  }

  async #acquire(): Promise<Browser> {
    while (true) {
      const dead = this.#idle.filter((browser) => browser.shouldRecycle);
      if (dead.length > 0) {
        this.#idle = this.#idle.filter((browser) => !browser.shouldRecycle);
        this.#owned -= dead.length;
        this.#planFull = false;
        this.#notifyAll();
        await Promise.all(dead.map((browser) => this.#teardown(browser)));
        continue;
      }
      const idle = this.#idle.pop();
      if (idle !== undefined) return idle;
      if (this.#planFull) {
        if (this.#owned === 0) {
          throw (
            this.#planFullError ??
            new RateLimitError("parallel browser limit reached", {
              statusCode: 429,
            })
          );
        }
        await this.#wait(); // 1 refusal is enough, do not retry
        continue;
      }
      this.#owned += 1; // before the await: a start in flight is capacity too
      let browser: Browser;
      try {
        browser = await this.#startBrowser();
      } catch (err) {
        const full = planIsFull(err);
        this.#owned -= 1;
        if (full) {
          this.#planFull = true;
          this.#planFullError = err;
        }
        const nothingLeft = this.#owned === 0;
        this.#notifyAll();
        if (!full || nothingLeft) throw err;
        this.#client.logger.info("plan is full, waiting for a browser of ours");
        continue;
      }
      this.#planFull = false;
      return browser;
    }
  }

  async #release(browser: Browser): Promise<void> {
    if (!browser.shouldRecycle) {
      try {
        await withTimeout(
          browser._endLease(),
          5_000,
          () => new BrowserTimeoutError("lease cleanup timed out"),
        );
      } catch (err) {
        this.#client.logger.warn(
          `could not clean up ${browser.internalUuid}: ${String(err)}`,
        );
        browser.retire();
      }
    }
    const recycle = browser.shouldRecycle || this.#slots === undefined;
    if (recycle) await this.#teardown(browser);
    if (recycle) {
      this.#owned -= 1;
      this.#planFull = false;
    } else {
      this.#idle.push(browser);
    }
    this.#notifyAll();
  }

  /** Run every item through `handler` on a leased browser, `capacity` at a time. */
  async map<I, R>(
    handler: PoolHandler<I, R>,
    items: Iterable<I>,
  ): Promise<PoolOutcome<I, R>[]> {
    const work = items[Symbol.iterator](); // shared: no item is taken twice
    const outcomes: PoolOutcome<I, R>[] = [];
    let index = 0;
    let stopped = false;

    const worker = async (): Promise<void> => {
      while (!stopped) {
        const next = work.next();
        if (next.done) return;
        const item = next.value;
        const at = index;
        index += 1;
        try {
          const value = await this.lease((browser) => handler(browser, item));
          outcomes.push({ ok: true, item, index: at, value });
        } catch (error) {
          outcomes.push({ ok: false, item, index: at, error });
          if (error instanceof StopRun) {
            stopped = true;
            return;
          }
        }
      }
    };

    await Promise.all(Array.from({ length: this.capacity }, worker));
    return outcomes.sort((a, b) => a.index - b.index);
  }

  async #startBrowser(): Promise<Browser> {
    const session = await this.#client.profiles.startOneTime(this.sessionOptions);
    let browser: Browser;
    try {
      browser = new Browser(session, {
        blockResources: this.blockedResources,
        blockUrls: this.blockedUrls,
        createWebSocket: this.#createWebSocket,
        logger: this.#client.logger,
      });
      await browser.connect();
    } catch (err) {
      await stopSession(this.#client, session.internal_uuid);
      throw err;
    }
    this.#client.logger.info(`pool browser ${browser.internalUuid} started`);
    return browser;
  }

  async #teardown(browser: Browser): Promise<void> {
    await browser.close();
    await stopSession(this.#client, browser.internalUuid);
  }
}
