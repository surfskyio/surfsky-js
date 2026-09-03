import { describe, expect, test } from "vitest";
import { BadRequestError, ValidationError } from "../src/errors.js";
import { ProxyCycle } from "../src/proxy.js";
import { ok, testClient } from "./helpers.js";

const session = { internal_uuid: "s1", ws_url: "ws://x" };

describe("start", () => {
  test("one-time posts the options and the resolved proxy", async () => {
    const { client, requests } = testClient([ok(session)]);
    const got = await client.profiles.startOneTime({
      proxy: new ProxyCycle(["http://a"]),
      fingerprint: { os: "win", cpu: undefined },
      browser_settings: { inactive_kill_timeout: 60 },
      extensions: ["e1"],
    });
    expect(got).toEqual(session);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.path).toBe("/profiles/one_time");
    expect(requests[0]?.body).toEqual({
      proxy: "http://a",
      fingerprint: { os: "win" },
      browser_settings: { inactive_kill_timeout: 60 },
      extensions: ["e1"],
    });
  });

  test("an async factory and a null proxy", async () => {
    const { client, requests } = testClient([ok(session), ok(session)]);
    await client.profiles.startOneTime({ proxy: async () => ({ country: "de" }) });
    expect(requests[0]?.body).toEqual({ proxy: { country: "de" } });
    await client.profiles.startOneTime({ proxy: null });
    expect(requests[1]?.body).toEqual({});
  });

  test("a typo never leaves the process", async () => {
    const { client, requests } = testClient([ok(session)]);
    await expect(
      client.profiles.startOneTime({ proxi: "http://a" } as never),
    ).rejects.toThrow(/Unrecognized key: "proxi"/);
    await expect(
      client.profiles.startOneTime({ extensions: ["1", "2", "3", "4", "5", "6"] }),
    ).rejects.toThrow(/<=5 items/);
    await expect(
      client.profiles.startOneTime({ proxy: { tier: "gold" } as never }),
    ).rejects.toThrow(/tier must be "shared" or "premium".*\n.*proxy\.tier/);
    await expect(
      client.profiles.startOneTime({ proxy: () => 42 as never }),
    ).rejects.toThrow(ValidationError);
    expect(requests).toHaveLength(0);
  });

  test("a profile start rejects one-time-only options", async () => {
    const { client, requests } = testClient([ok(session), ok(session)]);
    await expect(
      client.profiles.start("p1", { fingerprint: { os: "win" } }),
    ).rejects.toThrow(/fingerprint applies to one-time/);
    await expect(client.profiles.start("p1", { cookies: "x" })).rejects.toThrow(
      /cookies applies/,
    );
    await client.profiles.start("p1", { fingerprint: undefined, cookies: null as never });
    expect(requests[0]?.body).toEqual({}); // unset ones are fine
    await client.profiles.start("p 1", { proxy: "http://a", enable_chromedriver: true });
    expect(requests[1]?.path).toBe("/profiles/p%201/start");
    expect(requests[1]?.body).toEqual({ proxy: "http://a", enable_chromedriver: true });
  });
});

test("stop accepts a session or an id and parses an empty reply", async () => {
  const { client, requests } = testClient([ok({ uuid: "p" }), ok(null)]);
  expect(await client.profiles.stop(session)).toEqual({ uuid: "p" });
  expect(await client.profiles.stop("s2")).toBeNull();
  expect(requests.map((r) => r.path)).toEqual(["/profiles/s1/stop", "/profiles/s2/stop"]);
  await expect(client.profiles.stop("")).rejects.toThrow(/different endpoint/);
});

test("stopAll and listActive", async () => {
  const { client, requests } = testClient([ok({ stopped: ["a"], failed: [] }), ok(null)]);
  expect(await client.profiles.stopAll()).toEqual({ stopped: ["a"], failed: [] });
  expect(await client.profiles.listActive()).toEqual([]);
  expect(requests[0]?.method).toBe("POST");
  expect(requests[0]?.path).toBe("/profiles/stop");
  expect(requests[1]?.path).toBe("/profiles/active");
});

test("create resolves the proxy and drops empty fields", async () => {
  const { client, requests } = testClient([ok({ uuid: "p" })]);
  await client.profiles.create({
    title: "t",
    fingerprint: { os: "mac", os_arch: "arm", noise: null, cpu: undefined }, // as get() returns it
    proxy: { tier: "premium", country: "us" },
    storage_options: { cookies: true },
  });
  expect(requests[0]?.body).toEqual({
    title: "t",
    fingerprint: { os: "mac", os_arch: "arm" },
    proxy: { tier: "premium", country: "us" },
    storage_options: { cookies: true },
  });
});

