import { afterEach, describe, expect, test } from "vitest";
import { connection, Surfsky } from "../src/client.js";
import { ConfigurationError } from "../src/errors.js";
import { FakeChrome } from "./fakeChrome.js";
import { fakeFetch, ok, testClient } from "./helpers.js";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("connection", () => {
  test("needs a token and a base url", () => {
    process.env.SURFSKY_API_TOKEN = "";
    process.env.SURFSKY_API_BASE_URL = "";
    expect(() => new Surfsky()).toThrow(ConfigurationError);
    expect(() => new Surfsky({ apiToken: "t" })).toThrow(/SURFSKY_API_BASE_URL/);
  });

  test("falls back to the environment and trims the slash", () => {
    process.env.SURFSKY_API_TOKEN = "env-token";
    process.env.SURFSKY_API_BASE_URL = "https://env.test/";
    const client = new Surfsky({ logger: null });
    expect(client.baseUrl).toBe("https://env.test");
    expect(client.headers["X-Cloud-Api-Token"]).toBe("env-token");
    expect(client.headers["User-Agent"]).toMatch(
      /^surfsky-js\/\d+\.\d+\.\d+ (node|bun)\//,
    );
    expect(connection("t", "https://x.test//").baseUrl).toBe("https://x.test");
  });
});

test("requests carry the headers and hit baseUrl + path", async () => {
  const { client, requests } = testClient([ok([])], { headers: { "X-Extra": "1" } });
  await client.profiles.listActive();
  expect(requests[0]?.url).toBe("https://api.test/profiles/active");
  expect(requests[0]?.headers["x-cloud-api-token"]).toBe("test-token");
  expect(requests[0]?.headers["x-extra"]).toBe("1");
  expect(requests[0]?.headers.accept).toBe("application/json");
});

test("withOptions clones with overrides and shares fetch", async () => {
  const { client, requests } = testClient([ok([]), ok([])]);
  const fast = client.withOptions({
    timeout: 8000,
    maxRetries: 0,
    headers: { "X-Fast": "y" },
  });
  expect(fast.timeout).toBe(8000);
  expect(fast.maxRetries).toBe(0);
  expect(fast.fetch).toBe(client.fetch);
  expect(client.timeout).toBe(30_000);
  await fast.profiles.listActive();
  await client.profiles.listActive();
  expect(requests[0]?.headers["x-fast"]).toBe("y");
  expect(requests[1]?.headers["x-fast"]).toBeUndefined();
});

test("request returns the raw response without throwing", async () => {
  const { client, requests } = testClient([{ status: 404, json: { msg: "no" } }]);
  const response = await client.request("GET", "/whatever", {
    params: { a: 1 },
    headers: { "X-One": "1" },
  });
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ msg: "no" });
  expect(requests[0]?.url).toBe("https://api.test/whatever?a=1");
  expect(requests[0]?.headers["x-one"]).toBe("1");
});

test("close and dispose are harmless", async () => {
  const { client } = testClient();
  await client.close();
  await client[Symbol.asyncDispose]();
});

describe("session", () => {
  test("starts one-time or on a profile, stops once on dispose", async () => {
    const session = { internal_uuid: "s1", ws_url: "ws://x" };
    const { client, requests } = testClient([ok(session), ok({ uuid: "p" })]);
    const managed = await client.session({ proxy: { tier: "shared", country: "us" } });
    expect(managed.internal_uuid).toBe("s1");
    expect(requests[0]?.path).toBe("/profiles/one_time");
    expect(requests[0]?.body).toEqual({ proxy: { tier: "shared", country: "us" } });
    await managed.stop();
    await managed[Symbol.asyncDispose]();
    expect(requests).toHaveLength(2);
    expect(requests[1]?.path).toBe("/profiles/s1/stop");

    const { client: c2, requests: r2 } = testClient([ok(session), ok(null)]);
    await using s2 = await c2.session({ profileUuid: "p1", extensions: ["e"] });
    expect(r2[0]?.path).toBe("/profiles/p1/start");
    expect(r2[0]?.body).toEqual({ extensions: ["e"] });
    void s2;
  });

  test("a failed stop is logged, not thrown", async () => {
    const warned: string[] = [];
    const { client } = testClient(
      [ok({ internal_uuid: "s1", ws_url: "ws://x" }), { status: 500 }],
      {
        logger: { warn: (m) => warned.push(m) },
      },
    );
    const managed = await client.session();
    await managed.stop();
    expect(warned[0]).toMatch(/failed to stop session s1: .*500/);
  });

  test("a hung stop is logged as such", async () => {
    const f = fakeFetch([ok({ internal_uuid: "s1", ws_url: "ws://x" })]);
    const warned: string[] = [];
    const client = new Surfsky({
      apiToken: "t",
      baseUrl: "https://api.test",
      logger: { warn: (m) => warned.push(m) },
      fetch: async (input, init) => {
        if (String(input).endsWith("/stop")) {
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "TimeoutError")),
            );
          });
        }
        return f.fetch(input, init);
      },
    });
    const managed = await client.session();
    await managed.stop();
    expect(warned[0]).toMatch(/failed to stop session s1: .*timed out/);
  }, 15_000);
});

describe("browser", () => {
  test("starts a session, connects, and stops on close", async () => {
    const { client, requests } = testClient([
      ok({ internal_uuid: "s1", ws_url: "ws://x" }),
      ok({ uuid: "p" }),
    ]);
    const chrome = new FakeChrome();
    const browser = await client.browser({
      createWebSocket: chrome.create,
      blockResources: ["image"],
      proxy: "http://p",
    });
    expect(browser.connected).toBe(true);
    expect(browser.internalUuid).toBe("s1");
    expect(requests[0]?.body).toEqual({ proxy: "http://p" });
    await browser.close();
    await browser.close();
    expect(requests.map((r) => r.path)).toEqual([
      "/profiles/one_time",
      "/profiles/s1/stop",
    ]);
  });

  test("await using closes it", async () => {
    const { client, requests } = testClient([
      ok({ internal_uuid: "s1", ws_url: "ws://x" }),
      ok(null),
    ]);
    {
      await using browser = await client.browser({
        createWebSocket: new FakeChrome().create,
      });
      expect(browser.pages).toHaveLength(1);
    }
    expect(requests[1]?.path).toBe("/profiles/s1/stop");
  });

  test("bad browser options never start a session", async () => {
    const { client, requests } = testClient([]);
    await expect(client.browser({ blockResources: ["nope"] })).rejects.toThrow(
      /unknown resource/,
    );
    await expect(client.browser({ proxi: 1 } as never)).rejects.toThrow(/proxi/);
    expect(requests).toHaveLength(0);
  });

  test("a failed connect stops the session and rethrows", async () => {
    const { client, requests } = testClient([
      ok({ internal_uuid: "s1", ws_url: "ws://x" }),
      ok(null),
    ]);
    const chrome = new FakeChrome();
    chrome.respond("Target.setAutoAttach", () => ({ error: { message: "refused" } }));
    await expect(client.browser({ createWebSocket: chrome.create })).rejects.toThrow(
      "refused",
    );
    expect(requests.map((r) => r.path)).toEqual([
      "/profiles/one_time",
      "/profiles/s1/stop",
    ]);
  });
});
