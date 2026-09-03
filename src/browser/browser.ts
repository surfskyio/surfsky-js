import { BrowserTimeoutError } from "../errors.js";
import type { Logger } from "../transport.js";
import { makeLogger } from "../transport.js";
import type { Session } from "../types.js";
import { Flag, sleep, withTimeout } from "../util.js";
import type { CreateWebSocket, EventHandler } from "./cdp.js";
import { CDPClient } from "./cdp.js";
import type { WaitOptions } from "./page.js";
import { Deadline, Page, POLL_INTERVAL } from "./page.js";

// Pauses the document response so its HTTP status can be read, and nothing else
const STATUS_PATTERN = {
  urlPattern: "*",
  resourceType: "Document",
  requestStage: "Response",
};

// Every page target, present and future, attached on this socket and paused
// until its setup is done
const AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
  filter: [{ type: "page" }],
};

const NON_WEB_SCHEMES = ["chrome-extension://", "devtools://", "chrome://"];

const START_PAGES = ["chrome://newtab", "chrome://new-tab-page"];

function isStartPage(url: string): boolean {
  return START_PAGES.some((page) => url.startsWith(page));
}

// CDP Network.ResourceType values
export const RESOURCE_TYPES: Readonly<Record<string, string>> = Object.fromEntries(
  [
    "Stylesheet",
    "Image",
    "Media",
    "Font",
    "Script",
    "TextTrack",
    "XHR",
    "Fetch",
    "Prefetch",
    "EventSource",
    "WebSocket",
    "Manifest",
    "SignedExchange",
    "Ping",
    "CSPViolationReport",
    "Preflight",
    "FedCM",
    "Other",
  ].map((name) => [name.toLowerCase(), name]),
);

export function normalizeBlocked(
  resources?: Iterable<string> | null,
): ReadonlySet<string> {
  if (typeof resources === "string") {
    throw new TypeError("blockResources takes a list of resource types, not 1 string");
  }
  const blocked = new Set([...(resources ?? [])].map((name) => name.toLowerCase()));
  if (blocked.has("document"))
    throw new TypeError("blocking 'document' blocks the page itself");
  const unknown = [...blocked].filter((name) => !(name in RESOURCE_TYPES)).sort();
  if (unknown.length > 0) {
    const valid = Object.keys(RESOURCE_TYPES).sort();
    throw new TypeError(
      `unknown resource types ${JSON.stringify(unknown)}; valid: ${JSON.stringify(valid)}`,
    );
  }
  return blocked;
}

export function normalizeUrls(patterns?: readonly string[] | null): readonly string[] {
  // "*.png" as a string would become "*", ".", "p"... and "*" blocks all
  if (typeof patterns === "string") {
    throw new TypeError("blockUrls takes a list of patterns, not 1 string");
  }
  return [...(patterns ?? [])];
}

export interface BrowserOptions {
  blockResources?: Iterable<string> | null;
  blockUrls?: readonly string[] | null;
  connectTimeout?: number;
  commandTimeout?: number | null;
  createWebSocket?: CreateWebSocket;
  logger?: Partial<Logger> | null;
  onClose?: () => Promise<void> | void;
}

/** A connected cloud browser, and the page its session started with. */
export class Browser extends Page implements AsyncDisposable {
  readonly session: Session;
  readonly data: Record<string, unknown> = {};
  readonly blockedResources: ReadonlySet<string>;
  readonly blockedUrls: readonly string[];
  readonly connectTimeout: number;
  readonly commandTimeout: number | null;
  readonly logger: Logger;
  /** @internal */ _pages: Map<string, Page> = new Map();
  /** @internal aborts on close: background sleeps end early */
  _signal: AbortSignal;
  readonly #createWebSocket: CreateWebSocket | undefined;
  readonly #onClose: (() => Promise<void> | void) | undefined;
  #client: CDPClient | undefined;
  #abort: AbortController = new AbortController();
  readonly #pending: Set<Promise<void>> = new Set();
  #closing: Promise<void> | undefined;
  #retired = false;
  #useCount = 0;

  constructor(session: Session, options: BrowserOptions = {}) {
    super(undefined, "", "");
    this.session = session;
    this.blockedResources = normalizeBlocked(options.blockResources);
    this.blockedUrls = normalizeUrls(options.blockUrls);
    this.connectTimeout = options.connectTimeout ?? 30_000;
    this.commandTimeout =
      options.commandTimeout === undefined ? 60_000 : options.commandTimeout;
    this.logger = makeLogger(options.logger);
    this.#createWebSocket = options.createWebSocket;
    this.#onClose = options.onClose;
    this._signal = this.#abort.signal;
  }

