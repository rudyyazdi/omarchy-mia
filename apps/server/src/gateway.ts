import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { dirname } from "node:path";
import { match, P } from "ts-pattern";
import { WebSocketServer, type WebSocket } from "ws";
import {
  errorMessage,
  LIMITS,
  PROTOCOL_VERSION,
  registerSecret,
  type AckError,
  type AckPayload,
  type ClientCommand,
  type ServerEvent,
} from "@mia/protocol";
import { type CommandReply, type RecordedCommand, type RecordWriter } from "@mia/records";
import { decodeEnvelope } from "./decode.ts";
import type { CommandResult, Delivery, Engine } from "./engine.ts";

export interface GatewayOptions {
  host: "127.0.0.1";
  port: number;
  secretFile: string;
  engine: Engine;
  writer: RecordWriter;
  /** The clock an ack's `server_time` reads: the engine's, so acks and events agree. */
  now: () => Date;
  log: (message: string) => void;
}

export interface GatewayHandle {
  url: string;
  port: number;
  /** Deliver an event to one connection; attached to the engine while the gateway is open. */
  send: Delivery;
  /**
   * Close every connection and the listener, then wait until each command still being handled stores its reply, or
   * until `commandWait` aborts; a reply stored after that fails against the closed catalog and is logged.
   */
  close(commandWait: AbortSignal): Promise<void>;
}

