import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { ackEvent } from "./ack-fixture.ts";
import { ClientCommandSchema, LIMITS, type AcceptedAck, type RefusedAck } from "@mia/protocol";
import { MiaClient } from "./client.ts";

const makeClient = (url = "ws://127.0.0.1:1", clientId?: string) =>
  new MiaClient({
    url,
    secret: "test",
    build: { name: "test", version: "0", commit: null, dirty: false },
    ...(clientId === undefined ? {} : { clientId }),
  });

/** Ids the protocol cannot carry: the server would acknowledge them as `unknown`. */
const UNCARRIABLE_IDS = [
  ["an empty", ""],
  ["an over-long", "x".repeat(LIMITS.maxIdChars + 1)],
] as const;

/** Runs `test` with a client connected to a bare server, and tears both down even if it fails. */
const withConnectedClient = async (
  test: (client: MiaClient, socket: WebSocket) => Promise<void>,
): Promise<void> => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no TCP address");
  const connected = once(server, "connection");
  const client = makeClient(`ws://127.0.0.1:${address.port}`);
  try {
    await client.connect();
    const [socket] = await connected;
    if (!(socket instanceof WebSocket)) throw new Error("no connected socket");
    await test(client, socket);
  } finally {
    client.close();
    const closed = once(server, "close");
    server.close();
    await closed;
  }
};

/**
 * Runs `refuse`, which sends a command the client must refuse, then shows that the refused command wrote nothing to
 * the socket and left no trace among the recent interaction ids: the next command is the first the server sees.
 */
const expectRefusedUnsent = async (
  client: MiaClient,
  socket: WebSocket,
  refuse: () => Promise<void>,
): Promise<void> => {
  const received: string[] = [];
  socket.on("message", (data) => received.push(data.toString("utf8")));
  await refuse();
  const sent = once(socket, "message");
  const next = client.send("start_conversation", {}, { messageId: "next" });
  await sent;
  expect(received.map((text) => JSON.parse(text).message_id)).toEqual(["next"]);
  expect(client.diagnostics().recent_interaction_ids).toEqual(["next"]);
  socket.send(JSON.stringify(ackEvent("next")));
  await next;
};

/** How the handshake server answers a WebSocket upgrade request: never, or with an HTTP 401. */
type Handshake = "silent" | "refuse";

/**
 * Runs `test` against a TCP server that answers the upgrade request as `handshake` says. `requested` resolves with
 * the server's end of the first connection once the client's upgrade request arrives.
 */
