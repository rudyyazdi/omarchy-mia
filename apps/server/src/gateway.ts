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
import { nowIso, type CommandReply, type RecordedCommand, type RecordWriter } from "@mia/records";
import { decodeEnvelope } from "./decode.ts";
import type { CommandResult, Delivery, Engine } from "./engine.ts";

export interface GatewayOptions {
  host: "127.0.0.1";
  port: number;
  secretFile: string;
  engine: Engine;
  writer: RecordWriter;
  log: (message: string) => void;
}

export interface GatewayHandle {
  url: string;
  port: number;
  /** Deliver an event to one connection; attached to the engine while the gateway is open. */
  send: Delivery;
  close(): Promise<void>;
}

/** Load or create the local client secret (0600, outside Git). Never logged. */
export const loadOrCreateSecret = (path: string): string => {
  // eslint-disable-next-line no-restricted-syntax -- runs before serving: startGateway loads the secret before it listens, and no runtime can reach the bridge yet
  if (existsSync(path)) {
    // eslint-disable-next-line no-restricted-syntax -- runs before serving
    const secret = readFileSync(path, "utf8").trim();
    if (secret.length < 32)
      throw new Error(`secret file ${path} is too short; delete it to regenerate`);
    registerSecret(secret);
    return secret;
  }
  // eslint-disable-next-line no-restricted-syntax -- runs before serving
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString("hex");
  // eslint-disable-next-line no-restricted-syntax -- runs before serving
  writeFileSync(path, secret + "\n", { mode: 0o600 });
  // eslint-disable-next-line no-restricted-syntax -- runs before serving
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
 * duplicate found it still `received` (dispatch is synchronous, so that means the original never finished).
 * The engine may have acted on it, so it is never run again.
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
  const secret = loadOrCreateSecret(options.secretFile);
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
      server_time: nowIso(),
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
      .with({ kind: "unfinished" }, (unfinished) => {
        settleFailed(unfinished.commandId);
        ack(conn, { ...ackPayload(commandId, FAILED_AFTER_RECORD), duplicate: true });
      })
      .exhaustive();

  /**
   * The effect half of a message: adopt the connection on its first command, record, dispatch, finish, ack.
   * The command is recorded `received` before the engine runs and finished with the reply its ack carries,
   * so a duplicate is answered from the record and never runs twice.
   */
  const handleCommand = (conn: Connection, command: ClientCommand) => {
    const commandId = command.message_id;
    let progress: Progress = { stage: "unrecorded" };
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
        return answerRecorded(conn, commandId, recorded);
      }
      progress = { stage: "recorded", commandId: recorded.commandId };
      const reply = replyFor(
        options.engine.handle(
          {
            connectionId: conn.id,
            clientId: command.client_id,
            commandId: command.message_id,
            clientBuild: conn.clientBuild,
          },
          command,
        ),
      );
      options.writer.finishCommand(recorded.commandId, reply);
      progress = { stage: "answered" };
      ack(conn, ackPayload(commandId, reply));
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
          ack(conn, ackPayload(commandId, FAILED_AFTER_RECORD));
        })
        // A second ack would contradict the first; a resend is answered from the record.
        .with({ stage: "answered" }, () => undefined)
        .exhaustive();
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
      handleCommand(conn, decoded.command);
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
    close: async () => {
      detachDelivery();
      for (const conn of connections.values()) conn.socket.close(1001, "server shutting down");
      const socketsClosed = once(wss, "close");
      wss.close();
      await socketsClosed;
      const httpClosed = once(httpServer, "close");
      httpServer.closeAllConnections();
      httpServer.close();
      await httpClosed;
    },
  };
};
