import { describe, expect, test } from "vitest";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  RateLimitError,
  ServerError,
  SharedTrafficLimitError,
} from "../src/errors.js";
import type { Logger, SendOptions, Spec } from "../src/transport.js";
import {
  buildUrl,
  makeLogger,
  ref,
  result,
  retryAfterMs,
  send,
} from "../src/transport.js";
import { connectError, fakeFetch, ok } from "./helpers.js";

function options(
  fetch: typeof globalThis.fetch,
  over: Partial<SendOptions> = {},
): SendOptions {
  return {
    fetch,
    baseUrl: "https://api.test",
    headers: { "X-Cloud-Api-Token": "t" },
    retries: 3,
    backoff: 0,
    timeout: 5000,
    logger: makeLogger(null),
    sleep: async () => {},
    random: () => 0,
    ...over,
  };
}

const active: Spec<unknown[]> = { method: "GET", path: "/profiles/active" };

async function call<T>(spec: Spec<T>, o: SendOptions): Promise<T> {
  return result(spec, await send(spec, o));
}

describe("retryAfterMs", () => {
  test("seconds", () => {
    expect(retryAfterMs(new Response("", { headers: { "Retry-After": "7" } }))).toBe(
      7000,
    );
    expect(retryAfterMs(new Response(""))).toBeUndefined();
    expect(retryAfterMs(new Response("", { headers: { "Retry-After": "999" } }))).toBe(
      999_000,
    );
  });

  test("http date, -0000 means UTC", () => {
    const when = new Date(Date.now() + 60_000);
    for (const zone of ["GMT", "-0000"]) {
      const header = when.toUTCString().replace("GMT", zone);
      const delay = retryAfterMs(
        new Response("", { headers: { "Retry-After": header } }),
      );
      expect(delay).toBeGreaterThanOrEqual(50_000);
      expect(delay).toBeLessThanOrEqual(70_000);
    }
    expect(
      retryAfterMs(new Response("", { headers: { "Retry-After": "soon" } })),
    ).toBeUndefined();
  });
});

