import { describe, expect, test } from "vitest";
import { CDPClient } from "../src/browser/cdp.js";
import { CDPError } from "../src/errors.js";
import { FakeCDPServer, FakeWebSocket, settle } from "./helpers.js";

async function connected(): Promise<{
  client: CDPClient;
  server: FakeCDPServer;
  closed: number[];
}> {
  const server = new FakeCDPServer();
  const closed: number[] = [];
  const client = new CDPClient("ws://x", {
    createWebSocket: server.create,
    onClose: () => closed.push(1),
    logger: null,
  });
  await client.start();
  return { client, server, closed };
}

describe("CDPClient", () => {
  test("send gets the matching result, with the session id on the wire", async () => {
    const { client, server } = await connected();
    server.respond("Browser.getVersion", () => ({ product: "Chrome/1" }));
    expect(await client.send("Browser.getVersion")).toEqual({ product: "Chrome/1" });
    expect(await client.send("Page.enable", undefined, "s1")).toEqual({});
    expect(server.calls[1]).toMatchObject({
      method: "Page.enable",
      params: {},
      sessionId: "s1",
    });
    expect(client.connected).toBe(true);
  });

  test("an error frame is a CDPError with its code and data", async () => {
    const { client, server } = await connected();
    server.respond("Page.navigate", () => ({
      error: { code: -32000, message: "Cannot navigate", data: "bad url" },
    }));
    const err = await client.send("Page.navigate", { url: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(CDPError);
    expect(err.message).toBe("Cannot navigate: bad url");
    expect(err.code).toBe(-32000);
  });

  test("events reach their handler with the session id", async () => {
    const { client, server } = await connected();
    const seen: unknown[] = [];
    client.on("Target.attachedToTarget", (params, sessionId) =>
      seen.push([params, sessionId]),
    );
    server.event("Target.attachedToTarget", { targetInfo: {} }, "s1");
    server.event("Unhandled.event", {});
    expect(seen).toEqual([[{ targetInfo: {} }, "s1"]]);
  });

  test("a handler that throws is logged and does not stop dispatch", async () => {
    const errors: string[] = [];
    const server = new FakeCDPServer();
    const client = new CDPClient("ws://x", {
      createWebSocket: server.create,
      logger: { error: (m) => errors.push(m) },
    });
    await client.start();
    client.on("Boom", () => {
      throw new Error("handler broke");
    });
    server.event("Boom", {});
    expect(errors[0]).toMatch(/handler for Boom failed: handler broke/);
    server.respond("Ok", () => ({ fine: true }));
    expect(await client.send("Ok")).toEqual({ fine: true });
  });

  test("unparsable and binary frames are dropped, the next one still works", async () => {
    const warned: string[] = [];
    const server = new FakeCDPServer();
    const client = new CDPClient("ws://x", {
      createWebSocket: server.create,
      logger: { warn: (m) => warned.push(m) },
    });
    await client.start();
    server.socket?.raw("{not json");
    server.socket?.raw(new Uint8Array([1]));
    expect(warned).toEqual([
      "dropping unparsable CDP frame",
      "dropping a binary CDP frame",
    ]);
    expect(await client.send("Ok")).toEqual({});
  });

  test("a stray reply id is ignored", async () => {
    const { client, server } = await connected();
    server.socket?.message({ id: 999, result: {} });
    expect(await client.send("Ok")).toEqual({});
  });

  test("a server close fails pending replies and reports once", async () => {
    const { client, server, closed } = await connected();
    server.respond("Slow", () => undefined);
    server.sync = true;
    server.responders.set("Slow", () => {
      throw new Error("never answered");
    });
    server.responders.delete("Slow");
    const socket = server.socket as FakeWebSocket;
    socket.onSend = () => {}; // swallow: the reply never comes
    const pending = client.send("Slow");
    socket.serverClose();
    await expect(pending).rejects.toThrow("CDP connection closed");
    expect(closed).toEqual([1]);
    expect(client.connected).toBe(false);
    await client.stop();
    expect(closed).toEqual([1]);
    expect(() => client.post("Ok")).toThrow(CDPError);
  });

  test("stop closes the socket, fails pending and blocks new commands", async () => {
    const { client, server, closed } = await connected();
    const socket = server.socket as FakeWebSocket;
    socket.onSend = () => {};
    const pending = client.send("Slow");
    await client.stop();
    await expect(pending).rejects.toBeInstanceOf(CDPError);
    expect(socket.closed).toBe(true);
    expect(closed).toEqual([1]);
    await expect(client.send("Ok")).rejects.toThrow("CDP connection closed");
    await settle();
    expect(closed).toEqual([1]); // the socket's own close event does not report again
  });

  test("post before start throws, a send failure is a CDPError", async () => {
    const client = new CDPClient("ws://x", {
      createWebSocket: (u) => new FakeWebSocket(u),
    });
    expect(() => client.post("Ok")).toThrow(/call start\(\) first/);
    const { client: live, server } = await connected();
    (server.socket as FakeWebSocket).readyState = 3;
    expect(() => live.post("Ok")).toThrow(/CDP connection closed: socket is not open/);
  });

  test("a refused connection rejects start", async () => {
    let socket: FakeWebSocket | undefined;
    const client = new CDPClient("ws://x", {
      createWebSocket: (url) => {
        socket = new FakeWebSocket(url);
        queueMicrotask(() => {
          socket?.fail("ECONNREFUSED");
          socket?.serverClose();
        });
        return socket;
      },
      logger: null,
    });
    await expect(client.start()).rejects.toThrow("CDP connection failed: ECONNREFUSED");
    expect(client.connected).toBe(false);
    expect(socket?.closed).toBe(true);
  });

  test("a reply nobody awaits does not crash the process", async () => {
    const { client, server } = await connected();
    server.respond("Boom", () => ({ error: { message: "x" } }));
    client.post("Boom");
    await settle();
  });
});
