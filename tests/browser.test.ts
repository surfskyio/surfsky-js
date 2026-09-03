import { afterEach, describe, expect, test, vi } from "vitest";
import { Browser, normalizeBlocked, normalizeUrls } from "../src/browser/browser.js";
import { Page } from "../src/browser/page.js";
import { BrowserTimeoutError, CDPError } from "../src/errors.js";
import type { FakeBrowser } from "./fakeChrome.js";
import { FakeChrome, fakeBrowser } from "./fakeChrome.js";
import { FakeWebSocket, settle } from "./helpers.js";

let live: FakeBrowser | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await live?.browser.close();
  live = undefined;
});

async function start(
  options: Parameters<typeof fakeBrowser>[0] = {},
): Promise<FakeBrowser> {
  live = await fakeBrowser(options);
  return live;
}

describe("connect", () => {
  test("the first attached web page is the browser", async () => {
    const { browser, chrome } = await start();
    expect(browser.connected).toBe(true);
    expect(browser.pages).toEqual([browser]);
    expect(browser.targetId).toBe("T1");
    expect(browser._sessionId).toBe("S-T1");
    expect(browser._frameId).toBe("T1");
    expect(browser.internalUuid).toBe("sess-1");
    expect(chrome.calls[0]?.method).toBe("Target.setAutoAttach");
    expect(chrome.calls[0]?.params).toEqual({
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: "page" }],
    });
    expect(chrome.called("Target.createTarget")).toHaveLength(0);
    expect(browser.useCount).toBe(0);
    expect(browser.shouldRecycle).toBe(false);
  });

  test("creates a page when the session has none", async () => {
    const chrome = new FakeChrome();
    chrome.initialPages = 0;
    const { browser } = await start({ chrome });
    expect(chrome.called("Target.createTarget")[0]?.params).toEqual({
      url: "about:blank",
    });
    expect(browser.targetId).toBe("T1");
    // a paused target is resumed last, after Fetch is armed
    expect(chrome.onSession("S-T1")).toEqual([
      "Page.enable",
      "Page.setLifecycleEventsEnabled",
      "Fetch.enable",
      "Runtime.runIfWaitingForDebugger",
    ]);
  });

  test("non-web targets are resumed and let go", async () => {
    const { browser, chrome } = await start();
    chrome.attachPage("EXT", { url: "chrome-extension://abc/bg.html", waiting: true });
    chrome.attachPage("W", { type: "service_worker", waiting: false });
    await settle();
    expect(browser.pages).toHaveLength(1);
    expect(
      chrome.calls.filter((c) => c.sessionId === "S-EXT").map((c) => c.method),
    ).toEqual(["Runtime.runIfWaitingForDebugger"]);
    expect(
      chrome
        .called("Target.detachFromTarget")
        .map((c) => c.params.sessionId)
        .sort(),
    ).toEqual(["S-EXT", "S-W"]);
  });

  test("the startup tab is reused, not replaced", async () => {
    const chrome = new FakeChrome();
    chrome.startUrl = "chrome://newtab/"; // what a fresh cloud session opens on
    const { browser } = await start({ chrome });
    expect(chrome.called("Target.createTarget")).toHaveLength(0);
    expect(browser.pages).toEqual([browser]);
    expect(browser.targetId).toBe("T1");
  });

  test("only the first startup tab is adopted", async () => {
    const chrome = new FakeChrome();
    chrome.startUrl = "chrome://newtab/#gaia"; // a suffix the allowlist has to survive
    chrome.initialPages = 2;
    const { browser } = await start({ chrome });
    expect(browser.pages).toEqual([browser]);
    expect(browser.targetId).toBe("T1");
    expect(chrome.called("Target.createTarget")).toHaveLength(0);
    expect(chrome.called("Target.detachFromTarget")[0]?.params.sessionId).toBe("S-T2");
  });

  test("another chrome:// page is let go and a blank one opened", async () => {
    const chrome = new FakeChrome();
    chrome.startUrl = "chrome://settings/";
    const { browser } = await start({ chrome });
    expect(chrome.called("Target.createTarget")).toHaveLength(1);
    expect(chrome.called("Target.detachFromTarget")[0]?.params.sessionId).toBe("S-T1");
    expect(browser.targetId).toBe("T2");
  });

  test("a refused socket", async () => {
    const createWebSocket = (url: string) => {
      const ws = new FakeWebSocket(url);
      queueMicrotask(() => {
        ws.fail("refused");
        ws.serverClose();
      });
      return ws;
    };
    const browser = new Browser(
      { internal_uuid: "s", ws_url: "ws://x" },
      { createWebSocket, logger: null },
    );
    await expect(browser.connect()).rejects.toThrow("CDP connection failed: refused");
    expect(browser.connected).toBe(false);
    expect(browser.closed).toBe(true);
  });

  test("a connect that hangs times out and closes", async () => {
    const chrome = new FakeChrome();
    chrome.respond("Target.setAutoAttach", () => {
      throw new Error("unused");
    });
    let closed = 0;
    const browser = new Browser(
      { internal_uuid: "s", ws_url: "ws://x" },
      {
        createWebSocket: (url) => {
          const ws = chrome.create(url);
          ws.onSend = () => {}; // nothing is ever answered
          return ws;
        },
        connectTimeout: 100,
        logger: null,
        onClose: async () => {
          closed += 1;
        },
      },
    );
    const err = await browser.connect().catch((e) => e);
    expect(err).toBeInstanceOf(BrowserTimeoutError);
    expect(err.message).toBe("could not connect within 100ms");
    expect(closed).toBe(1);
    expect(() => browser.cdp).toThrow(/not connected/);
    await expect(browser.connect()).rejects.toThrow(); // a fresh attempt is allowed
  });

  test("connecting twice", async () => {
    const { browser } = await start();
    await expect(browser.connect()).rejects.toThrow("already connected");
  });
});