  get internalUuid(): string {
    return this.session.internal_uuid;
  }

  override get cdp(): CDPClient {
    if (this.#client === undefined) {
      throw new Error("browser is not connected; call connect() first");
    }
    return this.#client;
  }

  get connected(): boolean {
    return this.#client?.connected ?? false;
  }

  get shouldRecycle(): boolean {
    return this.#retired || !this.connected;
  }

  /**
   * Leases so far, the current one included. Rotate the browser from your own loop:
   *
   *     if (browser.useCount >= 20) browser.retire();
   */
  get useCount(): number {
    return this.#useCount;
  }

  /** @internal */
  _lease(): void {
    this.#useCount += 1;
  }

  get pages(): Page[] {
    return [...this._pages.values()];
  }

  /** @internal what a page's Fetch.enable intercepts */
  get _fetchPatterns(): Record<string, unknown>[] {
    const patterns: Record<string, unknown>[] = [...this.blockedResources]
      .sort()
      .map((name) => ({ urlPattern: "*", resourceType: RESOURCE_TYPES[name] }));
    for (const pattern of this.blockedUrls) patterns.push({ urlPattern: pattern });
    return [...patterns, STATUS_PATTERN];
  }

  /** Replace this browser with a fresh one after the lease. */
  retire(): void {
    this.#retired = true;
  }

  async newPage(): Promise<Page> {
    const deadline = new Deadline(this.commandTimeout, "the new page did not open");
    const created = await deadline.race(
      this.cdp.send("Target.createTarget", {
        url: "about:blank",
        newWindow: true,
      }),
    );
    return this._pageReady(created.targetId, deadline);
  }

  /**
   * Run `action`, the click that opens a window, and return the page it opened:
   *
   *     const popup = await browser.waitForPage(browser.click("a[target=_blank]"));
   *
   * A site can open the window after an async step, so `pages` right after the
   * click may not have it yet.
   */
  async waitForPage(
    action: Promise<unknown> | (() => Promise<unknown>),
    options: WaitOptions = {},
  ): Promise<Page> {
    const before = new Set(this._pages.keys());
    const deadline = new Deadline(options.timeout ?? 30_000, "no page opened");
    await deadline.race(typeof action === "function" ? action() : action);
    while (true) {
      const opened = [...this._pages.entries()]
        .filter(([sessionId]) => !before.has(sessionId))
        .map(([, page]) => page);
      const last = opened[opened.length - 1];
      if (last !== undefined) return last;
      this._requireOpen();
      deadline.check();
      await sleep(POLL_INTERVAL);
    }
  }

