import { BrowserTimeoutError, CDPError, PageClosedError } from "../errors.js";
import type { Cookie, WaitUntil } from "../types.js";
import { isRecord } from "../types.js";
import { dropNulls, Flag, fromBase64, sleep, withTimeout } from "../util.js";
import { Actions } from "./actions.js";
import type { Browser } from "./browser.js";
import type { CDPClient } from "./cdp.js";

export const POLL_INTERVAL = 100;

export const LIFECYCLE_EVENT: Record<WaitUntil, string> = {
  commit: "commit",
  domcontentloaded: "DOMContentLoaded",
  load: "load",
  networkidle: "networkIdle",
};

export const WORLD_NAME = "utility";

/** A dialog is answered after this long, as a person would. */
export const DIALOG_DELAY: readonly [number, number] = [600, 1400];

const FUNCTION = /^\s*(async\s+)?(function\b|\([^()]*\)\s*=>|[\w$]+\s*=>)/;

const SELECT = `(selector, value, label) => {
  const el = document.querySelector(selector);
  if (!el) return null;
  const option = Array.from(el.options).find(
    o => label === null ? o.value === value : o.label === label || o.text === label
  );
  if (!option) return false;
  el.value = option.value;
  el.dispatchEvent(new Event("input", {bubbles: true}));
  el.dispatchEvent(new Event("change", {bubbles: true}));
  return option.value;
}`;

export type DialogHandler = (
  kind: string,
  message: string,
) => boolean | string | null | undefined;

export interface GotoOptions {
  waitUntil?: WaitUntil;
  /** ms */
  timeout?: number;
}

export interface WaitOptions {
  /** ms */
  timeout?: number;
}

export interface EvaluateOptions {
  args?: unknown[];
  /** The isolated world the page cannot see (default), or the page's own context. */
  isolated?: boolean;
  awaitPromise?: boolean;
}

export interface ScreenshotOptions {
  selector?: string;
  fullPage?: boolean;
  format?: "png" | "jpeg" | "webp";
  quality?: number;
}

export function cookieParam(
  cookie: Cookie | Record<string, unknown>,
): Record<string, unknown> {
  const out = dropNulls(cookie) as Record<string, unknown>;
  const expires = out.expirationDate;
  return expires === undefined ? out : { expires, ...out };
}

function fromCdpCookie(raw: Record<string, unknown>): Cookie {
  const { expires, ...rest } = raw;
  return (expires === undefined ? rest : { expirationDate: expires, ...rest }) as Cookie;
}

function commandFailed(
  method: string,
  params: Record<string, unknown> | undefined,
  err: CDPError,
): CDPError {
  const selector = params?.selector;
  const where = typeof selector === "string" ? `${method} '${selector}'` : method;
  if (err.message.includes("Could not find node with given id")) {
    return new CDPError(`${where}: the page navigated while the command ran.`, {
      code: err.code,
      cause: err,
    });
  }
  return new CDPError(`${where}: ${err.message}`, {
    code: err.code,
    cause: err,
  });
}

/** A wait's time budget: poll loops `check()` it, single awaits `race()` against it. `null` is no limit. */
export class Deadline {
  readonly timeout: number | null;
  readonly message: string;
  readonly until: number;

  constructor(timeout: number | null | undefined, message: string) {
    this.timeout = timeout ?? null;
    this.message = message;
    this.until =
      this.timeout === null ? Number.POSITIVE_INFINITY : Date.now() + this.timeout;
  }

  error(): BrowserTimeoutError {
    return new BrowserTimeoutError(`${this.message} within ${this.timeout}ms`);
  }

  check(): void {
    if (Date.now() >= this.until) throw this.error();
  }

  race<T>(promise: Promise<T>): Promise<T> {
    if (this.timeout === null) return promise;
    return withTimeout(promise, Math.max(0, this.until - Date.now()), () => this.error());
  }
}

export class CapturedResponse {
  readonly url: string;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array;

  constructor(
    url: string,
    status: number,
    headers: Record<string, string>,
    body: Uint8Array,
  ) {
    this.url = url;
    this.status = status;
    this.headers = headers;
    this.body = body;
  }

  get text(): string {
    return new TextDecoder().decode(this.body);
  }

  json(): any {
    return JSON.parse(this.text);
  }
}

