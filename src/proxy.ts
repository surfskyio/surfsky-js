import type { ProxyLike } from "./types.js";
import { isRecord, parseProxyLike } from "./types.js";

export interface ProxySource {
  pick(): ProxyLike | null | Promise<ProxyLike | null>;
}

export type ProxyFactory = () => ProxyLike | null | Promise<ProxyLike | null>;
export type ProxyInput = ProxyLike | ProxySource | ProxyFactory;

function proxyList(proxies: Iterable<ProxyLike>, owner: string): ProxyLike[] {
  if (typeof proxies === "string") {
    throw new TypeError(`${owner} takes an iterable of proxies, not a single URL`);
  }
  const list = [...proxies];
  if (list.length === 0) throw new RangeError(`${owner} needs at least one proxy`);
  for (const proxy of list) parseProxyLike(proxy, owner);
  return list;
}

/** Round-robin over a list. */
export class ProxyCycle implements ProxySource {
  readonly proxies: ProxyLike[];
  #index = 0;

  constructor(proxies: Iterable<ProxyLike>) {
    this.proxies = proxyList(proxies, "ProxyCycle");
  }

  pick(): ProxyLike {
    const proxy = this.proxies[this.#index % this.proxies.length] as ProxyLike;
    this.#index += 1;
    return proxy;
  }
}

export class ProxyRandom implements ProxySource {
  readonly proxies: ProxyLike[];

  constructor(proxies: Iterable<ProxyLike>) {
    this.proxies = proxyList(proxies, "ProxyRandom");
  }

  pick(): ProxyLike {
    return this.proxies[Math.floor(Math.random() * this.proxies.length)] as ProxyLike;
  }
}

const PLACEHOLDER = /\{\{|\}\}|\{([^{}]*)\}/g;

function format(template: string, values: Record<string, string | number>): string {
  return template.replace(PLACEHOLDER, (match, name: string | undefined) => {
    if (match === "{{") return "{";
    if (match === "}}") return "}";
    if (name === undefined || !Object.hasOwn(values, name)) {
      throw new TypeError(`unknown placeholder in proxy template: '${name ?? ""}'`);
    }
    return String(values[name]);
  });
}

function hex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A proxy URL from a template: `{session}` is a fresh hex id, `{n}` a counter.
 * Covers the sticky-session syntax providers put in the username:
 *
 *     new ProxyTemplate("http://user-cc-us-sessid-{session}:pw@gate.example.com:7000")
 *
 * Literal braces are `{{` and `}}`.
 */
export class ProxyTemplate implements ProxySource {
  readonly template: string;
  #count = 0;

  constructor(template: string) {
    format(template, { session: "0".repeat(12), n: 0 }); // fail on a bad placeholder now
    this.template = template;
  }

  pick(): string {
    const n = this.#count;
    this.#count += 1;
    return format(this.template, { session: hex(6), n });
  }
}

export function isProxySource(value: unknown): value is ProxySource {
  return isRecord(value) && typeof value.pick === "function";
}

export async function resolveProxy(
  proxy: ProxyInput | null | undefined,
): Promise<ProxyLike | null | undefined> {
  return typeof proxy === "function"
    ? proxy()
    : isProxySource(proxy)
      ? proxy.pick()
      : proxy;
}