describe("update", () => {
  test("sends explicit nulls and strips immutable fingerprint fields", async () => {
    const { client, requests } = testClient([ok({ uuid: "p" })]);
    await client.profiles.update("p", {
      title: "new",
      description: null,
      proxy: null,
      fingerprint: { os: "win", os_version: "11", cpu: 4, ram: undefined },
    });
    expect(requests[0]?.method).toBe("PATCH");
    expect(requests[0]?.path).toBe("/profiles/p");
    expect(requests[0]?.body).toEqual({
      title: "new",
      description: null,
      proxy: null,
      fingerprint: { cpu: 4 },
    });
  });

  test("resolves a proxy source and rejects a typo", async () => {
    const { client, requests } = testClient([ok({ uuid: "p" }), ok({ uuid: "p" })]);
    await client.profiles.update("p", { proxy: new ProxyCycle(["http://a"]) });
    expect(requests[0]?.body).toEqual({ proxy: "http://a" });
    await client.profiles.update("p", { proxy: () => null }); // a null pick clears it
    expect(requests[1]?.body).toEqual({ proxy: null });
    await expect(client.profiles.update("p", { titel: "x" } as never)).rejects.toThrow(
      /titel/,
    );
    // a null value used to slip the key past the parse and back onto the wire
    await expect(
      client.profiles.update("p", { descriptoin: null } as never),
    ).rejects.toThrow(/descriptoin/);
    await expect(client.profiles.update("p", { title: null } as never)).rejects.toThrow(
      /title/,
    );
  });
});

test("get, delete, deleteMany", async () => {
  const partial = {
    status: 400,
    json: {
      success: false,
      msg: "some active",
      data: { deleted_uuids: ["a"], active_uuids: ["b"] },
    },
  };
  const { client, requests } = testClient([
    ok({ uuid: "p" }),
    ok({ uuid: "p" }),
    partial,
    { status: 400, json: { msg: "bad" } },
  ]);
  expect(await client.profiles.get("p")).toEqual({ uuid: "p" });
  expect(await client.profiles.delete("p")).toEqual({ uuid: "p" });
  expect(await client.profiles.deleteMany(["a", "b"])).toEqual({
    deleted_uuids: ["a"],
    active_uuids: ["b"],
  });
  expect(requests[2]?.method).toBe("DELETE");
  expect(requests[2]?.body).toEqual({ uuids: ["a", "b"] });
  await expect(client.profiles.deleteMany(["c"])).rejects.toBeInstanceOf(BadRequestError);
});

describe("listing", () => {
  test("listPage passes only the given params", async () => {
    const { client, requests } = testClient([ok([{ uuid: "a" }]), ok(null)]);
    expect(await client.profiles.listPage({ page: 2, ordering: "-title" })).toEqual([
      { uuid: "a" },
    ]);
    expect(requests[0]?.path).toBe("/profiles?page=2&ordering=-title");
    expect(await client.profiles.listPage()).toEqual([]);
    expect(requests[1]?.path).toBe("/profiles");
    await expect(client.profiles.listPage({ page_length: 2 } as never)).rejects.toThrow(
      /page_length/,
    );
  });

  test("iterAll walks pages until a short one and clamps page_len", async () => {
    const { client, requests } = testClient([
      ok([{ uuid: "a" }, { uuid: "b" }]),
      ok([{ uuid: "c" }]),
    ]);
    const seen: string[] = [];
    for await (const profile of client.profiles.iterAll({ page_len: 2 }))
      seen.push(profile.uuid);
    expect(seen).toEqual(["a", "b", "c"]);
    expect(requests.map((r) => r.path)).toEqual([
      "/profiles?page=0&page_len=2&ordering=created",
      "/profiles?page=1&page_len=2&ordering=created",
    ]);
    const { client: c2, requests: r2 } = testClient([ok([])]);
    for await (const _ of c2.profiles.iterAll({ page_len: 500, ordering: "-active" }))
      void _;
    expect(r2[0]?.path).toBe("/profiles?page=0&page_len=100&ordering=-active");
  });
});

describe("cookies", () => {
  test("export json and netscape", async () => {
    const cookies = [{ name: "a", value: "1", domain: "x.test" }];
    const { client, requests } = testClient([
      ok({ cookies }),
      ok({ cookies: "# Netscape\n" }),
      ok({}),
    ]);
    expect(await client.profiles.exportCookies("p")).toEqual(cookies);
    expect(requests[0]?.path).toBe("/profiles/p/cookies?export_format=json");
    expect(await client.profiles.exportCookies("p", { export_format: "netscape" })).toBe(
      "# Netscape\n",
    );
    expect(await client.profiles.exportCookies("p")).toEqual([]);
  });

  test("import serialises models and passes text through", async () => {
    const { client, requests } = testClient([ok(null), ok(null)]);
    await client.profiles.importCookies("p", [
      { name: "a", value: "1", httpOnly: undefined },
    ]);
    expect(requests[0]?.body).toEqual({ cookies: '[{"name":"a","value":"1"}]' });
    await client.profiles.importCookies("p", "# text");
    expect(requests[1]?.body).toEqual({ cookies: "# text" });
  });
});

test("scrape validates, posts and uses the long timeout", async () => {
  const { client, requests } = testClient([ok({ url: "https://x", status: 200 })]);
  const got = await client.profiles.scrape(session, "https://x", {
    screenshot: true,
    wait: 5,
  });
  expect(got.status).toBe(200);
  expect(requests[0]?.path).toBe("/profiles/s1/scrape");
  expect(requests[0]?.body).toEqual({ url: "https://x", screenshot: true, wait: 5 });
  await expect(client.profiles.scrape("s1", "https://x", { wait: 61 })).rejects.toThrow(
    ValidationError,
  );
});
