import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { ClientCommandSchema } from "@mia/protocol";
import { ackEvent } from "./ack-fixture.ts";
import { runTextClient, type TextClientIo } from "./repl.ts";

/** Stands in for the server: it acks every command except submit_text, which it holds and reports. */
const fakeServer = async (onSubmit: (socket: WebSocket) => void) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  server.on("connection", (socket) =>
    socket.on("message", (data) => {
      const command = ClientCommandSchema.parse(JSON.parse(data.toString("utf8")));
      if (command.type === "submit_text") onSubmit(socket);
      else socket.send(JSON.stringify(ackEvent(command.message_id, { conversation_id: "conv_1" })));
    }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no TCP address");
  return { server, url: `ws://127.0.0.1:${address.port}` };
};

let dir: string;
let server: WebSocketServer | null;
let io: TextClientIo & { input: PassThrough };
let printed: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mia-repl-"));
  await writeFile(join(dir, "secret"), "test\n");
  server = null;
  const output = new PassThrough().setEncoding("utf8");
  printed = "";
  output.on("data", (chunk: string) => (printed += chunk));
  io = { input: new PassThrough(), output };
});

afterEach(async () => {
  io.input.end();
  if (server) {
    for (const socket of server.clients) socket.terminate();
    const closed = once(server, "close");
    server.close();
    await closed;
  }
  await rm(dir, { recursive: true, force: true });
});

const start = async (onSubmit: (socket: WebSocket) => void = () => undefined) => {
  const fake = await fakeServer(onSubmit);
  server = fake.server;
  return runTextClient({ url: fake.url, secretFile: join(dir, "secret") }, io);
};

describe("text client session", () => {
  it("reports a line still in flight when the input ends, and prompts no more", async () => {
    const submitted = Promise.withResolvers<undefined>();
    const session = start(() => submitted.resolve(undefined));
    io.input.write("hello\n");
    await submitted.promise;
    io.input.end();
    await expect(session).resolves.toBeUndefined();
    expect(printed).toMatch(
      /✗ connection closed before submit_text \(cmd_[\w-]+\) was acknowledged\n$/,
    );
    expect(printed.split("mia> ")).toHaveLength(2);
  });

  it("/quit ends the session without prompting again", async () => {
    const session = start();
    io.input.write("/quit\n");
    await expect(session).resolves.toBeUndefined();
    expect(printed).toMatch(/mia> connection closed\n$/);
  });

  it("ends the session when the server closes the connection", async () => {
    const session = start((socket) => socket.close());
    io.input.write("hello\n");
    await expect(session).resolves.toBeUndefined();
    expect(printed).toContain("connection closed\n");
  });

  it("rejects instead of exiting when the secret file is missing", async () => {
    await expect(
      runTextClient({ url: "ws://127.0.0.1:1", secretFile: join(dir, "missing") }, io),
    ).rejects.toThrow(/secret file .* not found/);
  });
});
