import { describe, expect, test } from "vitest";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  BrowserTimeoutError,
  CDPError,
  ConfigurationError,
  NotFoundError,
  PageClosedError,
  RateLimitError,
  SurfskyError,
  ValidationError,
} from "../src/errors.js";
import type { Fingerprint, StorageOptions } from "../src/types.js";
import {
  parseOneTimeStartRequest,
  parseProfileCreateRequest,
  parseProfileStartRequest,
  parseProfileUpdateRequest,
  parseProxyLike,
  parseScrapeRequest,
} from "../src/types.js";

describe("errors", () => {
  test("hierarchy and names", () => {
    const err = new NotFoundError("GET /x: nope", {
      statusCode: 404,
      body: { code: "gone" },
    });
    expect(err).toBeInstanceOf(APIError);
    expect(err).toBeInstanceOf(SurfskyError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("NotFoundError");
    expect(err.code).toBe("gone");
    expect(String(err)).toBe("[404] GET /x: nope");
    expect(new ConfigurationError("x").name).toBe("ConfigurationError");
    expect(new APITimeoutError("t")).toBeInstanceOf(APIConnectionError);
    expect(String(new APITimeoutError("t"))).toBe("t");
    expect(new CDPError("c", { code: -32000 }).code).toBe(-32000);
    expect(new BrowserTimeoutError("b")).toBeInstanceOf(SurfskyError);
    expect(new PageClosedError("p")).toBeInstanceOf(SurfskyError);
  });

  test("retryAfter and cause", () => {
    const cause = new Error("boom");
    const err = new RateLimitError("r", { retryAfter: 1500, cause });
    expect(err.retryAfter).toBe(1500);
    expect(err.cause).toBe(cause);
  });
});

describe("proxy selectors", () => {
  test("accepts urls and selectors", () => {
    expect(parseProxyLike("http://u:p@h:1")).toBe("http://u:p@h:1");
    expect(parseProxyLike({ tier: "shared", country: "us" })).toEqual({
      tier: "shared",
      country: "us",
    });
    expect(
      parseProxyLike({ tier: "premium", country: "us", region: "ny", city: "nyc" }),
    ).toEqual({
      tier: "premium",
      country: "us",
      region: "ny",
      city: "nyc",
    });
    expect(parseProxyLike({ lat: 1, lon: 2 })).toEqual({ lat: 1, lon: 2 });
    expect(parseProxyLike({ pool: "europe", type: "mobile" })).toEqual({
      pool: "europe",
      type: "mobile",
    });
  });

  test("rejects mixed modes and dangling parts, with the field named", () => {
    expect(() => parseProxyLike({ pool: "europe", country: "us" })).toThrow(/3 separate/);
    expect(() => parseProxyLike({ lat: 1 })).toThrow(/sent together/);
    expect(() => parseProxyLike({ region: "ny" })).toThrow(/requires country/);
    expect(() => parseProxyLike({ country: "us", city: "nyc" })).toThrow(
      /requires region/,
    );
    expect(() => parseProxyLike({ asn: 1 })).toThrow(/requires country/);
    expect(() => parseProxyLike({ country: "us", asn: 0 })).toThrow(/asn/);
    expect(() => parseProxyLike({ lat: 91, lon: 0 })).toThrow(/lat/);
    expect(() => parseProxyLike({ session_minutes: 0 })).toThrow(/session_minutes/);
  });

  test("rejects typos, bad tiers and garbage", () => {
    const typo = () => parseProxyLike({ tier: "shared", contry: "us" });
    expect(typo).toThrow(SurfskyError);
    expect(typo).toThrow(/Unrecognized key: "contry"/);
    expect(typo).toThrow(
      expect.objectContaining({
        issues: [expect.objectContaining({ message: expect.stringMatching(/contry/) })],
      }),
    );
    expect(() => parseProxyLike({ tier: "shared", region: "ny" })).toThrow(
      /Unrecognized key: "region"/,
    );
    expect(() => parseProxyLike({ tier: "gold" })).toThrow(
      /^proxy: ✖ tier must be "shared" or "premium"\n {2}→ at tier$/,
    );
    expect(() => parseProxyLike(42)).toThrow(/expected object, received number/);
    expect(() => parseProxyLike(null, "ProxyCycle")).toThrow(/^ProxyCycle: /);
    // its fields live on the prototype: it would pass as an empty selector
    expect(() => parseProxyLike(new URL("http://u:p@gate:7000"))).toThrow(
      /plain selector object/,
    );
  });

  test("an empty targeting value is not an unset one", () => {
    expect(() => parseProxyLike({ pool: "asia", city: "" })).toThrow(/3 separate/);
    expect(() => parseProxyLike({ pool: "europe", country: "" })).toThrow(/3 separate/);
  });
});

describe("session start requests", () => {
  test("keeps what is given and drops undefined and null at every depth", () => {
    expect(
      parseOneTimeStartRequest({
        fingerprint: { os: "win", cpu: undefined, noise: null, custom: 1 },
        proxy: "http://a",
        browser_settings: { inactive_kill_timeout: 60 },
        extensions: ["e"],
        cookies: "x",
        enable_chromedriver: undefined,
      }),
    ).toEqual({
      fingerprint: { os: "win", custom: 1 },
      proxy: "http://a",
      browser_settings: { inactive_kill_timeout: 60 },
      extensions: ["e"],
      cookies: "x",
    });
  });

  test("a typo is named whatever its value is", () => {
    // dropping nulls before the parse would have taken the unknown key with them
    expect(() => parseOneTimeStartRequest({ proxi: null })).toThrow(/"proxi"/);
    expect(() => parseScrapeRequest({ url: "u", wiat: null })).toThrow(/"wiat"/);
    expect(() => parseProxyLike({ tier: "shared", contry: null })).toThrow(/"contry"/);
  });

  test("a fingerprint the server handed back goes straight back in", () => {
    expect(
      parseProfileUpdateRequest({
        fingerprint: {
          geolocation: { latitude: 52.5, longitude: 13.4, accuracy: null },
          languages: null,
        },
      }),
    ).toEqual({ fingerprint: { geolocation: { latitude: 52.5, longitude: 13.4 } } });
  });

  test("names the typo, the limit and the nested field", () => {
    expect(() => parseOneTimeStartRequest({ proxi: 1 })).toThrow(
      'start_one_time: ✖ Unrecognized key: "proxi"',
    );
    expect(() => parseOneTimeStartRequest({ proxi: 1 })).toThrow(ValidationError);
    expect(() =>
      parseOneTimeStartRequest({ extensions: ["1", "2", "3", "4", "5", "6"] }),
    ).toThrow(/<=5 items/);
    expect(() => parseOneTimeStartRequest({ browser_settings: { cache: true } })).toThrow(
      /"cache".*\n.*browser_settings/,
    );
    expect(() =>
      parseOneTimeStartRequest({ domain_routes: [{ domain: ["a"] }] }),
    ).toThrow(/domain_routes\[0\]\.proxy/);
    expect(() => parseOneTimeStartRequest({ proxy: { tier: "gold" } })).toThrow(
      /proxy\.tier/,
    );
    expect(() => parseProfileStartRequest({ fingerprint: {} })).toThrow(
      /fingerprint applies to one-time sessions only/,
    );
    expect(() => parseProfileStartRequest({ fingerprint: {} })).toThrow(ValidationError);
    expect(() => parseOneTimeStartRequest({ cookies: 42 })).toThrow(
      /expected a cookie string or an array of cookie objects/,
    );
  });
});

test("update strips the immutable fingerprint fields", () => {
  expect(
    parseProfileUpdateRequest({
      title: "t",
      fingerprint: { os: "win", os_arch: "x86", cpu: 4, custom: 1 },
    }),
  ).toEqual({ title: "t", fingerprint: { cpu: 4, custom: 1 } });
  expect(() => parseProfileUpdateRequest({ titel: "x" })).toThrow(/titel/);
});

// the schemas are loose so a server field round-trips; the types must not be,
// or a typo compiles and the server quietly ignores it on a paid session
test("a model type is closed even though its schema is not", () => {
  const fingerprint: Fingerprint = { os: "win", noise: { webgl: true } };
  // @ts-expect-error os_arh is not a fingerprint field
  const typo: Fingerprint = { os_arh: "x86" };
  // @ts-expect-error nor is webgll one of noise's, one level down
  const nested: Fingerprint = { noise: { webgll: true } };
  // @ts-expect-error nor is cookiez a storage option
  const storage: StorageOptions = { cookiez: true };
  expect(
    parseProfileCreateRequest({ title: "t", fingerprint, storage_options: storage }),
  ).toEqual({
    title: "t",
    fingerprint: { os: "win", noise: { webgl: true } },
    storage_options: { cookiez: true }, // still passed through at runtime
  });
  expect([typo, nested]).toHaveLength(2);
});

test("scrape ranges", () => {
  expect(() => parseScrapeRequest({ url: "u", wait: 61 })).toThrow(/wait/);
  expect(() => parseScrapeRequest({ url: "u", human_actions: 4 })).toThrow(
    /human_actions/,
  );
  expect(parseScrapeRequest({ url: "u", wait: 60, human_actions: 3 })).toEqual({
    url: "u",
    wait: 60,
    human_actions: 3,
  });
});
