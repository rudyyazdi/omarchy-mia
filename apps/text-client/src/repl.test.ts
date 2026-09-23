import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { ClientCommandSchema, type ClientCommand } from "@mia/protocol";
import { ackEvent } from "./ack-fixture.ts";
import { runTextClient, type TextClientDeadlines, type TextClientIo } from "./repl.ts";

/** How the fake server answers one command. */
type Respond = (socket: WebSocket, command: ClientCommand) => void;

const accept: Respond = (socket, command) =>
  socket.send(JSON.stringify(ackEvent(command.message_id, { conversation_id: "conv_1" })));

/** Accepts every command except submit_text, which `handler` answers (or holds). */
const onSubmit =
  (handler: Respond): Respond =>
  (socket, command) =>
    (command.type === "submit_text" ? handler : accept)(socket, command);

let dir: string;
let server: WebSocketServer | null;
let session: Promise<void> | null;
let io: TextClientIo & { input: PassThrough };
let printed: string;
let received: ClientCommand[];
/** One controller per acknowledgement deadline the session asked for, in order; none expires on its own. */
let ackDeadlines: AbortController[];

const deadlines: TextClientDeadlines = {
  connect: () => new AbortController().signal,
  ack: () => {
    const deadline = new AbortController();
    ackDeadlines.push(deadline);
    return deadline.signal;
  },
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mia-repl-"));
  await writeFile(join(dir, "secret"), "test\n");
  server = null;
  session = null;
  received = [];
  ackDeadlines = [];
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
  await session?.catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

/** Starts a session against a fake server that answers each command with `respond`. */
const start = async (respond: Respond = accept): Promise<WebSocketServer> => {
  const fake = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server = fake;
  await once(fake, "listening");
  fake.on("connection", (socket) =>
    socket.on("message", (data) => {
      const command = ClientCommandSchema.parse(JSON.parse(data.toString("utf8")));
      received.push(command);
      respond(socket, command);
    }),
  );
  const address = fake.address();
  if (address === null || typeof address === "string") throw new Error("no TCP address");
  session = runTextClient(
    { url: `ws://127.0.0.1:${address.port}`, secretFile: join(dir, "secret") },
    io,
    deadlines,
  );
  return fake;
};

const submitted = () =>
  received.flatMap((command) => (command.type === "submit_text" ? [command.payload.text] : []));

const inFlightError = /✗ connection closed before submit_text \(cmd_[\w-]+\) was acknowledged\n/;

describe("text client session", () => {
  it("handles every piped line, in order, before ending", async () => {
    await start();
    io.input.end("one\ntwo\n");
    await expect(session).resolves.toBeUndefined();
    expect(submitted()).toEqual(["one", "two"]);
    expect(printed).not.toContain("✗");
  });

  it("still reports a line in flight when the input ends, and prompts no more", async () => {
    const held = Promise.withResolvers<WebSocket>();
    await start(onSubmit((socket) => held.resolve(socket)));
    io.input.write("hello\n");
    const socket = await held.promise;
    const ended = once(io.input, "end");
    io.input.end();
    await ended;
    socket.close();
    await expect(session).resolves.toBeUndefined();
    expect(printed).toMatch(inFlightError);
    expect(printed.split("mia> ")).toHaveLength(2);
  });

  it("reports a command whose acknowledgement deadline passes, then handles the next line", async () => {
    const held = Promise.withResolvers<undefined>();
    await start(
      onSubmit((socket, command) =>
        command.type === "submit_text" && command.payload.text === "one"
          ? held.resolve(undefined)
          : accept(socket, command),
      ),
    );
    io.input.write("one\n");
    await held.promise;
    const submitDeadline = ackDeadlines.at(-1);
    if (!submitDeadline) throw new Error("the submission was sent without a deadline");
    submitDeadline.abort(new Error("ack deadline passed"));
    io.input.end("two\n");
    await expect(session).resolves.toBeUndefined();
    expect(submitted()).toEqual(["one", "two"]);
    expect(printed).toContain("✗ ack deadline passed\n");
  });

  it("/quit ends the session, drops the lines after it, and prompts no more", async () => {
    await start();
    io.input.write("/quit\nhello\n");
    await expect(session).resolves.toBeUndefined();
    expect(submitted()).toEqual([]);
    expect(printed).not.toContain("✗");
    expect(printed).toMatch(/mia> connection closed\n$/);
  });

  it("ends the session when the server closes the connection mid-line", async () => {
    await start(onSubmit((socket) => socket.close()));
    io.input.write("hello\n");
    await expect(session).resolves.toBeUndefined();
    expect(printed).toMatch(inFlightError);
    expect(printed).toContain("connection closed\n");
    expect(printed.split("mia> ")).toHaveLength(2);
  });

  it("rejects, and closes the connection, when the conversation cannot start", async () => {
    const fake = await start((socket, command) => {
      if (command.type !== "start_conversation") return accept(socket, command);
      const error = { code: "invalid_state" as const, message: "no" };
      const refusal = ackEvent(command.message_id);
      socket.send(
        JSON.stringify({
          ...refusal,
          payload: { ...refusal.payload, disposition: "rejected", error },
        }),
      );
    });
    const [socket] = await once(fake, "connection");
    const closedByClient = once(socket, "close");
    await expect(session).rejects.toThrow("start_conversation rejected: invalid_state: no");
    await closedByClient;
  });

  it("rejects instead of exiting when the secret file is missing", async () => {
    await expect(
      runTextClient({ url: "ws://127.0.0.1:1", secretFile: join(dir, "missing") }, io, deadlines),
    ).rejects.toThrow(/secret file .* not found/);
  });
});