describe("pages", () => {
  test("newPage sets up a paused target and lists it", async () => {
    const { browser, chrome } = await start();
    const page = await browser.newPage();
    expect(page).toBeInstanceOf(Page);
    expect(page).not.toBe(browser);
    expect(browser.pages).toEqual([browser, page]);
    expect(chrome.called("Target.createTarget")[0]?.params).toEqual({
      url: "about:blank",
      newWindow: true,
    });
    expect(chrome.onSession(page._sessionId)).toEqual([
      "Page.enable",
      "Page.setLifecycleEventsEnabled",
      "Fetch.enable",
      "Runtime.runIfWaitingForDebugger",
    ]);
    await page.goto("https://x.test");
    expect(chrome.called("Page.navigate")[0]?.sessionId).toBe(page._sessionId);
    await page.close();
    expect(page.closed).toBe(true);
    expect(browser.pages).toEqual([browser]);
  });

  test("waitForPage returns the window an action opened", async () => {
    const { browser, chrome } = await start();
    chrome.respond("Human.click", () => {
      setTimeout(() => chrome.attachPage("POP", { url: "https://x.test/pop" }), 50);
      return {};
    });
    const popup = await browser.waitForPage(browser.click("a"));
    expect(popup.targetId).toBe("POP");
    expect(browser.pages).toHaveLength(2);
    chrome.respond("Human.click", () => {
      setTimeout(() => chrome.attachPage("POP2", { url: "https://x.test/pop2" }), 50);
      return {};
    });
    const again = await browser.waitForPage(() => browser.click("a"));
    expect(again.targetId).toBe("POP2");
    expect(browser.pages).toHaveLength(3);
    chrome.respond("Human.click", () => ({}));
    await expect(
      browser.waitForPage(browser.click("a"), { timeout: 150 }),
    ).rejects.toThrow("no page opened within 150ms");
  });

  test("a detached or crashed page is dropped, the browser's own retires it", async () => {
    const warned: string[] = [];
    const { browser, chrome, sessionId } = await start({
      logger: { warn: (m) => warned.push(m) },
    });
    const page = await browser.newPage();
    chrome.event("Inspector.targetCrashed", {}, page._sessionId);
    expect(page.closed).toBe(true);
    expect(browser.pages).toEqual([browser]);
    expect(browser.shouldRecycle).toBe(false);
    chrome.detach(sessionId);
    expect(browser.closed).toBe(true);
    expect(browser.shouldRecycle).toBe(true);
    expect(warned).toEqual(["page target gone for sess-1"]);
  });

  test("events are routed by session", async () => {
    const { browser, chrome, sessionId } = await start();
    const page = await browser.newPage();
    chrome.pauseDocument(page._sessionId, "R1", 201);
    expect(page.status).toBe(201);
    expect(browser.status).toBeUndefined();
    chrome.pauseDocument(sessionId, "R2", 200);
    expect(browser.status).toBe(200);
    chrome.event("Fetch.requestPaused", { requestId: "R3" }, "S-unknown");
    await settle();
    expect(chrome.called("Fetch.continueResponse").map((c) => c.sessionId)).toEqual([
      page._sessionId,
      sessionId,
    ]);
  });
});

