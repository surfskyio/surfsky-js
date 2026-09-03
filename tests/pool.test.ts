import { afterEach, describe, expect, test, vi } from "vitest";
import { Browser } from "../src/browser/browser.js";
import { BrowserPool, StopRun } from "../src/browser/pool.js";
import { RateLimitError, ValidationError } from "../src/errors.js";
import { FakeChrome } from "./fakeChrome.js";
import type { RecordedRequest, Routes } from "./helpers.js";
import { ok, settle, testClient } from "./helpers.js";

interface Rig {
  client: ReturnType<typeof testClient>["client"];
  requests: RecordedRequest[];
  chromes: FakeChrome[];
  starts: () => RecordedRequest[];
  stops: () => RecordedRequest[];
  createWebSocket: (url: string) => ReturnType<FakeChrome["create"]>;
  warned: string[];
}

function rig(routes: Routes = {}, limits = { parallel_browsers: 2 }): Rig {
  let counter = 0;
  const warned: string[] = [];
  const { client, requests } = testClient(
    [],
    { logger: { warn: (m) => warned.push(m) } },
    {
      "POST /profiles/one_time": () => {
        counter += 1;
        return ok({ internal_uuid: `sess-${counter}`, ws_url: `ws://fake/${counter}` });
      },
      "GET /users/browser-limits": () => ok(limits),
      ...routes,
    },
  );
  const chromes: FakeChrome[] = [];
  return {
    client,
    requests,
    chromes,
    warned,
    starts: () => requests.filter((r) => r.path === "/profiles/one_time"),
    stops: () => requests.filter((r) => r.path.endsWith("/stop")),
    createWebSocket: (url) => {
      const chrome = new FakeChrome();
      chromes.push(chrome);
      return chrome.create(url);
    },
  };
}

let open: BrowserPool | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await open?.close();
  open = undefined;
});

async function pool(
  r: Rig,
  options: Partial<ConstructorParameters<typeof BrowserPool>[1]> = {},
) {
  open = await new BrowserPool(r.client, {
    createWebSocket: r.createWebSocket,
    ...options,
  }).open();
  return open;
}

describe("capacity", () => {
  test("auto is the plan's cap, explicit is explicit, closed throws", async () => {
    const r = rig();
    const auto = await pool(r);
    expect(auto.capacity).toBe(2);
    await auto.close();
    expect(() => auto.capacity).toThrow(/not open/);
    await expect(auto.lease(async () => 1)).rejects.toThrow(/not open/);
    const fixed = await pool(r, { concurrency: 5 });
    expect(fixed.capacity).toBe(5);
    const floor = await pool(r, { concurrency: 0 });
    expect(floor.capacity).toBe(1);
  });

  test("options are checked before anything starts", () => {
    const r = rig();
    expect(() => new BrowserPool(r.client, { proxi: "x" } as never)).toThrow(/proxi/);
    // NaN would make `map` do nothing at all and `lease` wait for ever
    expect(() => new BrowserPool(r.client, { concurrency: Number("x") })).toThrow(
      /whole number/,
    );
    expect(() => new BrowserPool(r.client, { concurrency: 2.5 })).toThrow(/whole number/);
    expect(() => new BrowserPool(r.client, { proxy: 42 as never })).toThrow(
      ValidationError,
    );
    expect(() => new BrowserPool(r.client, { blockResources: ["nope"] })).toThrow(
      /unknown resource/,
    );
    expect(
      () => new BrowserPool(r.client, { extensions: ["1", "2", "3", "4", "5", "6"] }),
    ).toThrow(/<=5 items/);
    expect(r.requests).toHaveLength(0);
  });

  test("browsers() rejects a bad option, never throws synchronously", async () => {
    const r = rig();
    await expect(r.client.browsers({ proxi: "x" } as never)).rejects.toThrow(/proxi/);
  });
});

