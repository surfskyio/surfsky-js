import type { SurfskyOptions } from "../src/client.js";
import { Surfsky } from "../src/client.js";

export interface FakeResponse {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  /** Throw this instead of answering. */
  throws?: unknown;
}

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  /** Parsed JSON, the FormData, the raw string, or undefined. */
  body: unknown;
  signal: AbortSignal | null | undefined;
}

type Reply = FakeResponse | ((request: RecordedRequest) => FakeResponse);

export type Routes = Record<string, (request: RecordedRequest) => FakeResponse>;

export interface FakeFetch {
  fetch: typeof fetch;
  requests: RecordedRequest[];
  queue: Reply[];
  /** `"POST /profiles/one_time"` -> reply; consulted before the queue. */
  routes: Routes;
}

/** A fetch that answers from routes, then a queue in order, and records what it was asked. */
export function fakeFetch(replies: Reply[] = [], routes: Routes = {}): FakeFetch {
  const requests: RecordedRequest[] = [];
  const queue = [...replies];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = Object.fromEntries(new Headers(init?.headers));
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // keep the string
      }
    }
    const request: RecordedRequest = {
      method: init?.method ?? "GET",
      url,
      path: new URL(url).pathname + new URL(url).search,
      headers,
      body,
      signal: init?.signal,
    };
    requests.push(request);
    const route = routes[`${request.method} ${new URL(url).pathname}`];
    const next = route ?? queue.shift();
    if (next === undefined)
      throw new Error(`no fake response queued for ${request.method} ${url}`);
    const reply = typeof next === "function" ? next(request) : next;
    if (reply.throws !== undefined) throw reply.throws;
    const responseHeaders = new Headers(reply.headers);
    let text = reply.text ?? "";
    if (reply.json !== undefined) {
      text = JSON.stringify(reply.json);
      responseHeaders.set("content-type", "application/json");
    }
    return new Response(text, { status: reply.status ?? 200, headers: responseHeaders });
  }) as typeof globalThis.fetch;
  return { fetch: fetchImpl, requests, queue, routes };
}

/** The `{success, msg, data}` envelope the API wraps every reply in. */
export function ok(data: unknown): FakeResponse {
  return { json: { success: true, msg: "", data } };
}

/** A fetch failure whose `cause.code` looks like Node's. */
/** A client wired to a fake fetch, silent, no backoff. */
export function testClient(
  replies: Reply[] = [],
  options: Partial<SurfskyOptions> = {},
  routes: Routes = {},
): { client: Surfsky } & FakeFetch {
  const fake = fakeFetch(replies, routes);
  const client = new Surfsky({
    apiToken: "test-token",
    baseUrl: "https://api.test",
    backoff: 0,
    logger: null,
    fetch: fake.fetch,
    ...options,
  });
  return { client, ...fake };
}

export function connectError(code: string): TypeError {
  const cause = Object.assign(new Error(code), { code });
  return new TypeError("fetch failed", { cause });
}

// --- CDP fakes ---

import type { WebSocketLike } from "../src/browser/cdp.js";

type Listener = (event: any) => void;

/** An in-memory socket. Frames the client sends land in `sent`; `message()` delivers one. */
export class FakeWebSocket implements WebSocketLike {
  readonly url: string;
  readyState = 0;
  readonly sent: string[] = [];
  closed = false;
  onSend: ((message: any) => void) | undefined;
  readonly #listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(listener);
    this.#listeners.set(type, list);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(data);
    this.onSend?.(JSON.parse(data));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    queueMicrotask(() => this.emit("close", { code: 1000, reason: "" }));
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  message(json: unknown): void {
    this.emit("message", { data: JSON.stringify(json) });
  }

  raw(data: unknown): void {
    this.emit("message", { data });
  }

  fail(reason = "refused"): void {
    this.emit("error", { message: reason });
  }

  serverClose(code = 1006): void {
    this.readyState = 3;
    this.closed = true;
    this.emit("close", { code, reason: "" });
  }
}

export interface CDPCall {
  id: number;
  method: string;
  params: any;
  sessionId: string | undefined;
}

export type CDPResponder = (
  params: any,
  sessionId: string | undefined,
  call: CDPCall,
) => unknown | { error: { code?: number; message: string; data?: string } };

/** A scripted CDP peer: answers commands from `respond` and can push events. */
export class FakeCDPServer {
  readonly calls: CDPCall[] = [];
  readonly responders: Map<string, CDPResponder> = new Map();
  socket: FakeWebSocket | undefined;
  /** Answer synchronously (in the send call) instead of on a microtask. */
  sync = false;
  /** Methods recorded but never answered, the way a busy cloud stalls a command. */
  readonly hangs: Set<string> = new Set();

  readonly create: (url: string) => FakeWebSocket = (url) => {
    const socket = new FakeWebSocket(url);
    this.socket = socket;
    socket.onSend = (message) => this.#answer(socket, message);
    queueMicrotask(() => socket.open());
    return socket;
  };

  respond(method: string, responder: CDPResponder): this {
    this.responders.set(method, responder);
    return this;
  }

  event(method: string, params: unknown, sessionId?: string): void {
    const message: Record<string, unknown> = { method, params };
    if (sessionId !== undefined) message.sessionId = sessionId;
    this.socket?.message(message);
  }

  called(method: string): CDPCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  #answer(socket: FakeWebSocket, message: any): void {
    const call: CDPCall = {
      id: message.id,
      method: message.method,
      params: message.params ?? {},
      sessionId: message.sessionId,
    };
    this.calls.push(call);
    if (this.hangs.has(call.method)) return;
    const responder = this.responders.get(call.method);
    const deliver = (): void => {
      let result: unknown;
      try {
        result = responder ? responder(call.params, call.sessionId, call) : {};
      } catch (err) {
        result = { error: { message: String(err) } };
      }
      const reply: Record<string, unknown> = { id: call.id };
      if (call.sessionId !== undefined) reply.sessionId = call.sessionId;
      if (result !== null && typeof result === "object" && "error" in result) {
        reply.error = (result as { error: unknown }).error;
      } else {
        reply.result = result ?? {};
      }
      if (!socket.closed) socket.message(reply);
    };
    if (this.sync) deliver();
    else queueMicrotask(deliver);
  }
}

/** Let queued microtasks and the fake's replies run. */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
