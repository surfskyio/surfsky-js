import { afterEach, describe, expect, test, vi } from "vitest";
import { CapturedResponse, cookieParam, NavWaiter } from "../src/browser/page.js";
import { BrowserTimeoutError, CDPError, PageClosedError } from "../src/errors.js";
import type { FakeBrowser } from "./fakeChrome.js";
import { FakeChrome, fakeBrowser } from "./fakeChrome.js";
import { settle } from "./helpers.js";

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

describe("setup", () => {
  test("enables the page, lifecycle and Fetch with the blocked patterns", async () => {
    const { chrome, sessionId } = await start({
      blockResources: ["Image", "font"],
      blockUrls: ["*.png"],
    });
    expect(chrome.onSession(sessionId)).toEqual([
      "Page.enable",
      "Page.setLifecycleEventsEnabled",
      "Fetch.enable",
    ]);
    expect(chrome.calls.find((c) => c.method === "Fetch.enable")?.params).toEqual({
      patterns: [
        { urlPattern: "*", resourceType: "Font" },
        { urlPattern: "*", resourceType: "Image" },
        { urlPattern: "*.png" },
        { urlPattern: "*", resourceType: "Document", requestStage: "Response" },
      ],
    });
  });

  test("a failed setup surfaces on the first command", async () => {
    const chrome = new FakeChrome();
    chrome.respond("Fetch.enable", () => ({ error: { message: "nope" } }));
    await expect(fakeBrowser({ chrome })).rejects.toThrow("Fetch.enable: nope");
    expect(chrome.socket?.closed).toBe(true);
    // a later page's failed setup surfaces on its first command instead
    const { browser, chrome: ours } = await start();
    ours.respond("Fetch.enable", (_p, sessionId) =>
      sessionId === browser._sessionId ? {} : { error: { message: "nope" } },
    );
    const page = await browser.newPage().catch((e) => e);
    expect(page).toBeInstanceOf(CDPError);
    expect(page.message).toBe("Fetch.enable: nope");
  });
});