describe("retries", () => {
  test("429 then 200", async () => {
    const f = fakeFetch([{ status: 429, json: { success: false, msg: "rate" } }, ok([])]);
    expect(await call(active, options(f.fetch))).toEqual([]);
    expect(f.requests).toHaveLength(2);
  });

  test("500 four times then ServerError", async () => {
    const f = fakeFetch(
      Array(4).fill({ status: 500, json: { success: false, msg: "boom" } }),
    );
    await expect(call(active, options(f.fetch))).rejects.toBeInstanceOf(ServerError);
    expect(f.requests).toHaveLength(4);
  });

  test("Retry-After wins over backoff and is logged", async () => {
    const slept: number[] = [];
    const warned: string[] = [];
    const logger: Logger = { ...makeLogger(null), warn: (m) => warned.push(m) };
    const f = fakeFetch([
      { status: 503, headers: { "Retry-After": "2" } },
      { status: 503, headers: { "Retry-After": "999" } },
      { status: 503 },
      ok([]),
    ]);
    await call(
      active,
      options(f.fetch, {
        backoff: 100,
        sleep: async (ms) => void slept.push(ms),
        logger,
      }),
    );
    expect(slept).toEqual([2000, 30_000, 400]); // hint, capped hint, 100 * 2^2 + 0 jitter
    expect(warned[0]).toBe("GET /profiles/active -> 503, retry in 2.0s");
  });

  test("quota and plan-full 429s never retry", async () => {
    for (const code of [
      "shared_traffic_limit_reached",
      "parallel_browsers_limit_reached",
    ]) {
      const f = fakeFetch([{ status: 429, json: { success: false, msg: "no", code } }]);
      const err = await call(active, options(f.fetch)).catch((e) => e);
      expect(err).toBeInstanceOf(
        RateLimitError.prototype.constructor === err.constructor
          ? RateLimitError
          : APIError,
      );
      expect(err.code).toBe(code);
      expect(f.requests).toHaveLength(1);
    }
    const f = fakeFetch([
      { status: 429, json: { code: "shared_traffic_limit_reached" } },
    ]);
    await expect(call(active, options(f.fetch))).rejects.toBeInstanceOf(
      SharedTrafficLimitError,
    );
  });

  test("POST retries on 429 but not on 500", async () => {
    const post: Spec<unknown> = { method: "POST", path: "/profiles/one_time", json: {} };
    let f = fakeFetch([{ status: 429 }, ok({ internal_uuid: "s", ws_url: "ws://x" })]);
    expect(await call(post, options(f.fetch))).toEqual({
      internal_uuid: "s",
      ws_url: "ws://x",
    });
    expect(f.requests).toHaveLength(2);
    f = fakeFetch([{ status: 500, json: { success: false, msg: "boom" } }]);
    await expect(call(post, options(f.fetch))).rejects.toBeInstanceOf(ServerError);
    expect(f.requests).toHaveLength(1);
  });

  test("POST retries a connect-phase failure, not a lost reply", async () => {
    const post: Spec<unknown> = { method: "POST", path: "/profiles/one_time", json: {} };
    let f = fakeFetch([
      { throws: connectError("ECONNREFUSED") },
      ok({ internal_uuid: "s" }),
    ]);
    expect(await call(post, options(f.fetch))).toEqual({ internal_uuid: "s" });
    expect(f.requests).toHaveLength(2);
    f = fakeFetch([{ throws: connectError("ECONNRESET") }]);
    await expect(call(post, options(f.fetch))).rejects.toBeInstanceOf(APIConnectionError);
    expect(f.requests).toHaveLength(1);
  });

  test("GET retries any network error, then reports the last one", async () => {
    const f = fakeFetch([
      { throws: connectError("ECONNRESET") },
      { throws: new DOMException("timed out", "TimeoutError") },
    ]);
    const err = await call(active, options(f.fetch, { retries: 1 })).catch((e) => e);
    expect(err).toBeInstanceOf(APITimeoutError);
    expect(err.message).toBe("request to /profiles/active timed out");
    expect(f.requests).toHaveLength(2);
  });

  test("a per-attempt timeout signal is passed to fetch", async () => {
    const f = fakeFetch([ok([])]);
    await call(active, options(f.fetch, { timeout: 1234 }));
    expect(f.requests[0]?.signal).toBeInstanceOf(AbortSignal);
    const g = fakeFetch([ok([])]);
    await call({ ...active, timeout: 0 }, options(g.fetch));
    expect(g.requests[0]?.signal).toBeUndefined();
  });
});