describe("lease", () => {
  test("starts a browser, parks it, reuses it, stops it on close", async () => {
    const r = rig();
    const p = await pool(r, {
      concurrency: 1,
      blockResources: ["image"],
      proxy: { tier: "shared" },
    });
    const first = await p.lease(async (browser) => {
      expect(browser).toBeInstanceOf(Browser);
      expect(browser.connected).toBe(true);
      expect(browser.useCount).toBe(1);
      expect(browser.blockedResources).toEqual(new Set(["image"]));
      browser.data.seen = 1;
      return browser;
    });
    expect(r.starts()).toHaveLength(1);
    expect(r.starts()[0]?.body).toEqual({ proxy: { tier: "shared" } });
    const second = await p.lease(async (browser) => browser);
    expect(second).toBe(first);
    expect(second.useCount).toBe(2);
    expect(second.data).toEqual({ seen: 1 });
    expect(r.starts()).toHaveLength(1);
    expect(r.stops()).toHaveLength(0);
    await p.close();
    expect(r.stops().map((s) => s.path)).toEqual(["/profiles/sess-1/stop"]);
    expect(first.connected).toBe(false);
  });

  test("a retired browser is replaced after the lease", async () => {
    const r = rig();
    const p = await pool(r, { concurrency: 1 });
    const a = await p.lease(async (browser) => {
      browser.retire();
      return browser;
    });
    expect(r.stops().map((s) => s.path)).toEqual(["/profiles/sess-1/stop"]);
    const b = await p.lease(async (browser) => browser);
    expect(b).not.toBe(a);
    expect(b.internalUuid).toBe("sess-2");
    expect(r.starts()).toHaveLength(2);
  });

  test("a browser that stopped answering is recycled, not parked", async () => {
    vi.useFakeTimers();
    const r = rig();
    const p = await pool(r, { concurrency: 1 });
    const a = await p.lease(async (browser) => browser);
    r.chromes[0]?.hangs.add("Browser.getVersion"); // the socket went half-open
    expect(a.shouldRecycle).toBe(false); // `connected` on its own cannot tell
    const leasing = p.lease(async (browser) => browser.internalUuid);
    await vi.advanceTimersByTimeAsync(5_000); // the pool's cleanup cap
    expect(await leasing).toBe("sess-1"); // the handler still ran on it
    expect(r.warned[0]).toMatch(/could not clean up sess-1/);
    expect(r.stops().map((s) => s.path)).toEqual(["/profiles/sess-1/stop"]);
    expect(await p.lease(async (browser) => browser.internalUuid)).toBe("sess-2");
  });

  test("a dead idle browser is recycled on the next lease", async () => {
    const r = rig();
    const p = await pool(r, { concurrency: 1 });
    const a = await p.lease(async (browser) => browser);
    r.chromes[0]?.socket?.serverClose();
    expect(a.shouldRecycle).toBe(true);
    const b = await p.lease(async (browser) => browser);
    expect(b.internalUuid).toBe("sess-2");
    expect(r.stops().map((s) => s.path)).toEqual(["/profiles/sess-1/stop"]);
  });

  test("waits for a free browser instead of starting past capacity", async () => {
    const r = rig();
    const p = await pool(r, { concurrency: 1 });
    const order: string[] = [];
    const release = Promise.withResolvers<void>();
    const first = p.lease(async () => {
      order.push("first in");
      await release.promise;
      order.push("first out");
    });
    await settle();
    const second = p.lease(async () => {
      order.push("second in");
    });
    await settle();
    expect(order).toEqual(["first in"]);
    release.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first in", "first out", "second in"]);
    expect(r.starts()).toHaveLength(1);
  });

  test("the lease is cleaned up: extra pages closed, captures dropped, handler reset", async () => {
    const r = rig();
    const p = await pool(r, { concurrency: 1 });
    const page = await p.lease(async (browser) => {
      const page = await browser.newPage();
      await browser.captureResponses("/x");
      browser.onDialog = () => true;
      return page;
    });
    expect(page.closed).toBe(true);
    const browser = await p.lease(async (browser) => browser);
    expect(browser.pages).toHaveLength(1);
    expect(browser.onDialog).toBeNull();
    expect(browser.responses).toEqual([]);
  });

  test("a cleanup that fails retires the browser with a warning", async () => {
    const r = rig();
    const p = await pool(r, { concurrency: 1 });
    await p.lease(async (browser) => {
      await browser.captureResponses("/x");
      r.chromes[0]?.respond("Network.disable", () => ({ error: { message: "broken" } }));
    });
    expect(r.warned[0]).toMatch(/could not clean up sess-1: .*Network.disable: broken/);
    expect(r.stops()).toHaveLength(1);
    await p.lease(async (browser) => expect(browser.internalUuid).toBe("sess-2"));
  });

  test("the handler's error propagates and the browser is kept", async () => {
    const r = rig();
    const p = await pool(r, { concurrency: 1 });
    await expect(
      p.lease(async () => {
        throw new Error("handler broke");
      }),
    ).rejects.toThrow("handler broke");
    const browser = await p.lease(async (browser) => browser);
    expect(browser.internalUuid).toBe("sess-1");
    expect(r.stops()).toHaveLength(0);
  });
});