  async connect(): Promise<void> {
    if (this.#client !== undefined) throw new Error("browser is already connected");
    const handler = this.onDialog; // survives a reconnect
    this._reset("", "");
    this.onDialog = handler;
    this._pages = new Map();
    this.#abort = new AbortController();
    this._signal = this.#abort.signal;
    this.#closing = undefined;
    const deadline = new Deadline(this.connectTimeout, "could not connect");
    try {
      const client = new CDPClient(this.session.ws_url, {
        createWebSocket: this.#createWebSocket,
        onClose: () => this._onDisconnect(),
        logger: this.logger,
      });
      this.#client = client;
      await deadline.race(client.start());
      client.on("Target.attachedToTarget", (event) => this._onAttached(event));
      client.on("Target.detachedFromTarget", (event) => this._onDetached(event));
      client.on(
        "Inspector.targetCrashed",
        this.#toPage((page) => this._drop(page)),
      );
      client.on(
        "Page.lifecycleEvent",
        this.#toPage((page, event) => page._onLifecycle(event)),
      );
      client.on(
        "Fetch.requestPaused",
        this.#toPage((page, event) => page._onRequestPaused(event)),
      );
      client.on(
        "Network.responseReceived",
        this.#toPage((page, event) => page._onResponse(event)),
      );
      client.on(
        "Network.loadingFinished",
        this.#toPage((page, event) => page._onBodyReady(event)),
      );
      client.on(
        "Page.javascriptDialogOpening",
        this.#toPage((page, event) => page._onDialog(event)),
      );
      await deadline.race(client.send("Target.setAutoAttach", AUTO_ATTACH));
      await deadline.race(client.send("Target.getTargets"));
      if (!this._sessionId) {
        const created = await deadline.race(
          client.send("Target.createTarget", { url: "about:blank" }),
        );
        await this._pageReady(created.targetId, deadline);
      }
      await deadline.race(this._waitReady());
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  override close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    this.#abort.abort();
    const pending = [...this.#pending];
    this.#pending.clear();
    const client = this.#client;
    this.#client = undefined;
    await withTimeout(
      Promise.allSettled(pending),
      5_000,
      () => new BrowserTimeoutError("close timed out"),
    ).catch((err) => this.logger.debug(`close: ${String(err)}`));
    if (client !== undefined) await client.stop();
    this._closed = true;
    await this.#onClose?.();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  /** @internal a lease ends: other pages closed, captures dropped, dialogs reset; `data` stays */
  async _endLease(): Promise<void> {
    for (const page of this.pages) {
      if (page !== this) await page.close();
    }
    await this.stopCapturing();
    this.onDialog = null;
    const timeout = this.commandTimeout;
    await withTimeout(
      this.cdp.send("Browser.getVersion"),
      timeout,
      () => new BrowserTimeoutError(`the browser did not answer within ${timeout}ms`),
    );
  }

  /** @internal */
  async _pageReady(targetId: string, deadline: Deadline): Promise<Page> {
    let page = this.#pageFor(targetId);
    while (page === undefined) {
      this._requireOpen();
      deadline.check();
      await sleep(POLL_INTERVAL);
      page = this.#pageFor(targetId);
    }
    await deadline.race(page._waitReady());
    return page;
  }

  #pageFor(targetId: string): Page | undefined {
    for (const page of this._pages.values()) {
      if (page._targetId === targetId) return page;
    }
    return undefined;
  }

  /** @internal */
  _onAttached(event: Record<string, any>): void {
    const info: Record<string, any> = event.targetInfo ?? {};
    const sessionId: string = event.sessionId;
    const waiting = Boolean(event.waitingForDebugger);
    const url: string = info.url ?? "";
    const adoptable = isStartPage(url) && !this._sessionId;
    if (
      info.type !== "page" ||
      (NON_WEB_SCHEMES.some((scheme) => url.startsWith(scheme)) && !adoptable)
    ) {
      this._spawn(this.#letGo(sessionId, waiting));
      return;
    }
    let page: Page;
    if (this._sessionId) {
      page = new Page(this, info.targetId, sessionId);
    } else {
      // the 1 web page is the browser itself
      page = this;
      this._targetId = info.targetId;
      this._sessionId = sessionId;
    }
    page._frameId = page._targetId; // the page target's main frame
    page._ready = new Flag(); // commands on it wait for the setup
    this._pages.set(sessionId, page);
    this._spawn(page._setup(waiting));
  }

  async #letGo(sessionId: string, waiting: boolean): Promise<void> {
    const timeout = this.commandTimeout;
    const detach = async () => {
      if (waiting)
        await this.cdp.send("Runtime.runIfWaitingForDebugger", undefined, sessionId);
      await this.cdp.send("Target.detachFromTarget", { sessionId });
    };
    await withTimeout(
      detach(),
      timeout,
      () => new BrowserTimeoutError(`the target did not let go within ${timeout}ms`),
    );
  }

  /** @internal */
  _onDetached(event: Record<string, any>): void {
    const page = this._pages.get(String(event.sessionId ?? ""));
    if (page !== undefined) this._drop(page);
  }

  /** @internal */
  _drop(page: Page): void {
    this._pages.delete(page._sessionId);
    page._closed = true;
    page._waiter?.fail("page closed");
    if (page === this) {
      this.logger.warn(`page target gone for ${this.internalUuid}`);
      this.retire();
    }
  }

  #toPage(handler: (page: Page, event: Record<string, any>) => void): EventHandler {
    return (event, sessionId) => {
      const page = this._pages.get(sessionId ?? "");
      if (page !== undefined) handler(page, event);
    };
  }

  /** @internal */
  _onDisconnect(): void {
    for (const page of this._pages.values()) {
      page._closed = true;
      page._waiter?.fail("CDP connection closed");
    }
  }

  /** @internal track a background task; its failure is logged at debug level */
  override _spawn(task: Promise<unknown>): void {
    const tracked: Promise<void> = task.then(
      () => undefined,
      (err) => this.logger.debug(`background task failed: ${String(err)}`),
    );
    this.#pending.add(tracked);
    tracked.then(() => this.#pending.delete(tracked));
  }
}
