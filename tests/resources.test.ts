import { afterEach, describe, expect, test } from "vitest";
import { ok, testClient } from "./helpers.js";

describe("proxies", () => {
  test("paths and parsing", async () => {
    const { client, requests } = testClient([
      ok([{ code: "us" }]),
      ok([{ code: "ca" }]),
      ok(null),
      ok({ remaining_gb: 1 }),
      ok({ "24h": { bytes: 1 } }),
      ok(["us"]),
      ok({ limit_gb: -1 }),
      ok({}),
    ]);
    expect(await client.proxies.countries()).toEqual([{ code: "us" }]);
    expect(await client.proxies.regions("US/CA")).toEqual([{ code: "ca" }]);
    expect(await client.proxies.cities("us", "ca")).toEqual([]);
    expect(await client.proxies.quota()).toEqual({ remaining_gb: 1 });
    expect((await client.proxies.premiumStats())["24h"]).toEqual({ bytes: 1 });
    expect(await client.proxies.sharedCountries()).toEqual(["us"]);
    expect(await client.proxies.sharedQuota()).toEqual({ limit_gb: -1 });
    expect(await client.proxies.sharedStats()).toEqual({});
    expect(requests.map((r) => r.path)).toEqual([
      "/proxies/countries",
      "/proxies/regions/US%2FCA",
      "/proxies/cities/us/ca",
      "/proxies/quota",
      "/proxies/premium/stats",
      "/proxies/shared/countries",
      "/proxies/shared/quota",
      "/proxies/shared/stats",
    ]);
  });
});

describe("fingerprints", () => {
  test("query params", async () => {
    const { client, requests } = testClient([
      ok([{ value: "r" }]),
      ok([]),
      ok([{ value: "m" }]),
    ]);
    expect(await client.fingerprints.renderers("win", "x86")).toEqual([{ value: "r" }]);
    expect(await client.fingerprints.screens("mac", "arm")).toEqual([]);
    expect(
      await client.fingerprints.deviceModels({ os: "android", device_type: "phone" }),
    ).toEqual([{ value: "m" }]);
    expect(requests.map((r) => r.path)).toEqual([
      "/fingerprint/renderers?os=win&os_arch=x86",
      "/fingerprint/screens?os=mac&os_arch=arm",
      "/fingerprint/device_models?os=android&device_type=phone",
    ]);
  });
});

describe("extensions", () => {
  test("upload sends multipart from bytes, a blob and a path", async () => {
    const { client, requests } = testClient([
      ok({ uuid: "e" }),
      ok({ uuid: "e" }),
      ok({ uuid: "e" }),
    ]);
    await client.extensions.upload(new Uint8Array([1, 2]), "bytes");
    await client.extensions.upload(new File([new Uint8Array([3])], "my.zip"), "blob");
    await client.extensions.upload(
      new URL("../package.json", import.meta.url).pathname,
      "path",
    );
    for (const [i, expected] of [
      ["extension.zip", "bytes"],
      ["my.zip", "blob"],
      ["package.json", "path"],
    ].entries()) {
      const body = requests[i]?.body as FormData;
      expect(body).toBeInstanceOf(FormData);
      expect((body.get("file") as File).name).toBe(expected[0]);
      expect(body.get("name")).toBe(expected[1]);
      expect(requests[i]?.headers["content-type"]).toBeUndefined(); // fetch sets the boundary
    }
    expect(requests[0]?.path).toBe("/extensions");
  });

  test("list, get, update, delete", async () => {
    const { client, requests } = testClient([
      ok({ extensions: [{ uuid: "e" }], count: 1 }),
      ok({ uuid: "e" }),
      ok({ uuid: "e", name: "n" }),
      ok(null),
      ok(null),
    ]);
    expect(await client.extensions.listAll()).toEqual([{ uuid: "e" }]);
    expect(await client.extensions.get("e")).toEqual({ uuid: "e" });
    expect(await client.extensions.update("e", { name: "n" })).toEqual({
      uuid: "e",
      name: "n",
    });
    expect(await client.extensions.delete("e")).toBeUndefined();
    expect(await client.extensions.listAll()).toEqual([]);
    expect(requests.slice(0, 4).map((r) => [r.method, r.path])).toEqual([
      ["GET", "/extensions"],
      ["GET", "/extensions/e"],
      ["PATCH", "/extensions/e"],
      ["DELETE", "/extensions/e"],
    ]);
    expect(requests[2]?.body).toEqual({ name: "n" });
  });
});

describe("account", () => {
  const saved = process.env.SURFSKY_MAX_BROWSERS;
  afterEach(() => {
    if (saved === undefined) delete process.env.SURFSKY_MAX_BROWSERS;
    else process.env.SURFSKY_MAX_BROWSERS = saved;
  });

  test("limits", async () => {
    const { client, requests } = testClient([
      ok({ spm: 5 }),
      ok({ parallel_browsers: 3 }),
    ]);
    expect(await client.account.sessionLimits()).toEqual({ spm: 5 });
    expect(await client.account.browserLimits()).toEqual({ parallel_browsers: 3 });
    expect(requests.map((r) => r.path)).toEqual([
      "/users/session-limits",
      "/users/browser-limits",
    ]);
  });

  test("maxBrowsers: env, then the plan, then the default", async () => {
    delete process.env.SURFSKY_MAX_BROWSERS;
    const { client } = testClient([
      ok({ parallel_browsers: 3 }),
      ok({}),
      { status: 404, json: { msg: "x" } },
      ok({ parallel_browsers: 0 }),
    ]);
    expect(await client.account.maxBrowsers()).toBe(3);
    expect(await client.account.maxBrowsers()).toBe(10);
    expect(await client.account.maxBrowsers()).toBe(10);
    expect(await client.account.maxBrowsers()).toBe(10); // a 0 from the server means unknown
    process.env.SURFSKY_MAX_BROWSERS = "0";
    expect(await client.account.maxBrowsers()).toBe(1);
    process.env.SURFSKY_MAX_BROWSERS = "7";
    expect(await client.account.maxBrowsers()).toBe(7);
  });
});