/** The lifecycle wait of one `goto`. */
export class NavWaiter {
  readonly milestone: string;
  readonly done: Flag = new Flag();
  error: string | undefined;
  loaderId: string | undefined;
  readonly created: string[] = [];
  readonly reached: Set<string> = new Set();

  constructor(milestone: string) {
    this.milestone = milestone;
  }

  follow(loaderId: string): boolean {
    let id = loaderId;
    if (this.created.includes(id)) {
      id = this.created[this.created.length - 1] as string; // already replaced by a newer document
    }
    this.loaderId = id;
    return this.reached.has(id);
  }

  followNewest(): boolean {
    const newest = this.created[this.created.length - 1];
    if (newest !== undefined) return this.follow(newest);
    this.loaderId = ""; // any init from here on is ours
    return false;
  }

  observe(name: unknown, loaderId: unknown): void {
    if (this.done.isSet || typeof loaderId !== "string" || !loaderId) return;
    if (name === "init") {
      if (this.loaderId === undefined) this.created.push(loaderId);
      else if (loaderId !== this.loaderId) this.loaderId = loaderId; // a newer document replaced ours
    } else if (name === this.milestone) {
      if (this.loaderId === undefined) this.reached.add(loaderId);
      else if (loaderId === this.loaderId) this.done.set();
    }
  }

  fail(reason: string): void {
    this.error = reason;
    this.done.set();
  }
}

/** One page target. `Browser` is the session's first page plus the connection. */
export class Page extends Actions {
  /** @internal */ _browser!: Browser;
  /** @internal */ _targetId!: string;
  /** @internal */ _sessionId!: string;
  /** @internal */ _frameId!: string;
  /** @internal */ _closed!: boolean;
  /** Answers this page's dialogs; the browser's handler when unset. */
  onDialog: DialogHandler | null = null;
  /** @internal the main frame's newest document */
  _loaderId: string | undefined;
  /** @internal the lifecycle events it reached */
  _milestones!: Set<string>;
  /** @internal the isolated world's context */
  _worldId: number | undefined;
  /** @internal commands wait for the setup */
  _ready!: Flag;
  /** @internal */ _setupError: unknown;
  /** @internal */ _waiter: NavWaiter | undefined;
  /** @internal */ _status: number | undefined;
  /** @internal */ _storageReady!: boolean;
  /** @internal */ _captures!: string[];
  /** @internal */ _responses!: CapturedResponse[];
  /** @internal */ _inFlight!: Map<string, Record<string, unknown>>;

  constructor(browser: Browser | undefined, targetId: string, sessionId: string) {
    super();
    this._browser = browser ?? (this as unknown as Browser);
    this._reset(targetId, sessionId);
  }

  /** @internal fresh page state; the browser reuses it on connect */
  _reset(targetId: string, sessionId: string): void {
    this._targetId = targetId;
    this._sessionId = sessionId;
    this._frameId = "";
    this._closed = false;
    this._loaderId = undefined;
    this._milestones = new Set();
    this._worldId = undefined;
    this._ready = new Flag();
    this._ready.set();
    this._setupError = undefined;
    this._waiter = undefined;
    this._status = undefined;
    this._storageReady = false;
    this._captures = [];
    this._responses = [];
    this._inFlight = new Map();
  }

  get cdp(): CDPClient {
    return this._browser.cdp;
  }

  get targetId(): string {
    return this._targetId;
  }

  get closed(): boolean {
    return this._closed;
  }

  get status(): number | undefined {
    return this._status;
  }

  override async send(method: string, params?: Record<string, unknown>): Promise<any> {
    this._requireOpen();
    await this._waitReady();
    return this._send(method, params);
  }

  /** @internal */
  _requireOpen(): void {
    if (this._closed) throw new PageClosedError("page is closed");
  }

  /** @internal */
  async _send(method: string, params?: Record<string, unknown>): Promise<any> {
    const timeout = this._browser.commandTimeout;
    try {
      return await withTimeout(
        this.cdp.send(method, params, this._sessionId),
        timeout,
        () => new BrowserTimeoutError(`${method} did not answer within ${timeout}ms`),
      );
    } catch (err) {
      if (err instanceof CDPError) throw commandFailed(method, params, err);
      throw err;
    }
  }