describe("lifetime", () => {
  test("a server disconnect closes every page and fails waits", async () => {
    const warned: string[] = [];
    const { browser, chrome } = await start({ logger: { warn: (m) => warned.push(m) } });
    const page = await browser.newPage();
    chrome.autoNavigate = false;
    const nav = page.goto("https://x.test", { timeout: 5000 });
    await settle();
    chrome.socket!.serverClose();
    await expect(nav).rejects.toThrow("CDP connection closed");
    expect(page.closed).toBe(true);
    expect(browser.closed).toBe(true);
    expect(browser.connected).toBe(false);
    expect(browser.shouldRecycle).toBe(true);
    expect(warned).toContain("CDP connection closed by the server");
    await expect(browser.title()).rejects.toThrow("page is closed");
  });

  test("close stops the socket, runs onClose once, and dispose is close", async () => {
    let closed = 0;
    const { browser, chrome } = await start({
      onClose: async () => {
        closed += 1;
      },
    });
    await browser.close();
    await browser.close();
    await browser[Symbol.asyncDispose]();
    expect(chrome.socket!.closed).toBe(true);
    expect(closed).toBe(1);
    expect(browser.connected).toBe(false);
    expect(browser.closed).toBe(true);
    await expect(browser.url()).rejects.toThrow("page is closed");
    live = undefined;
  });

  test("a reconnect keeps the dialog handler and starts clean", async () => {
    const { browser, chrome } = await start();
    const handler = () => true;
    browser.onDialog = handler;
    await browser.goto("https://x.test");
    await browser.close();
    chrome.sessions.clear();
    chrome.targets.clear();
    await browser.connect();
    expect(browser.onDialog).toBe(handler);
    expect(browser.status).toBeUndefined();
    expect(browser.connected).toBe(true);
    expect(browser.pages).toHaveLength(1);
  });

  test("_endLease closes the other pages, drops captures and the handler, keeps data", async () => {
    const { browser, chrome } = await start();
    const page = await browser.newPage();
    await browser.captureResponses("/x");
    browser.onDialog = () => true;
    browser.data.loggedIn = true;
    browser._lease();
    await browser._endLease();
    expect(page.closed).toBe(true);
    expect(browser.pages).toEqual([browser]);
    expect(chrome.called("Network.disable")).toHaveLength(1);
    expect(browser.onDialog).toBeNull();
    expect(browser.data).toEqual({ loggedIn: true });
    expect(browser.useCount).toBe(1);
  });
});

describe("options", () => {
  test("blocked resources and urls are validated", () => {
    expect(normalizeBlocked(["Image", "font"])).toEqual(new Set(["image", "font"]));
    expect(normalizeBlocked(undefined)).toEqual(new Set());
    expect(() => normalizeBlocked(["document"])).toThrow(/blocks the page itself/);
    expect(() => normalizeBlocked(["imag"])).toThrow(
      /unknown resource types \["imag"\]; valid:/,
    );
    expect(() => normalizeBlocked("image" as never)).toThrow(/not 1 string/);
    expect(normalizeUrls(["*.png"])).toEqual(["*.png"]);
    expect(() => normalizeUrls("*.png" as never)).toThrow(/not 1 string/);
    expect(
      () => new Browser({ internal_uuid: "s", ws_url: "w" }, { blockResources: ["x"] }),
    ).toThrow(TypeError);
  });

  test("raw access", async () => {
    const { browser, chrome } = await start();
    expect(await browser.cdp.send("Browser.getVersion")).toEqual({ product: "Chrome/1" });
    expect(await browser.send("Custom.method", { a: 1 })).toEqual({});
    expect(chrome.called("Custom.method")[0]).toMatchObject({
      params: { a: 1 },
      sessionId: browser._sessionId,
    });
    chrome.respond("Custom.method", () => ({ error: { message: "no" } }));
    await expect(browser.send("Custom.method")).rejects.toBeInstanceOf(CDPError);
  });
});

describe("review follow-ups", () => {
  test("commandTimeout: null means no deadline on newPage", async () => {
    const { browser } = await start({ commandTimeout: null });
    const page = await browser.newPage();
    expect(page.closed).toBe(false);
  });

  test("close stops the socket even when a background task hangs", async () => {
    const { browser, chrome } = await start();
    const socket = chrome.socket!;
    const original = socket.onSend;
    socket.onSend = (message) => {
      if (message.method !== "Target.detachFromTarget") original?.(message); // never answered
    };
    chrome.attachPage("EXT", { url: "chrome-extension://abc/bg.html", waiting: false });
    await settle();
    const started = Date.now();
    await browser.close();
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(socket.closed).toBe(true);
    expect(browser.connected).toBe(false);
    live = undefined;
  }, 10_000);
});