/** Load or create the local client secret (0600, outside Git). Never logged. */
export const loadOrCreateSecretSync = (path: string): string => {
  if (existsSync(path)) {
    const secret = readFileSync(path, "utf8").trim();
    if (secret.length < 32)
      throw new Error(`secret file ${path} is too short; delete it to regenerate`);
    registerSecret(secret);
    return secret;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString("hex");
  writeFileSync(path, secret + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  registerSecret(secret);
  return secret;
};

interface Connection {
  id: string;
  socket: WebSocket;
  clientId: string | null;
  clientBuild: unknown;
  opened: boolean;
}

/**
 * The reply to a command that was recorded but did not finish: handling threw after the record committed, or a
 * duplicate found it still `received` and not in flight in this process, so the original never finished. The
 * engine may have acted on it, so it is never run again.
 */
const FAILED_AFTER_RECORD: CommandReply = {
  disposition: "failed",
  error: {
    code: "internal",
    message:
      "internal error after the command was recorded; it may have taken effect and will not run again",
  },
};

/**
 * How far handling a command got before it threw, which decides what its reply may claim. `answered` means
 * its reply is stored or was read from the record, so only sending that reply can have thrown.
 */
type Progress =
  { stage: "unrecorded" } | { stage: "recorded"; commandId: string } | { stage: "answered" };

const replyFor = (result: CommandResult): CommandReply =>
  result.ok
    ? { disposition: "accepted", result: result.result ?? null }
    : { disposition: "rejected", error: { code: result.code, message: result.message } };

const ackPayload = (commandId: string, reply: CommandReply): AckPayload =>
  match(reply)
    .with({ disposition: "accepted" }, ({ result }): AckPayload => ({
      command_id: commandId,
      disposition: "accepted",
      ...(result === null ? {} : { result }),
    }))
    .with({ disposition: P.not("accepted") }, ({ disposition, error }): AckPayload => ({
      command_id: commandId,
      disposition,
      error,
    }))
    .exhaustive();

/**
 * Client gateway: loopback-only, bearer-authenticated WebSocket. Validates every envelope before any state
 * changes, deduplicates command IDs per client across its connections, acknowledges every command, and
 * delivers events.
 */
export const startGateway = async (options: GatewayOptions): Promise<GatewayHandle> => {
  // eslint-disable-next-line no-restricted-syntax -- runs before serving: the secret loads before the gateway listens, and no runtime can reach the bridge yet
  const secret = loadOrCreateSecretSync(options.secretFile);
  const secretBuf = Buffer.from(secret);
  const httpServer: Server = createServer((_, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: LIMITS.maxEnvelopeBytes,
  });
  const connections = new Map<string, Connection>();
  /**
   * Each recorded command still being handled, by its recorded id: its reply once stored, and whether a duplicate
   * already waits for it. The first duplicate that finds its original still `received` waits for that reply instead
   * of settling it failed; a further one is refused as busy at once, unrecorded, so a resend after the reply gets
   * it. An entry leaves once its reply is stored. Only a start_conversation stays across an await, and the engine
   * runs one at a time, so this holds at most one entry for longer than the messages of one socket read.
   */
  const inFlight = new Map<string, { reply: Promise<CommandReply>; awaited: boolean }>();
  /**
   * Every message still being handled, so closing waits until each has stored its reply. Besides the messages of
   * one socket read, it holds at most the one start in flight and the one duplicate waiting for it.
   */
  const handling = new Set<Promise<void>>();

  const authenticate = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization ?? "";
    const token = /^Bearer\s+(.+)$/.exec(header)?.[1];
    if (token === undefined) return false;
    const provided = Buffer.from(token.trim());
    return provided.length === secretBuf.length && timingSafeEqual(provided, secretBuf);
  };

  httpServer.on("upgrade", (req, socket, head) => {
    if (!authenticate(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  const send = (connectionId: string, event: ServerEvent) => {
    const conn = connections.get(connectionId);
    if (!conn || conn.socket.readyState !== conn.socket.OPEN) return;
    conn.socket.send(JSON.stringify(event));
  };

  const ack = (conn: Connection, payload: AckPayload) => {
    const event: ServerEvent = {
      protocol_version: PROTOCOL_VERSION,
      message_id: randomUUID(),
      type: "ack",
      conversation_id: options.engine.conversation?.id ?? null,
      sequence: null,
      server_time: options.now().toISOString(),
      payload,
    };
    if (conn.socket.readyState === conn.socket.OPEN) conn.socket.send(JSON.stringify(event));
  };

  const rejectRaw = (conn: Connection, commandId: string, error: AckError) => {
    ack(conn, { command_id: commandId, disposition: "rejected", error });
  };

  /** Store a recorded command as failed; a failure to store it is logged, since the reply says the same. */
  const settleFailed = (recordedId: string) => {
    try {
      options.writer.finishCommand(recordedId, FAILED_AFTER_RECORD);
    } catch (error) {
      options.log(`could not record command ${recordedId} as failed: ${errorMessage(error)}`);
    }
  };

  /** Answer a message_id the client already used, from its record; nothing runs. */
  const answerRecorded = (
    conn: Connection,
    commandId: string,
    recorded: Exclude<RecordedCommand, { kind: "new" }>,
  ) =>
    match(recorded)
      .with({ kind: "conflict" }, () =>
        rejectRaw(conn, commandId, {
          code: "duplicate_command_conflict",
          message: "message_id reused with a different payload; nothing executed",
        }),
      )
      .with({ kind: "duplicate" }, ({ reply }) =>
        ack(conn, { ...ackPayload(commandId, reply), duplicate: true }),
      )
      .with({ kind: "unfinished" }, async (unfinished) => {
        const original = inFlight.get(unfinished.commandId);
        if (original?.awaited)
          return rejectRaw(conn, commandId, {
            code: "busy",
            message: "this command is still running; resend it once its reply arrives",
          });
        if (original) {
          original.awaited = true;
          ack(conn, { ...ackPayload(commandId, await original.reply), duplicate: true });
          return;
        }
        settleFailed(unfinished.commandId);
        ack(conn, { ...ackPayload(commandId, FAILED_AFTER_RECORD), duplicate: true });
      })
      .exhaustive();

  /**
   * The effect half of a message: adopt the connection on its first command, record, dispatch, finish, ack.
   * The command is recorded `received` before the engine runs and finished with the reply its ack carries,
   * so a duplicate is answered from the record, or from the original's reply while it is in flight, and never
   * runs twice. It never rejects: every failure is logged and answered.
   */
  const handleCommand = async (conn: Connection, command: ClientCommand): Promise<void> => {
    const commandId = command.message_id;
    let progress: Progress = { stage: "unrecorded" };
    let reply: PromiseWithResolvers<CommandReply> | null = null;
    let inFlightId: string | null = null;
    try {
      if (!conn.opened) {
        conn.clientId = command.client_id;
        conn.clientBuild =
          command.type === "diagnostic_snapshot" ? command.payload.diagnostics.build : null;
        options.writer.ensureClient(command.client_id, "text-client");
        options.writer.openConnection({
          connectionId: conn.id,
          clientId: command.client_id,
          build: conn.clientBuild,
        });
        conn.opened = true;
        options.engine.adoptConnection(conn.id, command.client_id);
      } else if (command.type === "diagnostic_snapshot" && !conn.clientBuild) {
        conn.clientBuild = command.payload.diagnostics.build;
      }
      options.writer.touchConnection(conn.id);
      const conversationId =
        "conversation_id" in command.payload ? command.payload.conversation_id : null;
      const recorded = options.writer.recordCommand({
        connectionId: conn.id,
        clientId: command.client_id,
        clientCommandId: command.message_id,
        type: command.type,
        payload: command.payload,
        conversationId,
      });
      if (recorded.kind !== "new") {
        progress = { stage: "answered" };
        await answerRecorded(conn, commandId, recorded);
        return;
      }
      progress = { stage: "recorded", commandId: recorded.commandId };
      reply = Promise.withResolvers<CommandReply>();
      inFlight.set(recorded.commandId, { reply: reply.promise, awaited: false });
      inFlightId = recorded.commandId;
      const result = replyFor(
        await options.engine.handle(
          {
            connectionId: conn.id,
            clientId: command.client_id,
            commandId: command.message_id,
            clientBuild: conn.clientBuild,
          },
          command,
        ),
      );
      if (!options.writer.finishCommand(recorded.commandId, result))
        options.log(
          `command ${recorded.commandId} already had a stored reply; this ack may differ`,
        );
      progress = { stage: "answered" };
      reply.resolve(result);
      ack(conn, ackPayload(commandId, result));
    } catch (error) {
      options.log(
        `command handling failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      match(progress)
        .with({ stage: "unrecorded" }, () =>
          rejectRaw(conn, commandId, {
            code: "internal",
            message: "internal error while handling the command; nothing executed",
          }),
        )
        .with({ stage: "recorded" }, (recorded) => {
          settleFailed(recorded.commandId);
          reply?.resolve(FAILED_AFTER_RECORD);
          ack(conn, ackPayload(commandId, FAILED_AFTER_RECORD));
        })
        // A second ack would contradict the first; a resend is answered from the record.
        .with({ stage: "answered" }, () => undefined)
        .exhaustive();
    } finally {
      // Resolved above unless the failure handling itself threw; a second resolve does nothing, so a waiting
      // duplicate always gets a reply.
      reply?.resolve(FAILED_AFTER_RECORD);
      if (inFlightId !== null) inFlight.delete(inFlightId);
    }
  };

  wss.on("connection", (socket) => {
    const conn: Connection = {
      id: `conn_${randomUUID().replace(/-/g, "")}`,
      socket,
      clientId: null,
      clientBuild: null,
      opened: false,
    };
    connections.set(conn.id, conn);
    options.log(`connection ${conn.id} opened`);

    socket.on("message", (data, isBinary) => {
      const decoded = decodeEnvelope({
        text: isBinary ? "" : data.toString("utf8"),
        isBinary,
        boundClientId: conn.clientId,
      });
      if (!decoded.ok)
        return rejectRaw(conn, decoded.commandId, {
          code: decoded.code,
          message: decoded.message,
        });
      const handled: Promise<void> = handleCommand(conn, decoded.command)
        .catch((error: unknown) => options.log(`command handling failed: ${errorMessage(error)}`))
        .then(() => {
          handling.delete(handled);
        });
      handling.add(handled);
    });

    socket.on("close", () => {
      connections.delete(conn.id);
      options.log(`connection ${conn.id} closed`);
      try {
        if (conn.opened) options.writer.closeConnection(conn.id);
      } catch (error) {
        options.log(`could not record connection close: ${String(error)}`);
      }
      options.engine.onDisconnect(conn.id);
    });
    socket.on("error", (error) => options.log(`socket error on ${conn.id}: ${error.message}`));
  });

  const listening = Promise.withResolvers<undefined>();
  httpServer.once("error", listening.reject);
  httpServer.listen(options.port, options.host, () => listening.resolve(undefined));
  await listening.promise;
  const address = httpServer.address();
  if (address === null || typeof address === "string")
    throw new Error("gateway is not listening on a TCP port");
  const detachDelivery = options.engine.attachDelivery(send);
  return {
    url: `ws://${options.host}:${address.port}`,
    port: address.port,
    send,
    close: async (commandWait) => {
      detachDelivery();
      for (const conn of connections.values()) conn.socket.close(1001, "server shutting down");
      const socketsClosed = once(wss, "close");
      wss.close();
      await socketsClosed;
      const httpClosed = once(httpServer, "close");
      httpServer.closeAllConnections();
      httpServer.close();
      await httpClosed;
      // A command still awaiting the engine stores its reply before the catalog behind the writer closes. Shutdown
      // abandons a start's I/O, so this is normally quick; only an fsync already under way can hold it.
      const gaveUp = Promise.withResolvers<undefined>();
      const onAbort = () => gaveUp.resolve(undefined);
      if (commandWait.aborted) onAbort();
      else commandWait.addEventListener("abort", onAbort, { once: true });
      await Promise.race([Promise.all(handling), gaveUp.promise]).finally(() =>
        commandWait.removeEventListener("abort", onAbort),
      );
    },
  };
};