  /** @internal */
  async _waitReady(): Promise<void> {
    await this._ready.wait();
    if (this._setupError !== undefined) throw this._setupError;
  }

  /** @internal */
  async _setup(waiting: boolean): Promise<void> {
    const commands: [string, Record<string, unknown> | undefined][] = [
      ["Page.enable", undefined],
      ["Page.setLifecycleEventsEnabled", { enabled: true }],
      ["Fetch.enable", { patterns: this._browser._fetchPatterns }],
    ];
    if (waiting) commands.push(["Runtime.runIfWaitingForDebugger", undefined]);
    const timeout = this._browser.commandTimeout;
    let posted: { id: number; reply: Promise<any> }[] = [];
    try {
      posted = commands.map(([method, params]) =>
        this.cdp.post(method, params, this._sessionId),
      );
      const replies = posted.map(async ({ reply }, i) => {
        const [method, params] = commands[i] as [
          string,
          Record<string, unknown> | undefined,
        ];
        try {
          await reply;
        } catch (err) {
          if (err instanceof CDPError) throw commandFailed(method, params, err);
          throw err;
        }
      });
      await withTimeout(
        Promise.all(replies),
        timeout,
        () => new BrowserTimeoutError(`the page was not ready within ${timeout}ms`),
      );
    } catch (err) {
      this._setupError = err;
    } finally {
      // a reply we timed out on is never settled: nothing else would drop it
      for (const { id } of posted) this.cdp.forget(id);
      this._ready.set();
    }
  }

  async close(): Promise<void> {
    if (this._closed) return;
    const timeout = this._browser.commandTimeout;
    await withTimeout(
      this.cdp.send("Target.closeTarget", { targetId: this._targetId }),
      timeout,
      () => new BrowserTimeoutError(`the page did not close within ${timeout}ms`),
    );
    this._browser._drop(this);
  }

  async bringToFront(): Promise<void> {
    await this.send("Page.bringToFront");
  }

  async waitForLoadState(
    state: WaitUntil = "load",
    options: WaitOptions = {},
  ): Promise<void> {
    const milestone = LIFECYCLE_EVENT[state];
    const deadline = new Deadline(
      options.timeout ?? 30_000,
      `the page did not reach '${state}'`,
    );
    while (!this._milestones.has(milestone)) {
      this._requireOpen();
      deadline.check();
      await sleep(POLL_INTERVAL);
    }
  }

  async goto(url: string, options: GotoOptions = {}): Promise<void> {
    const waitUntil = options.waitUntil ?? "load";
    if (this._waiter !== undefined) throw new Error("navigation already in progress");
    const waiter = new NavWaiter(LIFECYCLE_EVENT[waitUntil]);
    this._waiter = waiter;
    this._status = undefined;
    const deadline = new Deadline(
      options.timeout ?? 30_000,
      `navigation to ${url} did not reach '${waitUntil}'`,
    );
    try {
      const result = await deadline.race(this.send("Page.navigate", { url }));
      if (result.errorText)
        throw new CDPError(`navigation to ${url} failed: ${result.errorText}`);
      const loaderId = result.loaderId;
      if (waitUntil === "commit" || typeof loaderId !== "string") return;
      if (!waiter.follow(loaderId)) await deadline.race(waiter.done.wait());
      if (waiter.error !== undefined) throw new CDPError(waiter.error);
    } finally {
      if (this._waiter === waiter) this._waiter = undefined;
    }
  }

  async reload(options: GotoOptions = {}): Promise<void> {
    const waitUntil = options.waitUntil ?? "load";
    if (this._waiter !== undefined) throw new Error("navigation already in progress");
    const waiter = new NavWaiter(LIFECYCLE_EVENT[waitUntil]);
    this._waiter = waiter;
    this._status = undefined;
    const deadline = new Deadline(
      options.timeout ?? 30_000,
      `reload did not reach '${waitUntil}'`,
    );
    try {
      await deadline.race(this.send("Page.reload"));
      if (!waiter.followNewest()) await deadline.race(waiter.done.wait());
      if (waiter.error !== undefined) throw new CDPError(waiter.error);
    } finally {
      if (this._waiter === waiter) this._waiter = undefined;
    }
  }

  goBack(options: WaitOptions = {}): Promise<string | null> {
    return this.#historyStep(-1, options.timeout ?? 30_000);
  }