describe("goto", () => {
  test("waits for its own document's load and ignores a stale one", async () => {
    const { browser, chrome, sessionId } = await start();
    chrome.autoNavigate = false;
    chrome.respond("Page.navigate", () => {
      chrome.lifecycle(sessionId, "L0", ["init", "load"]); // the previous document
      return { frameId: browser.targetId, loaderId: "L1" };
    });
    const nav = browser.goto("https://x.test");
    await settle();
    let settled = false;
    nav.then(() => {
      settled = true;
    });
    await settle();
    expect(settled).toBe(false);
    chrome.pauseDocument(sessionId, "R1", 404);
    chrome.lifecycle(sessionId, "L1", ["init", "commit", "DOMContentLoaded", "load"]);
    await nav;
    expect(browser.status).toBe(404);
    expect(chrome.onSession(sessionId, "Fetch.continueResponse")).toHaveLength(1);
    expect(chrome.calls.find((c) => c.method === "Page.navigate")?.params).toEqual({
      url: "https://x.test",
    });
  });

  test("a milestone that arrived before the reply counts", async () => {
    const { browser, chrome, sessionId } = await start();
    chrome.autoNavigate = false;
    chrome.respond("Page.navigate", () => {
      chrome.lifecycle(sessionId, "L9", ["init", "load"]);
      return { loaderId: "L9", frameId: browser.targetId };
    });
    await browser.goto("https://x.test");
  });

  test("follows a document that replaced ours", async () => {
    const { browser, chrome, sessionId } = await start();
    chrome.autoNavigate = false;
    chrome.respond("Page.navigate", () => ({
      loaderId: "L1",
      frameId: browser.targetId,
    }));
    const nav = browser.goto("https://x.test");
    await settle();
    chrome.lifecycle(sessionId, "L1", ["init"]);
    chrome.lifecycle(sessionId, "L2", ["init", "load"]);
    await nav;
  });

  test("domcontentloaded, commit and the other frame", async () => {
    const { browser, chrome, sessionId } = await start();
    chrome.autoNavigate = false;
    chrome.respond("Page.navigate", () => ({
      loaderId: "L1",
      frameId: browser.targetId,
    }));
    await browser.goto("https://x.test", { waitUntil: "commit" });
    const nav = browser.goto("https://x.test", { waitUntil: "domcontentloaded" });
    await settle();
    chrome.lifecycle(sessionId, "L1", ["init", "DOMContentLoaded"], "iframe-1");
    chrome.lifecycle(sessionId, "L1", ["init", "DOMContentLoaded"]);
    await nav;
  });

  test("times out with the deadline in the message", async () => {
    const { browser, chrome } = await start();
    chrome.autoNavigate = false;
    const err = await browser.goto("https://x.test", { timeout: 150 }).catch((e) => e);
    expect(err).toBeInstanceOf(BrowserTimeoutError);
    expect(err.message).toBe(
      "navigation to https://x.test did not reach 'load' within 150ms",
    );
    chrome.autoNavigate = true;
    await browser.goto("https://y.test"); // the waiter was released
  });

  test("errorText and a second navigation", async () => {
    const { browser, chrome } = await start();
    chrome.respond("Page.navigate", () => ({ errorText: "net::ERR_NAME_NOT_RESOLVED" }));
    await expect(browser.goto("https://x.test")).rejects.toThrow(
      "navigation to https://x.test failed: net::ERR_NAME_NOT_RESOLVED",
    );
    chrome.autoNavigate = false;
    chrome.respond("Page.navigate", () => ({
      loaderId: "L1",
      frameId: browser.targetId,
    }));
    const first = browser.goto("https://x.test", { timeout: 300 });
    await expect(browser.goto("https://y.test")).rejects.toThrow(
      "navigation already in progress",
    );
    await first.catch(() => {});
  });

  test("reload follows the newest document", async () => {
    const { browser, chrome, sessionId } = await start();
    await browser.goto("https://x.test");
    chrome.autoNavigate = false;
    const reload = browser.reload({ waitUntil: "domcontentloaded" });
    await settle();
    chrome.lifecycle(sessionId, "L5", ["init", "DOMContentLoaded"]);
    await reload;
  });

  test("waitForLoadState reads the milestones already reached", async () => {
    const { browser } = await start();
    await browser.goto("https://x.test", { waitUntil: "commit" });
    await browser.waitForLoadState("networkidle", { timeout: 500 });
    await expect(
      browser.waitForLoadState("networkidle", { timeout: 1 }),
    ).resolves.toBeUndefined();
  });

  test("a new goto forgets the last status", async () => {
    const { browser, chrome, sessionId } = await start();
    chrome.pauseDocument(sessionId, "R1", 200);
    expect(browser.status).toBe(200);
    chrome.autoNavigate = false;
    browser.goto("https://x.test", { timeout: 50 }).catch(() => {});
    expect(browser.status).toBeUndefined();
    await settle();
  });

  test("history steps", async () => {
    const { browser, chrome } = await start();
    let current = 1;
    chrome.respond("Page.getNavigationHistory", () => ({
      currentIndex: current,
      entries: [{ id: 10 }, { id: 11 }],
    }));
    chrome.respond("Page.navigateToHistoryEntry", (p) => {
      current = p.entryId === 10 ? 0 : 1;
      return {};
    });
    chrome.targets.get(browser.targetId)!.url = "https://a.test";
    expect(await browser.goBack()).toBe("https://a.test");
    expect(await browser.goBack()).toBeNull();
    expect(await browser.goForward()).toBe("https://a.test");
    expect(await browser.goForward()).toBeNull();
  });
});

