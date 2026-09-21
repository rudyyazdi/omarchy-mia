import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { dirname } from "node:path";
import { match } from "ts-pattern";
import { WebSocketServer, type WebSocket } from "ws";
import {
  ClientCommandSchema,
  EnvelopeHeadSchema,
  LIMITS,
  PROTOCOL_VERSION,
  registerSecret,
  type ClientCommand,
  type ErrorCode,
  type ServerEvent,
} from "@mia/protocol";
import { nowIso, type RecordWriter } from "@mia/records";
import type { CommandContext, CommandResult, Engine } from "./engine.ts";

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
  /** Deliver an event to one connection; the server wires this into the engine. */
  send: (connectionId: string, event: ServerEvent) => void;
  close(): Promise<void>;
}

/** Load or create the local client secret (0600, outside Git). Never logged. */
export const loadOrCreateSecret = (path: string): string => {
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

interface ConnectionState {
  id: string;
  socket: WebSocket;
  clientId: string | null;
  clientBuild: unknown;
  opened: boolean;
}

interface AckReply {
  commandId: string;
  disposition: "accepted" | "duplicate" | "rejected";
  error?: { code: ErrorCode; message: string };
  result?: Record<string, unknown>;
}

const dispatch = (engine: Engine, ctx: CommandContext, command: ClientCommand): CommandResult =>
  match(command)
    .with({ type: "start_conversation" }, () => engine.startConversation(ctx))
    .with({ type: "submit_text" }, (cmd) => engine.submitText(ctx, cmd.payload))
    .with({ type: "approval_decision" }, (cmd) => engine.approvalDecision(ctx, cmd.payload))
    .with({ type: "interrupt_task" }, (cmd) => engine.interruptTask(ctx, cmd.payload))
    .with({ type: "diagnostic_snapshot" }, (cmd) => engine.diagnosticSnapshot(ctx, cmd.payload))
    .with({ type: "heartbeat" }, (cmd) => engine.heartbeat(ctx, cmd.payload))
    .exhaustive();

/**
 * Client gateway: loopback-only, bearer-authenticated WebSocket. Validates every envelope before any state
 * changes, deduplicates command IDs per connection, acknowledges every command, and delivers events.
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
  const connections = new Map<string, ConnectionState>();

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

  const ack = (conn: ConnectionState, reply: AckReply) => {
    const { commandId, ...rest } = reply;
    const event: ServerEvent = {
      protocol_version: PROTOCOL_VERSION,
      message_id: randomUUID(),
      type: "ack",
      conversation_id: options.engine.conversation?.id ?? null,
      sequence: null,
      server_time: nowIso(),
      payload: { command_id: commandId, ...rest },
    };
    if (conn.socket.readyState === conn.socket.OPEN) conn.socket.send(JSON.stringify(event));
  };

  const rejectRaw = (
    conn: ConnectionState,
    commandId: string,
    error: { code: ErrorCode; message: string },
  ) => {
    ack(conn, { commandId, disposition: "rejected", error });
  };

  wss.on("connection", (socket) => {
    const conn: ConnectionState = {
      id: `conn_${randomUUID().replace(/-/g, "")}`,
      socket,
      clientId: null,
      clientBuild: null,
      opened: false,
    };
    connections.set(conn.id, conn);
    options.log(`connection ${conn.id} opened`);

    socket.on("message", (data, isBinary) => {
      if (isBinary)
        return rejectRaw(conn, "unknown", {
          code: "invalid_message",
          message: "binary frames are not accepted",
        });
      const text = data.toString("utf8");
      if (text.length > LIMITS.maxEnvelopeBytes)
        return rejectRaw(conn, "unknown", {
          code: "invalid_message",
          message: `envelope exceeds ${LIMITS.maxEnvelopeBytes} bytes`,
        });
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return rejectRaw(conn, "unknown", {
          code: "invalid_message",
          message: "envelope is not valid JSON",
        });
      }
      const head = EnvelopeHeadSchema.safeParse(json);
      const commandId =
        head.success && typeof head.data.message_id === "string" ? head.data.message_id : "unknown";
      if (!head.success)
        return rejectRaw(conn, commandId, {
          code: "invalid_message",
          message: "envelope must carry protocol_version, message_id, client_id, type and payload",
        });
      if (head.data.protocol_version !== PROTOCOL_VERSION) {
        return rejectRaw(conn, commandId, {
          code: "unsupported_protocol_version",
          message: `this server speaks protocol_version ${PROTOCOL_VERSION}; received ${JSON.stringify(head.data.protocol_version)}. Upgrade the client or server.`,
        });
      }
      const parsed = ClientCommandSchema.safeParse(json);
      if (!parsed.success) {
        return rejectRaw(conn, commandId, {
          code: "invalid_message",
          message: `invalid ${String(head.data.type)} command: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
        });
      }
      const command = parsed.data;
      if (conn.clientId && conn.clientId !== command.client_id)
        return rejectRaw(conn, commandId, {
          code: "invalid_message",
          message: "client_id changed within a connection",
        });
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
        if (recorded.duplicate) {
          if (!recorded.sameDigest)
            return rejectRaw(conn, commandId, {
              code: "duplicate_command_conflict",
              message: "message_id reused with a different payload; nothing executed",
            });
          return ack(conn, {
            commandId,
            disposition: "duplicate",
            ...(recorded.error
              ? { error: { code: "invalid_state", message: recorded.error } }
              : {}),
          });
        }
        const result = dispatch(
          options.engine,
          {
            connectionId: conn.id,
            clientId: command.client_id,
            commandId: command.message_id,
            clientBuild: conn.clientBuild,
          },
          command,
        );
        if (result.ok) {
          options.writer.finishCommand(recorded.commandId, {
            disposition: "accepted",
            error: null,
            resultEventId: null,
          });
          ack(conn, {
            commandId,
            disposition: "accepted",
            ...(result.result ? { result: result.result } : {}),
          });
        } else {
          options.writer.finishCommand(recorded.commandId, {
            disposition: "rejected",
            error: `${result.code}: ${result.message}`,
            resultEventId: null,
          });
          ack(conn, {
            commandId,
            disposition: "rejected",
            error: { code: result.code, message: result.message },
          });
        }
      } catch (error) {
        options.log(
          `command handling failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
        rejectRaw(conn, commandId, {
          code: "internal",
          message: "internal error while handling the command; nothing executed",
        });
      }
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

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host, () => resolve());
  });
  const address = httpServer.address();
  if (address === null || typeof address === "string")
    throw new Error("gateway is not listening on a TCP port");
  return {
    url: `ws://${options.host}:${address.port}`,
    port: address.port,
    send,
    close: async () => {
      for (const conn of connections.values()) conn.socket.close(1001, "server shutting down");
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      });
    },
  };
};
