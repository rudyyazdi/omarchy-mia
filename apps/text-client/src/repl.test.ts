import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { ProfileSchema } from "@mia/agent-adapter";
import { ClientCommandSchema, type ClientCommand } from "@mia/protocol";
import { ackEvent, refusalEvent } from "./ack-fixture.ts";
import { runTextClient, type TextClientDeadlines, type TextClientIo } from "./repl.ts";

const PRODUCTION_EXAMPLE = resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "examples",
  "config",
  "production-opus.example.json",
);

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

/** Starts a fake server that answers each command with `respond`, and returns its port. */
const listen = async (respond: Respond): Promise<{ fake: WebSocketServer; port: number }> => {
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
  return { fake, port: address.port };
};

/** Starts a session against a fake server that answers each command with `respond`. */
const start = async (respond: Respond = accept): Promise<WebSocketServer> => {
  const { fake, port } = await listen(respond);
  session = runTextClient(
    { url: `ws://127.0.0.1:${port}`, secretFile: join(dir, "secret") },
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

  it("prints a refused submission's disposition and error, then handles the next line", async () => {
    await start(
      onSubmit((socket, command) =>
        command.type === "submit_text" && command.payload.text === "one"
          ? socket.send(
              JSON.stringify(
                refusalEvent(command.message_id, { code: "busy", message: "a task is running" }),
              ),
            )
          : accept(socket, command),
      ),
    );
    io.input.end("one\ntwo\n");
    await expect(session).resolves.toBeUndefined();
    expect(submitted()).toEqual(["one", "two"]);
    expect(printed).toContain("submit rejected: busy: a task is running\n");
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
      socket.send(
        JSON.stringify(refusalEvent(command.message_id, { code: "invalid_state", message: "no" })),
      );
    });
    const [socket] = await once(fake, "connection");
    const closedByClient = once(socket, "close");
    await expect(session).rejects.toThrow("start_conversation rejected: invalid_state: no");
    await closedByClient;
  });

  it("reads the connection from a profile, substituting its placeholders as the server does", async () => {
    await expect(
      runTextClient({ config: PRODUCTION_EXAMPLE, env: { XDG_STATE_HOME: dir } }, io, deadlines),
    ).rejects.toThrow(`secret file ${join(dir, "mia", "client-secret")} not found`);
  });

  it("connects to the host and port a profile names, with its substituted secret file", async () => {
    const { port } = await listen(accept);
    const example = ProfileSchema.parse(JSON.parse(await readFile(PRODUCTION_EXAMPLE, "utf8")));
    const listener = { host: "127.0.0.1", port, secretFile: "${SECRET_DIR}/secret" };
    const config = join(dir, "profile.json");
    await writeFile(config, JSON.stringify({ ...example, server: listener }));
    session = runTextClient(
      { config, env: { SECRET_DIR: dir, XDG_STATE_HOME: dir } },
      io,
      deadlines,
    );
    io.input.end();
    await expect(session).resolves.toBeUndefined();
    expect(printed).toContain(`connected to ws://127.0.0.1:${port}; conversation conv_1`);
  });

  it("rejects a profile whose placeholders the environment does not set", async () => {
    await expect(
      runTextClient({ config: PRODUCTION_EXAMPLE, env: {} }, io, deadlines),
    ).rejects.toThrow("${XDG_STATE_HOME} but it is not set");
  });

  it("rejects instead of exiting when the secret file is missing", async () => {
    await expect(
      runTextClient({ url: "ws://127.0.0.1:1", secretFile: join(dir, "missing") }, io, deadlines),
    ).rejects.toThrow(/secret file .* not found/);
  });
});