  goForward(options: WaitOptions = {}): Promise<string | null> {
    return this.#historyStep(1, options.timeout ?? 30_000);
  }

  async #historyStep(delta: number, timeout: number): Promise<string | null> {
    const history = await this.send("Page.getNavigationHistory");
    const entries = history.entries as { id: number }[];
    const index = history.currentIndex + delta;
    const entry = entries[index];
    if (index < 0 || entry === undefined) return null;
    await this.send("Page.navigateToHistoryEntry", { entryId: entry.id });
    const deadline = new Deadline(timeout, "history did not move");
    while (true) {
      const moved = await deadline.race(this.send("Page.getNavigationHistory"));
      if (moved.currentIndex === index) break;
      deadline.check();
      await sleep(POLL_INTERVAL);
    }
    return this.url();
  }

  get responses(): CapturedResponse[] {
    return [...this._responses];
  }

  /** Record responses whose URL contains a fragment. Call before navigating. */
  async captureResponses(...fragments: string[]): Promise<void> {
    if (fragments.length === 0)
      throw new TypeError("captureResponses needs at least one URL fragment");
    if (this._captures.length === 0) await this.send("Network.enable");
    this._captures.push(...fragments);
  }

  async stopCapturing(): Promise<void> {
    if (this._captures.length === 0) return;
    this._captures = [];
    this._responses = [];
    this._inFlight.clear();
    await this.send("Network.disable");
  }

  async waitForResponse(
    fragment: string,
    options: WaitOptions = {},
  ): Promise<CapturedResponse> {
    if (this._captures.length === 0) {
      throw new Error("call captureResponses() before the navigation");
    }
    const deadline = new Deadline(
      options.timeout ?? 30_000,
      `no response matching '${fragment}'`,
    );
    while (true) {
      const found = this._responses.find((response) => response.url.includes(fragment));
      if (found !== undefined) return found;
      this._requireOpen();
      deadline.check();
      await sleep(POLL_INTERVAL);
    }
  }

  /** @internal */
  _onResponse(event: Record<string, any>): void {
    const response: Record<string, unknown> = isRecord(event.response)
      ? event.response
      : {};
    const url = typeof response.url === "string" ? response.url : "";
    if (this._captures.some((fragment) => url.includes(fragment))) {
      this._inFlight.set(String(event.requestId), response);
    }
  }

  /** @internal */
  _onBodyReady(event: Record<string, any>): void {
    const requestId = String(event.requestId ?? "");
    const response = this._inFlight.get(requestId);
    if (response === undefined) return;
    this._inFlight.delete(requestId);
    this._spawn(this.#collect(requestId, response, this._responses));
  }

  async #collect(
    requestId: string,
    response: Record<string, unknown>,
    into: CapturedResponse[],
  ): Promise<void> {
    let body: Uint8Array = new Uint8Array(0);
    try {
      const result = await this.send("Network.getResponseBody", { requestId });
      const raw = typeof result.body === "string" ? result.body : "";
      body = result.base64Encoded ? fromBase64(raw) : new TextEncoder().encode(raw);
    } catch (err) {
      this._browser.logger.debug(`no body for ${String(response.url)}: ${String(err)}`);
    }
    into.push(
      new CapturedResponse(
        typeof response.url === "string" ? response.url : "",
        typeof response.status === "number" ? response.status : 0,
        isRecord(response.headers) ? (response.headers as Record<string, string>) : {},
        body,
      ),
    );
  }

  localStorage(): Promise<Record<string, string>> {
    return this.#storage(true);
  }

  setLocalStorage(values: Record<string, string>): Promise<void> {
    return this.#setStorage(values, true);
  }

  sessionStorage(): Promise<Record<string, string>> {
    return this.#storage(false);
  }

  setSessionStorage(values: Record<string, string>): Promise<void> {
    return this.#setStorage(values, false);
  }

  async clearCookies(): Promise<void> {
    await this.send("Network.clearBrowserCookies");
  }

  async #storage(local: boolean): Promise<Record<string, string>> {
    const items = await this.send("DOMStorage.getDOMStorageItems", {
      storageId: await this.#storageId(local),
    });
    return Object.fromEntries((items.entries as [string, string][] | undefined) ?? []);
  }

  async #setStorage(values: Record<string, string>, local: boolean): Promise<void> {
    const storageId = await this.#storageId(local);
    for (const [key, value] of Object.entries(values)) {
      await this.send("DOMStorage.setDOMStorageItem", {
        storageId,
        key,
        value,
      });
    }
  }

  async #storageId(local: boolean): Promise<Record<string, unknown>> {
    if (!this._storageReady) {
      await this.send("DOMStorage.enable");
      this._storageReady = true;
    }
    const tree = await this.send("Page.getFrameTree");
    const frame = tree.frameTree.frame;
    const storageId: Record<string, unknown> = { isLocalStorage: local };
    if (frame.storageKey) storageId.storageKey = frame.storageKey;
    else storageId.securityOrigin = frame.securityOrigin;
    return storageId;
  }

  /**
   * Run script in the page. A function (or a string that looks like one) is called
   * with `args` as JSON; anything else is an expression. It runs in an isolated world:
   * the page's DOM, but not its globals, so the page's own script cannot see the call
   * or hook it. Page variables (`window.__data`) need `isolated: false`, the main
   * world, where a site that hooks the natives can notice.
   */
  async evaluate(
    expression: string | ((...args: any[]) => unknown),
    options: EvaluateOptions = {},
  ): Promise<any> {
    const isolated = options.isolated ?? true;
    const awaitPromise = options.awaitPromise ?? true;
    let expr = typeof expression === "function" ? expression.toString() : expression;
    if (options.args !== undefined && options.args.length > 0) {
      expr = `(${expr})(...${JSON.stringify(options.args)})`;
    } else if (FUNCTION.test(expr)) {
      expr = `(${expr})()`;
    }
    let remote = await this.#evaluate(expr, isolated, awaitPromise);
    if (remote.type === "function" && expr.includes("=>")) {
      remote = await this.#evaluate(`(${expr})()`, isolated, awaitPromise);
    }
    return remote.value;
  }

  async #evaluate(
    expression: string,
    isolated: boolean,
    awaitPromise: boolean,
  ): Promise<Record<string, any>> {
    const params: Record<string, unknown> = {
      expression,
      returnByValue: true,
      awaitPromise,
    };
    if (isolated) params.contextId = await this.#world();
    let result: Record<string, any>;
    try {
      result = await this.send("Runtime.evaluate", params);
    } catch (err) {
      if (
        !isolated ||
        !(err instanceof CDPError) ||
        !err.message.includes("Cannot find context")
      ) {
        throw err;
      }
      // the document changed under us before its event came: once more
      this._worldId = undefined;
      params.contextId = await this.#world();
      result = await this.send("Runtime.evaluate", params);
    }
    const details = result.exceptionDetails;
    if (details) {
      const exception = details.exception ?? {};
      throw new CDPError(`evaluate failed: ${exception.description ?? details.text}`);
    }
    return result.result;
  }

  async #world(): Promise<number> {
    if (this._worldId === undefined) {
      const created = await this.send("Page.createIsolatedWorld", {
        frameId: this._frameId,
        worldName: WORLD_NAME,
      });
      this._worldId = created.executionContextId as number;
    }
    return this._worldId;
  }

  /** Poll until the expression is truthy. Returns the value. */
  async waitForFunction(
    expression: string | ((...args: any[]) => unknown),
    options: EvaluateOptions & WaitOptions = {},
  ): Promise<any> {
    const { timeout = 30_000, ...rest } = options;
    const label = typeof expression === "function" ? "the function" : `'${expression}'`;
    const deadline = new Deadline(timeout, `${label} was not truthy`);
    while (true) {
      const value = await deadline.race(this.evaluate(expression, rest));
      if (value) return value;
      deadline.check();
      await sleep(POLL_INTERVAL);
    }
  }

  innerText(selector: string): Promise<string | null> {
    return this.evaluate("s => document.querySelector(s)?.innerText ?? null", {
      args: [selector],
    });
  }

  allInnerTexts(selector: string): Promise<string[]> {
    return this.evaluate(
      "s => Array.from(document.querySelectorAll(s), e => e.innerText)",
      {
        args: [selector],
      },
    );
  }

  async getAttribute(selector: string, name: string): Promise<string | null> {
    const nodeId = await this.#nodeId(selector);
    if (nodeId === undefined) return null;
    const found = await this.send("DOM.getAttributes", { nodeId });
    const pairs = (found.attributes as string[] | undefined) ?? [];
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      if (pairs[i] === name) return pairs[i + 1] as string;
    }
    return null;
  }

  async count(selector: string): Promise<number> {
    const document = await this.send("DOM.getDocument", { depth: 0 });
    const found = await this.send("DOM.querySelectorAll", {
      nodeId: document.root.nodeId,
      selector,
    });
    return ((found.nodeIds as unknown[] | undefined) ?? []).length;
  }

  async selectOption(
    selector: string,
    option: string | { value?: string; label?: string },
  ): Promise<string> {
    const { value, label } = typeof option === "string" ? { value: option } : option;
    if ((value === undefined) === (label === undefined)) {
      throw new TypeError("selectOption takes either a value or a label");
    }
    const picked = await this.evaluate(SELECT, {
      args: [selector, value ?? null, label ?? null],
    });
    if (picked === null) throw new Error(`nothing matches '${selector}'`);
    if (picked === false)
      throw new Error(`'${selector}' has no option '${label ?? value}'`);
    return picked as string;
  }

  async waitForSelector(
    selector: string,
    options: { visible?: boolean } & WaitOptions = {},
  ): Promise<void> {
    const visible = options.visible ?? true;
    const state = visible ? "visible" : "in the document";
    const deadline = new Deadline(
      options.timeout ?? 30_000,
      `'${selector}' was not ${state}`,
    );
    while (!(await deadline.race(this.#matches(selector, visible)))) {
      deadline.check();
      await sleep(POLL_INTERVAL);
    }
  }

  async #matches(selector: string, visible: boolean): Promise<boolean> {
    // Node ids belong to one document, so a navigation between the lookups
    // invalidates them. The poll is here for that, and for a node without a box yet.
    let box: Record<string, any>;
    try {
      const nodeId = await this.#nodeId(selector);
      if (nodeId === undefined) return false;
      if (!visible) return true;
      box = await this.send("DOM.getBoxModel", { nodeId });
    } catch (err) {
      if (err instanceof CDPError) return false;
      throw err;
    }
    const model = box.model ?? {};
    return Boolean(model.width) && Boolean(model.height);
  }

  async #nodeId(selector: string): Promise<number | undefined> {
    const document = await this.send("DOM.getDocument", { depth: 0 });
    const found = await this.send("DOM.querySelector", {
      nodeId: document.root.nodeId,
      selector,
    });
    return found.nodeId || undefined;
  }

  /** Wait until the URL contains the fragment. Returns the URL. */
  async waitForUrl(fragment: string, options: WaitOptions = {}): Promise<string> {
    const deadline = new Deadline(
      options.timeout ?? 30_000,
      `the page did not reach '${fragment}'`,
    );
    while (true) {
      const url = await deadline.race(this.url());
      if (url.includes(fragment)) return url;
      deadline.check();
      await sleep(POLL_INTERVAL);
    }
  }

  /** The first match has a bounding box. */
  isVisible(selector: string): Promise<boolean> {
    return this.#matches(selector, true);
  }

  async outerHtml(selector: string): Promise<string | null> {
    const nodeId = await this.#nodeId(selector);
    if (nodeId === undefined) return null;
    const html = await this.send("DOM.getOuterHTML", { nodeId });
    return html.outerHTML;
  }

  async setCookies(cookies: (Cookie | Record<string, unknown>)[]): Promise<void> {
    await this.send("Network.setCookies", {
      cookies: cookies.map(cookieParam),
    });
  }

  async content(): Promise<string> {
    const document = await this.send("DOM.getDocument", { depth: 0 });
    const html = await this.send("DOM.getOuterHTML", {
      nodeId: document.root.nodeId,
    });
    return html.outerHTML;
  }

  async title(): Promise<string> {
    const info = await this.send("Target.getTargetInfo", {
      targetId: this._targetId,
    });
    return info.targetInfo.title;
  }

  async url(): Promise<string> {
    const info = await this.send("Target.getTargetInfo", {
      targetId: this._targetId,
    });
    return info.targetInfo.url;
  }

  async cookies(): Promise<Cookie[]> {
    const result = await this.send("Network.getCookies");
    return ((result.cookies as Record<string, unknown>[] | undefined) ?? []).map(
      fromCdpCookie,
    );
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<Uint8Array> {
    const format = options.format ?? "png";
    const fullPage = options.fullPage ?? false;
    const params: Record<string, unknown> = {
      format,
      captureBeyondViewport: fullPage,
    };
    if (options.quality !== undefined && format !== "png")
      params.quality = options.quality;
    if (options.selector !== undefined) {
      params.clip = await this.#clip(options.selector);
    } else if (fullPage) {
      const metrics = await this.send("Page.getLayoutMetrics");
      const size = metrics.cssContentSize ?? metrics.contentSize;
      params.clip = { x: 0, y: 0, scale: 1, ...size };
    }
    const shot = await this.send("Page.captureScreenshot", params);
    return fromBase64(shot.data);
  }

  async #clip(selector: string): Promise<Record<string, number>> {
    const nodeId = await this.#nodeId(selector);
    if (nodeId === undefined) throw new Error(`nothing matches '${selector}'`);
    await this.send("DOM.scrollIntoViewIfNeeded", { nodeId });
    const box = await this.send("DOM.getBoxModel", { nodeId });
    const metrics = await this.send("Page.getLayoutMetrics");
    const viewport = metrics.cssVisualViewport ?? metrics.visualViewport ?? {};
    const quad = box.model.content as number[];
    return {
      x: (quad[0] as number) + (viewport.pageX ?? 0),
      y: (quad[1] as number) + (viewport.pageY ?? 0),
      width: (quad[2] as number) - (quad[0] as number),
      height: (quad[5] as number) - (quad[1] as number),
      scale: 1,
    };
  }

  /** @internal */
  _onLifecycle(event: Record<string, any>): void {
    if (event.frameId !== this._frameId) return;
    const name: string = event.name ?? "";
    const loaderId: string | undefined = event.loaderId;
    if (name === "init") {
      this._loaderId = loaderId;
      this._milestones = new Set();
      this._worldId = undefined; // worlds belong to a document
    } else if (loaderId === this._loaderId) {
      this._milestones.add(name);
    } else if (this._loaderId === undefined) {
      this._loaderId = loaderId;
      this._milestones = new Set([name]);
    }
    this._waiter?.observe(name, loaderId);
  }

  /** @internal */
  _onDialog(event: Record<string, any>): void {
    const kind: string = event.type ?? "";
    const message: string = event.message ?? "";
    const handler = this.onDialog ?? this._browser.onDialog;
    let verdict: boolean | string | null | undefined;
    try {
      verdict = handler ? handler(kind, message) : undefined;
    } catch (err) {
      this._browser.logger.error(
        `onDialog failed, falling back to the default: ${String(err)}`,
      );
      verdict = undefined;
    }
    if (verdict === undefined || verdict === null) {
      verdict = kind === "beforeunload"; // leave the page; dismiss the rest
    }
    const params: Record<string, unknown> = { accept: verdict !== false };
    if (typeof verdict === "string") params.promptText = verdict;
    this._browser.logger.info(
      `${kind} dialog '${message}' ${params.accept ? "accepted" : "dismissed"}`,
    );
    this._spawn(this.#answerDialog(params));
  }

  async #answerDialog(params: Record<string, unknown>): Promise<void> {
    const [min, max] = DIALOG_DELAY;
    await sleep(min + Math.random() * (max - min), this._browser._signal); // as a person would
    if (this._browser._signal.aborted) return;
    await this._send("Page.handleJavaScriptDialog", params);
  }

  /** @internal */
  _onRequestPaused(event: Record<string, any>): void {
    const requestId = event.requestId;
    if (requestId === undefined || requestId === null) {
      this._browser.logger.warn("Fetch.requestPaused without a requestId");
      return;
    }
    const status = event.responseStatusCode;
    if (status !== undefined && status !== null) {
      if (event.frameId === this._frameId) this._status = status;
      this._spawn(this._send("Fetch.continueResponse", { requestId }));
    } else if (event.responseErrorReason) {
      this._spawn(this._send("Fetch.continueRequest", { requestId }));
    } else {
      this._spawn(
        this._send("Fetch.failRequest", {
          requestId,
          errorReason: "BlockedByClient",
        }),
      );
    }
  }

  /** @internal */
  _spawn(task: Promise<unknown>): void {
    this._browser._spawn(task);
  }
}