describe("Fetch interception", () => {
  test("blocks, lets errors through and reads only the main frame's status", async () => {
    const { browser, chrome, sessionId } = await start({ blockResources: ["image"] });
    chrome.event(
      "Fetch.requestPaused",
      { requestId: "R1", request: {}, resourceType: "Image" },
      sessionId,
    );
    chrome.event(
      "Fetch.requestPaused",
      { requestId: "R2", request: {}, responseErrorReason: "Failed" },
      sessionId,
    );
    chrome.pauseDocument(sessionId, "R3", 500, "iframe");
    chrome.event("Fetch.requestPaused", { request: {} }, sessionId);
    await settle();
    expect(
      chrome.calls.filter(
        (c) => c.method.startsWith("Fetch.") && c.method !== "Fetch.enable",
      ),
    ).toMatchObject([
      {
        method: "Fetch.failRequest",
        params: { requestId: "R1", errorReason: "BlockedByClient" },
      },
      { method: "Fetch.continueRequest", params: { requestId: "R2" } },
      { method: "Fetch.continueResponse", params: { requestId: "R3" } },
    ]);
    expect(browser.status).toBeUndefined();
  });
});

describe("evaluate", () => {
  test("expressions, functions and args, in the isolated world", async () => {
    const { browser, chrome } = await start();
    chrome.respond("Runtime.evaluate", (p) => ({
      result: { type: "string", value: p.expression },
    }));
    expect(await browser.evaluate("document.title")).toBe("document.title");
    expect(await browser.evaluate("(a, b) => a + b", { args: [1, "x"] })).toBe(
      '((a, b) => a + b)(...[1,"x"])',
    );
    expect(await browser.evaluate("() => 1")).toBe("(() => 1)()");
    expect(await browser.evaluate("async function f() {}")).toBe(
      "(async function f() {})()",
    );
    expect(await browser.evaluate(() => document.title)).toBe("(() => document.title)()");
    const evaluates = chrome.called("Runtime.evaluate");
    expect(evaluates[0]?.params).toEqual({
      expression: "document.title",
      returnByValue: true,
      awaitPromise: true,
      contextId: 7,
    });
    expect(chrome.called("Page.createIsolatedWorld")).toHaveLength(1);
    expect(chrome.called("Page.createIsolatedWorld")[0]?.params).toEqual({
      frameId: browser.targetId,
      worldName: "utility",
    });
    await browser.evaluate("1", { isolated: false, awaitPromise: false });
    expect(chrome.called("Runtime.evaluate")[5]?.params).toEqual({
      expression: "1",
      returnByValue: true,
      awaitPromise: false,
    });
  });

  test("a new document gets a new world, a stale context is retried once", async () => {
    const { browser, chrome, sessionId } = await start();
    let failNext = false;
    chrome.respond("Runtime.evaluate", () => {
      if (failNext) {
        failNext = false;
        return { error: { message: "Cannot find context with specified id" } };
      }
      return { result: { type: "number", value: 1 } };
    });
    await browser.evaluate("1");
    chrome.lifecycle(sessionId, "L2", ["init"]);
    await browser.evaluate("1");
    expect(chrome.called("Page.createIsolatedWorld")).toHaveLength(2);
    failNext = true;
    expect(await browser.evaluate("1")).toBe(1);
    expect(chrome.called("Page.createIsolatedWorld")).toHaveLength(3);
  });

  test("exceptions and a function that was not called", async () => {
    const { browser, chrome } = await start();
    chrome.respond("Runtime.evaluate", () => ({
      result: {},
      exceptionDetails: {
        text: "Uncaught",
        exception: { description: "ReferenceError: x" },
      },
    }));
    await expect(browser.evaluate("x")).rejects.toThrow(
      "evaluate failed: ReferenceError: x",
    );
    let calls = 0;
    chrome.respond("Runtime.evaluate", () => {
      calls += 1;
      return calls === 1
        ? { result: { type: "function" } }
        : { result: { type: "number", value: 2 } };
    });
    expect(await browser.evaluate("x => x")).toBe(2);
  });

  test("waitForFunction polls until truthy and times out", async () => {
    const { browser, chrome } = await start();
    let value = 0;
    chrome.respond("Runtime.evaluate", () => ({
      result: { type: "number", value: value++ },
    }));
    expect(await browser.waitForFunction("() => window.ready")).toBe(1);
    chrome.respond("Runtime.evaluate", () => ({
      result: { type: "boolean", value: false },
    }));
    await expect(
      browser.waitForFunction("() => false", { timeout: 150 }),
    ).rejects.toThrow("'() => false' was not truthy within 150ms");
  });
});