describe("error mapping", () => {
  test.each([
    [401, AuthenticationError],
    [404, NotFoundError],
    [429, RateLimitError],
    [400, BadRequestError],
    [422, BadRequestError],
    [503, ServerError],
    [418, APIError],
  ])("%s", async (status, cls) => {
    const f = fakeFetch([
      { status, json: { success: false, msg: "nope" }, headers: { "cf-ray": "r1" } },
    ]);
    const err = await call(active, options(f.fetch, { retries: 0 })).catch((e) => e);
    expect(err).toBeInstanceOf(cls);
    expect(err.statusCode).toBe(status);
    expect(err.message).toBe("GET /profiles/active: nope");
    expect(err.requestId).toBe("r1");
    expect(err.headers["cf-ray"]).toBe("r1");
  });

  test("validation errors are flattened into the message", async () => {
    const body = {
      success: false,
      msg: "Validation error",
      data: {
        errors: [
          { loc: ["body", "proxy"], msg: "bad url" },
          { loc: ["query", "page"], msg: "int" },
        ],
      },
    };
    const f = fakeFetch([{ status: 422, json: body }]);
    const err = await call(active, options(f.fetch)).catch((e) => e);
    expect(err.message).toBe(
      "GET /profiles/active: Validation error: body.proxy: bad url; query.page: int",
    );
    const g = fakeFetch([
      { status: 400, json: { msg: "no", errors: { title: "required" } } },
    ]);
    const err2 = await call(active, options(g.fetch)).catch((e) => e);
    expect(err2.message).toBe("GET /profiles/active: no: title: required");
  });

  test("a 422 rejecting the token header is an AuthenticationError", async () => {
    const body = {
      msg: "bad",
      data: { errors: [{ loc: ["header", "x-cloud-api-token"], msg: "field required" }] },
    };
    const f = fakeFetch([{ status: 422, json: body }]);
    await expect(call(active, options(f.fetch))).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  test("RateLimitError carries retryAfter in ms", async () => {
    const f = fakeFetch([
      { status: 429, json: { msg: "slow" }, headers: { "Retry-After": "3" } },
    ]);
    const err = await call(active, options(f.fetch, { retries: 0 })).catch((e) => e);
    expect(err.retryAfter).toBe(3000);
  });

  test("text and empty bodies", async () => {
    let f = fakeFetch([{ status: 502, text: "<html>bad gateway</html>" }]);
    let err = await call(active, options(f.fetch, { retries: 0 })).catch((e) => e);
    expect(err.message).toBe("GET /profiles/active: <html>bad gateway</html>");
    f = fakeFetch([{ status: 500 }]);
    err = await call(active, options(f.fetch, { retries: 0 })).catch((e) => e);
    expect(err.message).toBe("GET /profiles/active: HTTP 500");
    expect(err.body).toBeNull();
  });
});

describe("result", () => {
  test("unwraps the envelope and parses", async () => {
    const spec: Spec<number> = {
      method: "GET",
      path: "/x",
      parse: (d) => (d as number[]).length,
    };
    expect(
      await result(spec, new Response(JSON.stringify({ success: true, data: [1, 2] }))),
    ).toBe(2);
    expect(
      await result({ method: "GET", path: "/x" }, new Response(JSON.stringify({ a: 1 }))),
    ).toEqual({ a: 1 });
  });

  test("success:false with data is an APIError", async () => {
    const response = new Response(
      JSON.stringify({ success: false, msg: "nope", data: null }),
    );
    await expect(result({ method: "GET", path: "/x" }, response)).rejects.toThrow("nope");
  });

  test("acceptError lets a partial 400 through", async () => {
    const spec: Spec<unknown> = {
      method: "DELETE",
      path: "/profiles",
      acceptError: (status, body) => status === 400 && typeof body === "object",
    };
    const body = { success: false, msg: "partial", data: { deleted_uuids: ["a"] } };
    expect(
      await result(spec, new Response(JSON.stringify(body), { status: 400 })),
    ).toEqual({ deleted_uuids: ["a"] });
  });

  test("a parse failure is an APIError with the status", async () => {
    const spec: Spec<string> = {
      method: "GET",
      path: "/x",
      parse: (d) => (d as { a: { b: string } }).a.b,
    };
    const err = await result(spec, new Response("null")).catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    expect(err.message).toMatch(/^unexpected response from GET \/x: TypeError/);
    expect(err.statusCode).toBe(200);
  });
});

test("ref escapes ids and rejects the dangerous ones", () => {
  expect(ref("a b/c")).toBe("a%20b%2Fc");
  expect(() => ref("")).toThrow(/different endpoint/);
  expect(() => ref(".")).toThrow(/not a path segment/);
  expect(() => ref("..")).toThrow(/not a path segment/);
});

test("buildUrl skips undefined params", () => {
  expect(
    buildUrl("https://api.test", "/profiles", { page: 1, ordering: undefined, x: false }),
  ).toBe("https://api.test/profiles?page=1&x=false");
});

test("json bodies set the content type and are sent as given", async () => {
  const f = fakeFetch([ok(null)]);
  await send({ method: "POST", path: "/x", json: { a: 1 } }, options(f.fetch));
  expect(f.requests[0]?.headers["content-type"]).toBe("application/json");
  expect(f.requests[0]?.body).toEqual({ a: 1 });
  expect(f.requests[0]?.headers["x-cloud-api-token"]).toBe("t");
});

test("makeLogger defaults", () => {
  const silent = makeLogger(null);
  expect(() => silent.warn("x")).not.toThrow();
  const custom = makeLogger({ debug: () => {} });
  expect(custom.warn).toBeTypeOf("function");
});

describe("review follow-ups", () => {
  test("a connect timeout is an APITimeoutError", async () => {
    const f = fakeFetch([{ throws: connectError("UND_ERR_CONNECT_TIMEOUT") }]);
    const err = await call(active, options(f.fetch, { retries: 0 })).catch((e) => e);
    expect(err).toBeInstanceOf(APITimeoutError);
  });

  test("a bad argument is not retried and not wrapped", async () => {
    const f = fakeFetch(Array(4).fill({ throws: new TypeError("invalid header value") }));
    const err = await call(active, options(f.fetch)).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toBe("invalid header value");
    expect(f.requests).toHaveLength(1);
  });
});
