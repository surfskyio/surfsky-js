import { expect, test } from "vitest";
import { FakeChrome } from "./fakeChrome.js";
import { ok, testClient } from "./helpers.js";

test("client.map runs every url through the real pool, browser and CDP client", async () => {
  let counter = 0;
  const { client, requests } = testClient(
    [],
    { logger: null },
    {
      "POST /profiles/one_time": () => {
        counter += 1;
        return ok({ internal_uuid: `sess-${counter}`, ws_url: `ws://fake/${counter}` });
      },
      "GET /users/browser-limits": () => ok({ parallel_browsers: 2 }),
    },
  );
  const chromes: FakeChrome[] = [];
  const createWebSocket = (url: string) => {
    const chrome = new FakeChrome();
    chrome.respond("Page.navigate", (params, sessionId) => {
      const targetId = chrome.sessions.get(sessionId ?? "") ?? "";
      const target = chrome.targets.get(targetId);
      if (target) {
        target.url = params.url;
        target.title = `Title of ${params.url}`;
      }
      const loaderId = chrome.newLoaderId();
      queueMicrotask(() => {
        chrome.pauseDocument(sessionId ?? "", `R-${loaderId}`, 200);
        chrome.lifecycle(sessionId ?? "", loaderId, [
          "init",
          "commit",
          "DOMContentLoaded",
          "load",
        ]);
      });
      return { frameId: targetId, loaderId };
    });
    chromes.push(chrome);
    return chrome.create(url);
  };

  const urls = ["https://a.test", "https://b.test", "https://c.test"];
  const outcomes = await client.map(
    async (browser, url: string) => {
      await browser.goto(url, { waitUntil: "domcontentloaded" });
      return {
        title: await browser.title(),
        status: browser.status,
        id: browser.internalUuid,
      };
    },
    urls,
    { createWebSocket, blockResources: ["image"] },
  );

  expect(outcomes.map((o) => o.ok)).toEqual([true, true, true]);
  expect(outcomes.map((o) => (o.ok ? o.value.title : ""))).toEqual(
    urls.map((u) => `Title of ${u}`),
  );
  expect(outcomes.every((o) => o.ok && o.value.status === 200)).toBe(true);
  expect(chromes).toHaveLength(2);
  const stops = requests
    .filter((r) => r.path.endsWith("/stop"))
    .map((r) => r.path)
    .sort();
  expect(stops).toEqual(["/profiles/sess-1/stop", "/profiles/sess-2/stop"]);
  expect(chromes.every((c) => c.socket?.closed)).toBe(true);
  expect(requests[0]?.headers["x-cloud-api-token"]).toBe("test-token");
});
