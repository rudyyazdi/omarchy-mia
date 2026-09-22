import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { type ServerEventOf } from "@mia/protocol";
import { MiaClient } from "./client.ts";

const ackEvent = (commandId: string): ServerEventOf<"ack"> => ({
  protocol_version: 1,
  message_id: `event_${commandId}`,
  conversation_id: null,
  sequence: null,
  server_time: new Date().toISOString(),
  type: "ack",
  payload: { command_id: commandId, disposition: "accepted" },
});

const makeClient = (url = "ws://127.0.0.1:1") =>
  new MiaClient({
    url,
    secret: "test",
    build: { name: "test", version: "0", commit: null, dirty: false },
  });

afterEach(() => vi.restoreAllMocks());

describe("client deadlines", () => {
  it("rejects an event wait on deadline and keeps independent predicates working", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    const client = makeClient();
    const expired = client.waitFor("ack");
    const rejected = expect(expired).rejects.toThrow("timed out waiting for ack");
    deadline.abort();
    await rejected;
    const wanted = client.waitFor("ack", (event) => event.payload.command_id === "wanted");
    client.emit("ack", ackEvent("other"));
    const event = ackEvent("wanted");
    client.emit("ack", event);
    await expect(wanted).resolves.toEqual(event);
  });

  it("an acknowledged send's old deadline cannot expire a resend with the same id", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no TCP address");
    const connected = once(server, "connection");
    const client = makeClient(`ws://127.0.0.1:${address.port}`);
    try {
      await client.connect();
      await connected;
      const socket = server.clients.values().next().value;
      if (!socket) throw new Error("no connected client");
      const oldDeadline = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(oldDeadline.signal);
      const first = client.send("start_conversation", {}, "same_id");
      socket.send(JSON.stringify(ackEvent("same_id")));
      await expect(first).resolves.toMatchObject({ disposition: "accepted" });
      const second = client.send("start_conversation", {}, "same_id");
      oldDeadline.abort();
      socket.send(JSON.stringify(ackEvent("same_id")));
      await expect(second).resolves.toMatchObject({ disposition: "accepted" });
    } finally {
      client.close();
      const closed = once(server, "close");
      server.close();
      await closed;
    }
  });
});
