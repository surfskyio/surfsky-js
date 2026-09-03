import { describe, expect, test } from "vitest";
import { ProxyCycle, ProxyRandom, ProxyTemplate, resolveProxy } from "../src/proxy.js";

describe("ProxyCycle", () => {
  test("wraps around", () => {
    const cycle = new ProxyCycle(["http://a", "http://b"]);
    expect([cycle.pick(), cycle.pick(), cycle.pick()]).toEqual([
      "http://a",
      "http://b",
      "http://a",
    ]);
  });

  test("rejects a bare string and an empty list", () => {
    expect(() => new ProxyCycle("http://a" as never)).toThrow(/not a single URL/);
    expect(() => new ProxyCycle([])).toThrow(/at least one/);
    expect(() => new ProxyCycle([{ tier: "shared", contry: "us" } as never])).toThrow(
      /contry/,
    );
    expect(() => new ProxyCycle([new URL("http://a") as never])).toThrow(
      /plain selector object/,
    );
  });

  test("keeps the caller's own selectors", () => {
    const selector = { tier: "premium", country: "us" } as const;
    const cycle = new ProxyCycle([selector]);
    expect(cycle.proxies[0]).toBe(selector); // `proxies` is public: identity holds
  });
});

test("ProxyRandom picks from the list", () => {
  const random = new ProxyRandom(["http://a", { tier: "shared", country: "us" }]);
  for (let i = 0; i < 20; i++) expect(random.proxies).toContain(random.pick());
});

describe("ProxyTemplate", () => {
  test("substitutes session and counter, escapes braces", () => {
    const template = new ProxyTemplate("http://u-{session}-{n}:p@h:1/{{x}}");
    const first = template.pick();
    const second = template.pick();
    expect(first).toMatch(/^http:\/\/u-[0-9a-f]{12}-0:p@h:1\/\{x\}$/);
    expect(second).toMatch(/-1:p@h:1\/\{x\}$/);
    expect(first.slice(9, 21)).not.toBe(second.slice(9, 21));
  });

  test("rejects an unknown placeholder", () => {
    expect(() => new ProxyTemplate("http://{nope}")).toThrow(/unknown placeholder.*nope/);
    expect(() => new ProxyTemplate("http://{}")).toThrow(/unknown placeholder/);
  });
});

describe("resolveProxy", () => {
  test("passes plain values through", async () => {
    expect(await resolveProxy(undefined)).toBeUndefined();
    expect(await resolveProxy(null)).toBeNull();
    expect(await resolveProxy("http://a")).toBe("http://a");
    expect(await resolveProxy({ tier: "premium", country: "us" })).toEqual({
      tier: "premium",
      country: "us",
    });
  });

  test("awaits sources and factories", async () => {
    expect(await resolveProxy(new ProxyCycle(["http://a"]))).toBe("http://a");
    expect(await resolveProxy(() => "http://sync")).toBe("http://sync");
    expect(await resolveProxy(async () => ({ country: "de" }))).toEqual({
      country: "de",
    });
    expect(await resolveProxy(async () => null)).toBeNull();
  });

  test("passes garbage through for the request parse to name", async () => {
    expect(await resolveProxy(42 as never)).toBe(42);
  });
});