describe("reading", () => {
  test("text, attributes, counts, html", async () => {
    const { browser, chrome } = await start();
    chrome.respond("Runtime.evaluate", (p) => ({
      result: {
        type: "string",
        value: p.expression.includes("querySelectorAll") ? ["a", "b"] : "hi",
      },
    }));
    expect(await browser.innerText("h1")).toBe("hi");
    expect(await browser.allInnerTexts("p")).toEqual(["a", "b"]);
    chrome.respond("DOM.querySelector", (p) => ({
      nodeId: p.selector === "#gone" ? 0 : 5,
    }));
    chrome.respond("DOM.getAttributes", () => ({
      attributes: ["href", "/x", "id", "a"],
    }));
    expect(await browser.getAttribute("a", "href")).toBe("/x");
    expect(await browser.getAttribute("a", "class")).toBeNull();
    expect(await browser.getAttribute("#gone", "href")).toBeNull();
    chrome.respond("DOM.querySelectorAll", () => ({ nodeIds: [1, 2, 3] }));
    expect(await browser.count("li")).toBe(3);
    chrome.respond("DOM.getOuterHTML", (p) => ({
      outerHTML: p.nodeId === 1 ? "<html></html>" : "<a></a>",
    }));
    expect(await browser.outerHtml("a")).toBe("<a></a>");
    expect(await browser.outerHtml("#gone")).toBeNull();
    expect(await browser.content()).toBe("<html></html>");
    chrome.targets.get(browser.targetId)!.title = "T";
    chrome.targets.get(browser.targetId)!.url = "https://u.test";
    expect(await browser.title()).toBe("T");
    expect(await browser.url()).toBe("https://u.test");
  });

  test("selectOption by value or label", async () => {
    const { browser, chrome } = await start();
    chrome.respond("Runtime.evaluate", (p) => {
      const args = JSON.parse(
        p.expression.slice(p.expression.lastIndexOf("(...") + 4, -1),
      );
      if (args[0] === "#gone") return { result: { type: "object", value: null } };
      if (args[1] === "x" || args[2] === "x")
        return { result: { type: "boolean", value: false } };
      return { result: { type: "string", value: args[1] ?? "from-label" } };
    });
    expect(await browser.selectOption("select", "v1")).toBe("v1");
    expect(await browser.selectOption("select", { label: "One" })).toBe("from-label");
    await expect(browser.selectOption("select", {})).rejects.toThrow(
      /either a value or a label/,
    );
    await expect(browser.selectOption("#gone", "v")).rejects.toThrow(
      "nothing matches '#gone'",
    );
    await expect(browser.selectOption("select", "x")).rejects.toThrow(
      "'select' has no option 'x'",
    );
  });

  test("waitForSelector, isVisible", async () => {
    const { browser, chrome } = await start();
    let present = false;
    let boxed = false;
    chrome.respond("DOM.querySelector", () => ({ nodeId: present ? 3 : 0 }));
    chrome.respond("DOM.getBoxModel", () =>
      boxed ? { model: { width: 10, height: 5 } } : { error: { message: "no box" } },
    );
    expect(await browser.isVisible("#a")).toBe(false);
    await expect(browser.waitForSelector("#a", { timeout: 120 })).rejects.toThrow(
      "'#a' was not visible within 120ms",
    );
    present = true;
    await browser.waitForSelector("#a", { visible: false });
    await expect(browser.waitForSelector("#a", { timeout: 120 })).rejects.toThrow(
      BrowserTimeoutError,
    );
    boxed = true;
    await browser.waitForSelector("#a");
    expect(await browser.isVisible("#a")).toBe(true);
    chrome.respond("DOM.getBoxModel", () => ({ model: { width: 0, height: 5 } }));
    expect(await browser.isVisible("#a")).toBe(false);
  });

  test("waitForUrl", async () => {
    const { browser, chrome } = await start();
    const target = chrome.targets.get(browser.targetId)!;
    target.url = "https://x.test/start";
    setTimeout(() => {
      target.url = "https://x.test/?q=1";
    }, 150);
    expect(await browser.waitForUrl("?q=")).toBe("https://x.test/?q=1");
    await expect(browser.waitForUrl("nope", { timeout: 120 })).rejects.toThrow(
      "the page did not reach 'nope' within 120ms",
    );
  });
});