describe("plan limits", () => {
  const planFull = () => ({
    status: 429,
    json: { success: false, msg: "limit", code: "parallel_browsers_limit_reached" },
  });

  test("a full plan with a browser of ours is backpressure", async () => {
    let starts = 0;
    const r = rig({
      "POST /profiles/one_time": () => {
        starts += 1;
        return starts === 1
          ? ok({ internal_uuid: "sess-1", ws_url: "ws://fake/1" })
          : planFull();
      },
    });
    const p = await pool(r, { concurrency: 2 });
    const release = Promise.withResolvers<void>();
    const first = p.lease(async (browser) => {
      await release.promise;
      return browser;
    });
    await settle();
    const second = p.lease(async (browser) => browser);
    await settle(10);
    expect(starts).toBe(2);
    release.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(b).toBe(a);
    expect(starts).toBe(2); // 1 refusal is enough
  });

  test("a full plan with nothing of ours throws", async () => {
    const r = rig({ "POST /profiles/one_time": planFull });
    const p = await pool(r, { concurrency: 2 });
    const err = await p.lease(async () => 1).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.code).toBe("parallel_browsers_limit_reached");
    expect(r.starts()).toHaveLength(1);
    // and again on the next attempt, without a new request: the plan is still full
    await expect(p.lease(async () => 1)).rejects.toBe(err);
  });

  test("another start error is raised as is", async () => {
    const r = rig({
      "POST /profiles/one_time": () => ({ status: 402, json: { msg: "pay" } }),
    });
    const p = await pool(r, { concurrency: 1 });
    await expect(p.lease(async () => 1)).rejects.toThrow(/pay/);
  });

  test("a browser that cannot connect stops its session", async () => {
    const r = rig();
    const createWebSocket = (url: string) => {
      const chrome = new FakeChrome();
      chrome.respond("Target.setAutoAttach", () => ({ error: { message: "no" } }));
      return chrome.create(url);
    };
    open = await new BrowserPool(r.client, { createWebSocket, concurrency: 1 }).open();
    await expect(open.lease(async () => 1)).rejects.toThrow("no");
    expect(r.stops().map((s) => s.path)).toEqual(["/profiles/sess-1/stop"]);
  });
});

describe("map", () => {
  test("keeps input order, collects errors, respects capacity", async () => {
    const r = rig();
    const p = await pool(r, { concurrency: 2 });
    let running = 0;
    let peak = 0;
    const outcomes = await p.map(
      async (browser, item: number) => {
        running += 1;
        peak = Math.max(peak, running);
        await settle(2);
        running -= 1;
        if (item === 3) throw new Error(`bad ${item}`);
        return `${browser.internalUuid}:${item}`;
      },
      [1, 2, 3, 4, 5],
    );
    expect(outcomes.map((o) => o.index)).toEqual([0, 1, 2, 3, 4]);
    expect(outcomes.map((o) => o.item)).toEqual([1, 2, 3, 4, 5]);
    expect(outcomes.filter((o) => o.ok).map((o) => (o.ok ? o.value : ""))).toHaveLength(
      4,
    );
    const failed = outcomes[2];
    expect(failed?.ok).toBe(false);
    expect(failed && !failed.ok ? String(failed.error) : "").toBe("Error: bad 3");
    expect(peak).toBe(2);
    expect(r.starts()).toHaveLength(2);
  });

  test("StopRun ends the run after the current items", async () => {
    const r = rig();
    const p = await pool(r, { concurrency: 1 });
    const outcomes = await p.map(
      async (_browser, item: number) => {
        if (item === 2) throw new StopRun("enough");
        return item;
      },
      [1, 2, 3, 4],
    );
    expect(outcomes.map((o) => o.item)).toEqual([1, 2]);
    expect(outcomes[1]?.ok).toBe(false);
    expect(outcomes[1] && !outcomes[1].ok ? outcomes[1].error : null).toBeInstanceOf(
      StopRun,
    );
  });

  test("an empty run starts nothing", async () => {
    const r = rig();
    const p = await pool(r, { concurrency: 3 });
    expect(await p.map(async () => 1, [])).toEqual([]);
    expect(r.starts()).toHaveLength(0);
  });
});

describe("close with leases in flight", () => {
  test("a browser released after close is torn down, not parked", async () => {
    const r = rig();
    const p = await pool(r, { concurrency: 1 });
    const release = Promise.withResolvers<void>();
    const lease = p.lease(async (browser) => {
      await release.promise;
      return browser;
    });
    await settle();
    await p.close();
    expect(r.stops()).toHaveLength(0);
    release.resolve();
    const browser = await lease;
    expect(browser.connected).toBe(false);
    expect(r.stops().map((s) => s.path)).toEqual(["/profiles/sess-1/stop"]);
  });

  test("a lease queued on the semaphore does not start a browser after close", async () => {
    const r = rig();
    const p = await pool(r, { concurrency: 1 });
    const release = Promise.withResolvers<void>();
    const first = p.lease(async () => {
      await release.promise;
    });
    await settle();
    const queued = p.lease(async () => 1);
    await p.close();
    release.resolve();
    await first;
    await expect(queued).rejects.toThrow(/closed while waiting/);
    expect(r.starts()).toHaveLength(1);
    expect(r.stops()).toHaveLength(1);
  });
});