const withHandshakeServer = async (
  handshake: Handshake,
  test: (url: string, requested: Promise<Socket>) => Promise<void>,
): Promise<void> => {
  const sockets = new Set<Socket>();
  const requested = Promise.withResolvers<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("data", () => {
      if (handshake === "refuse")
        socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      requested.resolve(socket);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no TCP address");
  try {
    await test(`ws://127.0.0.1:${address.port}`, requested.promise);
  } finally {
    for (const socket of sockets) socket.destroy();
    const closed = once(server, "close");
    server.close();
    await closed;
  }
};

describe("client cancellation", () => {
  it("rejects an event wait with its signal's reason and keeps independent predicates working", async () => {
    const client = makeClient();
    const deadline = new AbortController();
    const expired = client.waitFor("ack", () => true, { signal: deadline.signal });
    const reason = new Error("wait cancelled");
    deadline.abort(reason);
    await expect(expired).rejects.toBe(reason);
    const wanted = client.waitFor("ack", (event) => event.payload.command_id === "wanted");
    client.emit("ack", ackEvent("other"));
    const event = ackEvent("wanted");
    client.emit("ack", event);
    await expect(wanted).resolves.toEqual(event);
  });

  it("rejects a wait whose signal is already aborted, unless the event already arrived", async () => {
    const client = makeClient();
    const reason = new Error("already cancelled");
    const signal = AbortSignal.abort(reason);
    await expect(client.waitFor("ack", () => true, { signal })).rejects.toBe(reason);
    const event = ackEvent("seen");
    client.events.push(event);
    await expect(client.waitFor("ack", () => true, { signal })).resolves.toEqual(event);
  });

  it("an earlier send's signal cannot cancel a resend with the same id", () =>
    withConnectedClient(async (client, socket) => {
      const oldDeadline = new AbortController();
      const first = client.send(
        "start_conversation",
        {},
        { messageId: "same_id", signal: oldDeadline.signal },
      );
      socket.send(JSON.stringify(ackEvent("same_id")));
      await expect(first).resolves.toMatchObject({ disposition: "accepted" });
      const second = client.send("start_conversation", {}, { messageId: "same_id" });
      oldDeadline.abort();
      socket.send(JSON.stringify(ackEvent("same_id")));
      await expect(second).resolves.toMatchObject({ disposition: "accepted" });
    }));

  it("rejects a send with its signal's reason, leaving a concurrent resend with the same id waiting", () =>
    withConnectedClient(async (client, socket) => {
      const deadline = new AbortController();
      const first = client.send(
        "start_conversation",
        {},
        { messageId: "same_id", signal: deadline.signal },
      );
      const second = client.send("start_conversation", {}, { messageId: "same_id" });
      const reason = new Error("send cancelled");
      deadline.abort(reason);
      await expect(first).rejects.toBe(reason);
      socket.send(JSON.stringify(ackEvent("same_id")));
      await expect(second).resolves.toMatchObject({ disposition: "accepted" });
    }));

  it("starts a conversation from an accepted ack, including a duplicate one, and refuses a failed one", () =>
    withConnectedClient(async (client, socket) => {
      /** Answer the next command with an ack carrying `payload`. */
      const answerNext = (
        payload: Omit<AcceptedAck, "command_id"> | Omit<RefusedAck, "command_id">,
      ) =>
        socket.once("message", (data) => {
          const command = ClientCommandSchema.parse(JSON.parse(data.toString("utf8")));
          const ack = ackEvent(command.message_id);
          socket.send(
            JSON.stringify({ ...ack, payload: { command_id: command.message_id, ...payload } }),
          );
        });
      answerNext({
        disposition: "failed",
        error: { code: "internal", message: "broke after recording" },
      });
      await expect(client.startConversation()).rejects.toThrow(
        "start_conversation failed: internal",
      );
      answerNext({
        disposition: "accepted",
        result: { conversation_id: "conv_1" },
        duplicate: true,
      });
      await expect(client.startConversation()).resolves.toBe("conv_1");
    }));

  it("does not send a command whose signal is already aborted", () =>
    withConnectedClient((client, socket) =>
      expectRefusedUnsent(client, socket, async () => {
        const reason = new Error("already cancelled");
        const refused = client.send(
          "start_conversation",
          {},
          { signal: AbortSignal.abort(reason) },
        );
        await expect(refused).rejects.toBe(reason);
      }),
    ));

  it("rejects a send still waiting for its ack as soon as the connection closes", () =>
    withConnectedClient(async (client, socket) => {
      const pending = client.send("start_conversation", {}, { messageId: "cmd_1" });
      socket.close();
      await expect(pending).rejects.toThrow(
        "connection closed before start_conversation (cmd_1) was acknowledged",
      );
    }));

  it("rejects an event wait as soon as the connection closes, and drops its listener", () =>
    withConnectedClient(async (client, socket) => {
      const pending = client.waitFor("task_finished");
      expect(client.listenerCount("task_finished")).toBe(1);
      socket.close();
      await expect(pending).rejects.toThrow("connection closed while waiting for task_finished");
      expect(client.listenerCount("task_finished")).toBe(0);
    }));

  it("after the connection closed, resolves a wait for an event already received and rejects any other", () =>
    withConnectedClient(async (client, socket) => {
      const received = once(client, "ack");
      socket.send(JSON.stringify(ackEvent("seen")));
      await received;
      const disconnected = once(client, "disconnected");
      socket.close();
      await disconnected;
      await expect(client.waitFor("ack")).resolves.toMatchObject({
        payload: { command_id: "seen" },
      });
      await expect(client.waitFor("task_finished")).rejects.toThrow(
        "connection closed while waiting for task_finished",
      );
    }));

  it("rejects a wait started while the client is closing its connection", () =>
    withConnectedClient(async (client) => {
      client.close();
      await expect(client.waitFor("task_finished")).rejects.toThrow(
        "connection closed while waiting for task_finished",
      );
    }));

  it("rejects a connect still waiting for the handshake with its signal's reason, and drops the connection", () =>
    withHandshakeServer("silent", async (url, requested) => {
      const client = makeClient(url);
      const deadline = new AbortController();
      const connecting = client.connect({ signal: deadline.signal });
      const serverSide = await requested;
      const dropped = once(serverSide, "close");
      const reason = new Error("connect cancelled");
      deadline.abort(reason);
      await expect(connecting).rejects.toBe(reason);
      expect(client.connectionState).toBe("disconnected");
      await dropped;
    }));

  it("drops the connection when the server refuses the upgrade", () =>
    withHandshakeServer("refuse", async (url, requested) => {
      const client = makeClient(url);
      const connecting = client.connect();
      const dropped = once(await requested, "close");
      await expect(connecting).rejects.toThrow("server refused the connection: HTTP 401");
      expect(client.connectionState).toBe("disconnected");
      await dropped;
    }));

  it("rejects a wait started before the handshake once the connect fails, and drops its listener", () =>
    withHandshakeServer("refuse", async (url) => {
      const client = makeClient(url);
      const pending = client.waitFor("task_finished");
      await expect(client.connect()).rejects.toThrow("server refused the connection: HTTP 401");
      await expect(pending).rejects.toThrow("connection closed while waiting for task_finished");
      expect(client.listenerCount("task_finished")).toBe(0);
    }));

  it("does not open a connection when the signal is already aborted", () =>
    withHandshakeServer("silent", async (url) => {
      const client = makeClient(url);
      const reason = new Error("already cancelled");
      await expect(client.connect({ signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
      expect(client.connectionState).toBe("disconnected");
    }));
});

describe("client ids", () => {
  it.each(UNCARRIABLE_IDS)("refuses to construct a client with %s client_id", (_, clientId) => {
    expect(() => makeClient(undefined, clientId)).toThrow("invalid client_id");
  });

  it("accepts a client_id of the longest length the protocol carries", () => {
    const clientId = "x".repeat(LIMITS.maxIdChars);
    expect(makeClient(undefined, clientId).clientId).toBe(clientId);
  });

  it("sends a message_id of the longest length the protocol carries", () =>
    withConnectedClient(async (client, socket) => {
      const messageId = "x".repeat(LIMITS.maxIdChars);
      const sent = once(socket, "message");
      const pending = client.send("start_conversation", {}, { messageId });
      const [data] = await sent;
      expect(JSON.parse(String(data)).message_id).toBe(messageId);
      // The fixture's `event_<command id>` would itself be too long to carry.
      socket.send(JSON.stringify({ ...ackEvent(messageId), message_id: "event_longest" }));
      await expect(pending).resolves.toMatchObject({ command_id: messageId });
    }));

  it.each(UNCARRIABLE_IDS)(
    "rejects a send with %s message_id at once and writes nothing to the socket",
    (_, messageId) =>
      withConnectedClient((client, socket) =>
        expectRefusedUnsent(client, socket, async () => {
          await expect(client.send("start_conversation", {}, { messageId })).rejects.toThrow(
            "invalid message_id",
          );
        }),
      ),
  );
});