describe("cookies and storage", () => {
  test("cookies round trip", async () => {
    const { browser, chrome } = await start();
    chrome.respond("Network.getCookies", () => ({
      cookies: [
        { name: "a", value: "1", expires: 123, httpOnly: true },
        { name: "s", expires: -1 },
      ],
    }));
    expect(await browser.cookies()).toEqual([
      { name: "a", value: "1", expirationDate: 123, httpOnly: true },
      { name: "s", expirationDate: -1 },
    ]);
    await browser.setCookies([
      { name: "b", value: "2", expirationDate: 5, secure: undefined },
    ]);
    expect(chrome.called("Network.setCookies")[0]?.params).toEqual({
      cookies: [{ expires: 5, name: "b", value: "2", expirationDate: 5 }],
    });
    expect(cookieParam({ name: "x" })).toEqual({ name: "x" });
    await browser.clearCookies();
    expect(chrome.called("Network.clearBrowserCookies")).toHaveLength(1);
  });

  test("local and session storage", async () => {
    const { browser, chrome } = await start();
    chrome.respond("Page.getFrameTree", () => ({
      frameTree: { frame: { storageKey: "https://x.test/" } },
    }));
    chrome.respond("DOMStorage.getDOMStorageItems", () => ({ entries: [["k", "v"]] }));
    expect(await browser.localStorage()).toEqual({ k: "v" });
    await browser.setSessionStorage({ a: "1", b: "2" });
    expect(chrome.called("DOMStorage.enable")).toHaveLength(1);
    expect(chrome.called("DOMStorage.getDOMStorageItems")[0]?.params).toEqual({
      storageId: { isLocalStorage: true, storageKey: "https://x.test/" },
    });
    expect(chrome.called("DOMStorage.setDOMStorageItem").map((c) => c.params)).toEqual([
      {
        storageId: { isLocalStorage: false, storageKey: "https://x.test/" },
        key: "a",
        value: "1",
      },
      {
        storageId: { isLocalStorage: false, storageKey: "https://x.test/" },
        key: "b",
        value: "2",
      },
    ]);
    chrome.respond("Page.getFrameTree", () => ({
      frameTree: { frame: { securityOrigin: "https://o.test" } },
    }));
    await browser.sessionStorage();
    expect(chrome.called("DOMStorage.getDOMStorageItems")[1]?.params).toEqual({
      storageId: { isLocalStorage: false, securityOrigin: "https://o.test" },
    });
  });
});

describe("screenshot", () => {
  test("viewport, element and full page", async () => {
    const { browser, chrome } = await start();
    const png = Buffer.from([137, 80, 78, 71]).toString("base64");
    chrome.respond("Page.captureScreenshot", () => ({ data: png }));
    chrome.respond("DOM.querySelector", () => ({ nodeId: 4 }));
    chrome.respond("DOM.getBoxModel", () => ({
      model: { content: [10, 20, 110, 20, 110, 70, 10, 70] },
    }));
    chrome.respond("Page.getLayoutMetrics", () => ({
      cssContentSize: { width: 800, height: 3000 },
      cssVisualViewport: { pageX: 5, pageY: 100 },
    }));
    expect([...(await browser.screenshot())]).toEqual([137, 80, 78, 71]);
    await browser.screenshot({ format: "jpeg", quality: 50 });
    await browser.screenshot({ format: "png", quality: 50 });
    await browser.screenshot({ selector: "#el" });
    await browser.screenshot({ fullPage: true, format: "webp" });
    expect(chrome.called("Page.captureScreenshot").map((c) => c.params)).toEqual([
      { format: "png", captureBeyondViewport: false },
      { format: "jpeg", captureBeyondViewport: false, quality: 50 },
      { format: "png", captureBeyondViewport: false },
      {
        format: "png",
        captureBeyondViewport: false,
        clip: { x: 15, y: 120, width: 100, height: 50, scale: 1 },
      },
      {
        format: "webp",
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, scale: 1, width: 800, height: 3000 },
      },
    ]);
    expect(chrome.called("DOM.scrollIntoViewIfNeeded")[0]?.params).toEqual({ nodeId: 4 });
    chrome.respond("DOM.querySelector", () => ({ nodeId: 0 }));
    await expect(browser.screenshot({ selector: "#gone" })).rejects.toThrow(
      "nothing matches '#gone'",
    );
  });
});

