/** A tiny Chrome DevTools Protocol client: JSON-RPC over a WebSocket. */

import { CDPError } from "../errors.js";
import type { Logger } from "../transport.js";
import { makeLogger } from "../transport.js";
import { isRecord } from "../types.js";

/** What the client needs from a socket; the native `WebSocket` fits. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}

export type CreateWebSocket = (url: string) => WebSocketLike;
export type EventHandler = (params: any, sessionId: string | undefined) => void;

const nativeWebSocket: CreateWebSocket = (url) => new WebSocket(url);

export interface CDPClientOptions {
  createWebSocket?: CreateWebSocket;
  onClose?: () => void;
  logger?: Partial<Logger> | null;
}

export class CDPClient {
  readonly wsUrl: string;
  onClose: (() => void) | undefined;
  readonly #create: CreateWebSocket;
  readonly #logger: Logger;
  #ws: WebSocketLike | undefined;
  #closed = false;
  #closeReported = false;
  #nextId = 0;
  readonly #pending = new Map<number, PromiseWithResolvers<any>>();
  readonly #handlers = new Map<string, EventHandler>();

  constructor(wsUrl: string, options: CDPClientOptions = {}) {
    this.wsUrl = wsUrl;
    this.onClose = options.onClose;
    this.#create = options.createWebSocket ?? nativeWebSocket;
    this.#logger = makeLogger(options.logger);
  }

  get connected(): boolean {
    return this.#ws !== undefined && !this.#closed;
  }

  async start(): Promise<void> {
    if (this.#ws !== undefined) throw new Error("CDP client is already started");
    const ws = this.#create(this.wsUrl);
    this.#ws = ws;
    await new Promise<void>((resolve, reject) => {
      let opened = false;
      ws.addEventListener("open", () => {
        opened = true;
        resolve();
      });
      ws.addEventListener("error", (event) => {
        if (opened) return;
        reject(new CDPError(`CDP connection failed: ${describeEvent(event)}`));
      });
      ws.addEventListener("close", (event) => {
        if (!opened)
          reject(new CDPError(`CDP connection failed: ${describeEvent(event)}`));
        this.#onSocketClose();
      });
      ws.addEventListener("message", (event) => this.#onMessage(event.data));
    }).catch((err) => {
      this.#closed = true;
      this.#ws = undefined;
      try {
        ws.close();
      } catch {
        // already gone
      }
      throw err;
    });
  }

  async stop(): Promise<void> {
    this.#closed = true;
    const ws = this.#ws;
    this.#ws = undefined;
    if (ws !== undefined) {
      try {
        ws.close(1000);
      } catch {
        // already gone
      }
    }
    this.#failPending();
    this.#reportClose();
  }

  on(event: string, handler: EventHandler): void {
    this.#handlers.set(event, handler);
  }

  /** Put a command on the wire and hand back its reply to await later. */
  post(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): { id: number; reply: Promise<any> } {
    if (this.#closed) throw new CDPError("CDP connection closed");
    const ws = this.#ws;
    if (ws === undefined)
      throw new Error("CDP client is not connected; call start() first");
    this.#nextId += 1;
    const id = this.#nextId;
    const message: Record<string, unknown> = {
      id,
      method,
      params: params ?? {},
    };
    if (sessionId !== undefined) message.sessionId = sessionId;
    const reply = Promise.withResolvers<any>();
    reply.promise.catch(() => {}); // a reply nobody awaits must not be an unhandled rejection
    this.#pending.set(id, reply);
    try {
      ws.send(JSON.stringify(message));
    } catch (err) {
      this.#pending.delete(id);
      throw new CDPError(`CDP connection closed: ${describeEvent(err)}`, {
        cause: err,
      });
    }
    return { id, reply: reply.promise };
  }

  /** Drop a posted command nobody is going to await. */
  forget(id: number): void {
    this.#pending.delete(id);
  }

  async send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<any> {
    const { id, reply } = this.post(method, params, sessionId);
    try {
      return await reply;
    } finally {
      this.#pending.delete(id);
    }
  }

  #onMessage(raw: unknown): void {
    if (typeof raw !== "string") {
      this.#logger.warn("dropping a binary CDP frame");
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      this.#logger.warn("dropping unparsable CDP frame");
      return;
    }
    if (isRecord(message)) this.#dispatch(message);
  }

  #dispatch(message: Record<string, unknown>): void {
    const id = message.id;
    if (typeof id === "number") {
      const reply = this.#pending.get(id);
      this.#pending.delete(id);
      if (reply === undefined) return;
      const error = message.error;
      if (isRecord(error)) {
        let text = typeof error.message === "string" ? error.message : "CDP error";
        if (error.data) text = `${text}: ${String(error.data)}`;
        const code = typeof error.code === "number" ? error.code : undefined;
        reply.reject(new CDPError(text, { code }));
      } else {
        reply.resolve(message.result ?? {});
      }
      return;
    }
    const method = typeof message.method === "string" ? message.method : "";
    const handler = this.#handlers.get(method);
    if (handler === undefined) return;
    const sessionId =
      typeof message.sessionId === "string" ? message.sessionId : undefined;
    try {
      handler(message.params ?? {}, sessionId);
    } catch (err) {
      this.#logger.error(`CDP event handler for ${method} failed: ${describeEvent(err)}`);
    }
  }

  #onSocketClose(): void {
    if (!this.#closed) this.#logger.warn("CDP connection closed by the server");
    this.#closed = true;
    this.#ws = undefined;
    this.#failPending();
    this.#reportClose();
  }

  #reportClose(): void {
    if (this.#closeReported) return;
    this.#closeReported = true;
    this.onClose?.();
  }

  #failPending(): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const reply of pending) reply.reject(new CDPError("CDP connection closed"));
  }
}

function describeEvent(event: unknown): string {
  if (event instanceof Error) return event.message;
  if (isRecord(event)) {
    if (event.error instanceof Error) return event.error.message;
    if (typeof event.message === "string") return event.message;
    if (typeof event.reason === "string" && event.reason) return event.reason;
    if (typeof event.code === "number") return `code ${event.code}`;
  }
  return String(event);
}
