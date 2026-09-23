import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { ackEvent } from "./ack-fixture.ts";
import { MiaClient } from "./client.ts";

const makeClient = (url = "ws://127.0.0.1:1") =>
  new MiaClient({
    url,
    secret: "test",
    build: { name: "test", version: "0", commit: null, dirty: false },
  });

afterEach(() => vi.restoreAllMocks());

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

describe("client deadlines", () => {
  it("rejects an event wait on deadline and keeps independent predicates working", async () => {
    const client = makeClient();
    const expired = client.waitFor("ack", () => true, 1);
    const rejected = expect(expired).rejects.toThrow("timed out waiting for ack");
    await rejected;
    const wanted = client.waitFor("ack", (event) => event.payload.command_id === "wanted");
    client.emit("ack", ackEvent("other"));
    const event = ackEvent("wanted");
    client.emit("ack", event);
    await expect(wanted).resolves.toEqual(event);
  });

  it("an acknowledged send's old deadline cannot expire a resend with the same id", () =>
    withConnectedClient(async (client, socket) => {
      const oldDeadline = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(oldDeadline.signal);
      const first = client.send("start_conversation", {}, "same_id");
      socket.send(JSON.stringify(ackEvent("same_id")));
      await expect(first).resolves.toMatchObject({ disposition: "accepted" });
      const second = client.send("start_conversation", {}, "same_id");
      oldDeadline.abort();
      socket.send(JSON.stringify(ackEvent("same_id")));
      await expect(second).resolves.toMatchObject({ disposition: "accepted" });
    }));

  it("rejects a send still waiting for its ack as soon as the connection closes", () =>
    withConnectedClient(async (client, socket) => {
      const pending = client.send("start_conversation", {}, "cmd_1");
      socket.close();
      await expect(pending).rejects.toThrow(
        "connection closed before start_conversation (cmd_1) was acknowledged",
      );
    }));
});
