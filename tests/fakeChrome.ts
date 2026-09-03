import type { BrowserOptions } from "../src/browser/browser.js";
import { Browser } from "../src/browser/browser.js";
import { FakeCDPServer } from "./helpers.js";

export interface TargetState {
  url: string;
  title: string;
  sessionId: string;
}

export const LIFECYCLE: string[] = [
  "init",
  "commit",
  "DOMContentLoaded",
  "load",
  "networkIdle",
];

/** A scripted Chrome: auto-attach, targets, navigation lifecycle, dialogs, Fetch pauses. */
export class FakeChrome extends FakeCDPServer {
  readonly targets: Map<string, TargetState> = new Map();
  readonly sessions: Map<string, string> = new Map();
  /** Page.navigate fires init..networkIdle for its loader on a microtask. */
  autoNavigate = true;
  /** Attach one page on setAutoAttach, as a live session has. */
  initialPages = 1;
  /** What the session's startup tab is showing. */
  startUrl = "about:blank";
  #targetCounter = 0;
  #loaderCounter = 0;

  constructor() {
    super();
    this.respond("Target.setAutoAttach", () => {
      for (let i = 0; i < this.initialPages; i++) {
        this.attachPage(this.newTargetId(), { waiting: false, url: this.startUrl });
      }
      return {};
    });
    this.respond("Target.getTargets", () => ({ targetInfos: [] }));
    this.respond("Target.createTarget", (params) => {
      const targetId = this.newTargetId();
      this.attachPage(targetId, { waiting: true, url: params.url ?? "about:blank" });
      return { targetId };
    });
    this.respond("Target.closeTarget", (params) => {
      const target = this.targets.get(params.targetId);
      if (target) queueMicrotask(() => this.detach(target.sessionId));
      return { success: true };
    });
    this.respond("Target.getTargetInfo", (params) => {
      const target = this.targets.get(params.targetId);
      return {
        targetInfo: {
          targetId: params.targetId,
          type: "page",
          url: target?.url ?? "",
          title: target?.title ?? "",
        },
      };
    });
    this.respond("Browser.getVersion", () => ({ product: "Chrome/1" }));
    this.respond("Page.navigate", (params, sessionId) => {
      const targetId = this.sessions.get(sessionId ?? "") ?? "";
      const target = this.targets.get(targetId);
      if (target) target.url = params.url;
      const loaderId = this.newLoaderId();
      if (this.autoNavigate && sessionId) {
        queueMicrotask(() => this.lifecycle(sessionId, loaderId, LIFECYCLE));
      }
      return { frameId: targetId, loaderId };
    });
    this.respond("Page.reload", (_params, sessionId) => {
      const loaderId = this.newLoaderId();
      if (this.autoNavigate && sessionId) {
        queueMicrotask(() => this.lifecycle(sessionId, loaderId, LIFECYCLE));
      }
      return {};
    });
    this.respond("Page.createIsolatedWorld", () => ({ executionContextId: 7 }));
    this.respond("DOM.getDocument", () => ({ root: { nodeId: 1 } }));
  }

  newTargetId(): string {
    this.#targetCounter += 1;
    return `T${this.#targetCounter}`;
  }

  newLoaderId(): string {
    this.#loaderCounter += 1;
    return `L${this.#loaderCounter}`;
  }

  attachPage(
    targetId: string,
    options: { waiting?: boolean; url?: string; type?: string; title?: string } = {},
  ): string {
    const sessionId = `S-${targetId}`;
    const url = options.url ?? "about:blank";
    this.targets.set(targetId, { url, title: options.title ?? "", sessionId });
    this.sessions.set(sessionId, targetId);
    this.event("Target.attachedToTarget", {
      sessionId,
      targetInfo: {
        targetId,
        type: options.type ?? "page",
        url,
        title: options.title ?? "",
      },
      waitingForDebugger: options.waiting ?? true,
    });
    return sessionId;
  }

  detach(sessionId: string): void {
    const targetId = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (targetId !== undefined) this.targets.delete(targetId);
    this.event("Target.detachedFromTarget", { sessionId, targetId });
  }

  lifecycle(
    sessionId: string,
    loaderId: string,
    names: string[],
    frameId?: string,
  ): void {
    const frame = frameId ?? this.sessions.get(sessionId) ?? "";
    for (const name of names) {
      this.event(
        "Page.lifecycleEvent",
        { frameId: frame, loaderId, name, timestamp: 1 },
        sessionId,
      );
    }
  }

  pauseDocument(
    sessionId: string,
    requestId: string,
    status: number,
    frameId?: string,
  ): void {
    this.event(
      "Fetch.requestPaused",
      {
        requestId,
        request: { url: "https://x.test/" },
        frameId: frameId ?? this.sessions.get(sessionId),
        resourceType: "Document",
        responseStatusCode: status,
      },
      sessionId,
    );
  }

  dialog(sessionId: string, type: string, message = ""): void {
    this.event("Page.javascriptDialogOpening", { type, message, url: "" }, sessionId);
  }

  /** Commands seen on one page session. */
  onSession(sessionId: string, method?: string): string[] {
    return this.calls
      .filter(
        (call) => call.sessionId === sessionId && (!method || call.method === method),
      )
      .map((call) => call.method);
  }
}

export interface FakeBrowser {
  browser: Browser;
  chrome: FakeChrome;
  sessionId: string;
}

export async function fakeBrowser(
  options: BrowserOptions & { chrome?: FakeChrome } = {},
): Promise<FakeBrowser> {
  const { chrome = new FakeChrome(), ...rest } = options;
  const browser = new Browser(
    { internal_uuid: "sess-1", ws_url: "ws://fake" },
    { createWebSocket: chrome.create, logger: null, ...rest },
  );
  await browser.connect();
  return { browser, chrome, sessionId: browser._sessionId };
}