describe("dialogs", () => {
  test("default answers, handlers and the delay", async () => {
    vi.useFakeTimers();
    const { browser, chrome, sessionId } = await start();
    chrome.dialog(sessionId, "alert", "hi");
    chrome.dialog(sessionId, "beforeunload");
    browser.onDialog = (kind, message) =>
      kind === "prompt" ? `answer to ${message}` : true;
    chrome.dialog(sessionId, "prompt", "name?");
    chrome.dialog(sessionId, "confirm");
    browser.onDialog = () => {
      throw new Error("broken handler");
    };
    chrome.dialog(sessionId, "confirm");
    expect(chrome.called("Page.handleJavaScriptDialog")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(599);
    expect(chrome.called("Page.handleJavaScriptDialog")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(900);
    const answers = chrome.called("Page.handleJavaScriptDialog").map((c) => c.params);
    expect(answers).toHaveLength(5); // answered in a random order
    expect(answers).toEqual(
      expect.arrayContaining([
        { accept: false },
        { accept: true },
        { accept: true, promptText: "answer to name?" },
      ]),
    );
    expect(answers.filter((a) => a.accept === false)).toHaveLength(2);
  });

  test("the browser's handler backs a page's", async () => {
    vi.useFakeTimers();
    const { browser, chrome } = await start();
    const page = await browser.newPage();
    browser.onDialog = () => false;
    page.onDialog = () => true;
    chrome.dialog(page._sessionId, "confirm");
    page.onDialog = null;
    chrome.dialog(page._sessionId, "confirm");
    await vi.advanceTimersByTimeAsync(1500);
    const answers = chrome
      .called("Page.handleJavaScriptDialog")
      .map((c) => [c.sessionId, c.params.accept] as const);
    expect(answers.map((a) => a[0])).toEqual([page._sessionId, page._sessionId]);
    expect(answers.map((a) => a[1]).sort()).toEqual([false, true]);
  });
});

describe("network capture", () => {
  test("records matching responses with their bodies", async () => {
    const { browser, chrome, sessionId } = await start();
    await expect(browser.waitForResponse("/api")).rejects.toThrow(
      /captureResponses\(\) before/,
    );
    await expect(browser.captureResponses()).rejects.toThrow(/at least one/);
    await browser.captureResponses("/api/", "/graphql");
    await browser.captureResponses("/more");
    expect(chrome.called("Network.enable")).toHaveLength(1);
    chrome.respond("Network.getResponseBody", (p) =>
      p.requestId === "R1"
        ? { body: JSON.stringify({ ok: 1 }), base64Encoded: false }
        : { body: Buffer.from("raw").toString("base64"), base64Encoded: true },
    );
    chrome.event(
      "Network.responseReceived",
      {
        requestId: "R1",
        response: { url: "https://x/api/a", status: 200, headers: { h: "1" } },
      },
      sessionId,
    );
    chrome.event(
      "Network.responseReceived",
      { requestId: "R2", response: { url: "https://x/other", status: 200 } },
      sessionId,
    );
    chrome.event(
      "Network.responseReceived",
      { requestId: "R3", response: { url: "https://x/graphql", status: 201 } },
      sessionId,
    );
    chrome.event("Network.loadingFinished", { requestId: "R2" }, sessionId);
    chrome.event("Network.loadingFinished", { requestId: "R1" }, sessionId);
    const first = await browser.waitForResponse("/api/");
    expect(first).toBeInstanceOf(CapturedResponse);
    expect(first.status).toBe(200);
    expect(first.headers).toEqual({ h: "1" });
    expect(first.json()).toEqual({ ok: 1 });
    chrome.event("Network.loadingFinished", { requestId: "R3" }, sessionId);
    expect((await browser.waitForResponse("graphql")).text).toBe("raw");
    expect(browser.responses.map((r) => r.url)).toEqual([
      "https://x/api/a",
      "https://x/graphql",
    ]);
    await expect(browser.waitForResponse("/never", { timeout: 120 })).rejects.toThrow(
      "no response matching '/never' within 120ms",
    );
    await browser.stopCapturing();
    await browser.stopCapturing();
    expect(chrome.called("Network.disable")).toHaveLength(1);
    expect(browser.responses).toEqual([]);
  });

  test("a body that cannot be read leaves an empty one", async () => {
    const { browser, chrome, sessionId } = await start();
    await browser.captureResponses("/x");
    chrome.respond("Network.getResponseBody", () => ({ error: { message: "No data" } }));
    chrome.event(
      "Network.responseReceived",
      { requestId: "R1", response: { url: "/x", status: 204 } },
      sessionId,
    );
    chrome.event("Network.loadingFinished", { requestId: "R1" }, sessionId);
    const got = await browser.waitForResponse("/x");
    expect(got.body).toHaveLength(0);
    expect(got.text).toBe("");
  });
});

describe("errors", () => {
  test("a closed page refuses commands and ends waits", async () => {
    const { browser, chrome, sessionId } = await start();
    const page = await browser.newPage();
    const wait = page.waitForUrl("never", { timeout: 5000 });
    chrome.detach(page._sessionId);
    await expect(wait).rejects.toBeInstanceOf(PageClosedError);
    expect(page.closed).toBe(true);
    await expect(page.title()).rejects.toThrow("page is closed");
    await page.close(); // a no-op now
    expect(browser.pages).toHaveLength(1);
    const nav = browser.goto("https://x.test", { timeout: 5000 });
    chrome.autoNavigate = false;
    await settle();
    chrome.detach(sessionId);
    await expect(nav).rejects.toThrow("page closed");
  });

  test("CDP errors name the command and the selector", async () => {
    const { browser, chrome } = await start();
    chrome.respond("Human.click", () => ({
      error: { message: "Could not find node with given id" },
    }));
    await expect(browser.click("#x")).rejects.toThrow(
      "Human.click '#x': the page navigated while the command ran.",
    );
    chrome.respond("Human.type", () => ({ error: { message: "boom", code: -1 } }));
    const err = await browser.keyboard.type("x").catch((e) => e);
    expect(err).toBeInstanceOf(CDPError);
    expect(err.message).toBe("Human.type: boom");
    expect(err.code).toBe(-1);
  });

  test("a command that never answers times out", async () => {
    const { browser, chrome } = await start({ commandTimeout: 100 });
    chrome.respond("Page.bringToFront", () => {
      throw new Error("swallowed");
    });
    chrome.responders.set("Page.bringToFront", () => new Promise(() => {}) as never);
    const socket = chrome.socket!;
    const original = socket.onSend;
    socket.onSend = (message) => {
      if (message.method !== "Page.bringToFront") original?.(message);
    };
    await expect(browser.bringToFront()).rejects.toThrow(
      "Page.bringToFront did not answer within 100ms",
    );
  });
});

test("NavWaiter bookkeeping", () => {
  const waiter = new NavWaiter("load");
  waiter.observe("init", "L1");
  waiter.observe("load", "L1");
  waiter.observe("init", "L2");
  expect(waiter.follow("L1")).toBe(false); // replaced by L2, which has not loaded
  expect(waiter.loaderId).toBe("L2");
  waiter.observe("load", "L2");
  expect(waiter.done.isSet).toBe(true);
  const fresh = new NavWaiter("load");
  expect(fresh.followNewest()).toBe(false);
  fresh.observe("init", "L3");
  fresh.observe("load", "L3");
  expect(fresh.done.isSet).toBe(true);
  fresh.observe("init", "");
  fresh.fail("x");
  expect(fresh.error).toBe("x");
});
