import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  ServerEventSchema,
  type ClientCommand,
  type ClientDiagnostics,
  type Decision,
  type ServerEvent,
  type ServerEventOf,
  type ServerEventType,
} from "@mia/protocol";

export interface MiaClientOptions {
  url: string;
  secret: string;
  clientId?: string;
  build: ClientDiagnostics["build"];
}

export type AckPayload = ServerEventOf<"ack">["payload"];

/**
 * Programmatic Mia client used by the terminal UI, the acceptance harness and the promptfoo provider.
 * Every command gets a unique message_id; resends reuse it (the server deduplicates).
 */
export class MiaClient extends EventEmitter {
  readonly clientId: string;
  private socket: WebSocket | null = null;
  private pendingAcks = new Map<string, (ack: AckPayload) => void>();
  readonly recentInteractionIds: string[] = [];
  readonly recentErrors: Array<{ at: string; message: string }> = [];
  connectionState: ClientDiagnostics["connection_state"] = "disconnected";
  conversationId: string | null = null;
  readonly events: ServerEvent[] = [];

  constructor(readonly options: MiaClientOptions) {
    super();
    this.clientId = options.clientId ?? `client_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  }

  static readSecret(path: string): string {
    return readFileSync(path, "utf8").trim();
  }

  async connect(): Promise<void> {
    this.connectionState = "connecting";
    const socket = new WebSocket(this.options.url, {
      headers: { authorization: `Bearer ${this.options.secret}` },
    });
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", (error) => reject(error));
      socket.once("unexpected-response", (_, res) =>
        reject(new Error(`server refused the connection: HTTP ${res.statusCode}`)),
      );
    });
    this.connectionState = "connected";
    socket.on("message", (data) => this.onMessage(data.toString("utf8")));
    socket.on("close", (code, reason) => {
      this.connectionState = "disconnected";
      this.emit("disconnected", { code, reason: reason.toString() });
    });
    socket.on("error", (error) => this.pushError(error.message));
  }

  private onMessage(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.pushError("server sent invalid JSON");
      return;
    }
    const event = ServerEventSchema.safeParse(parsed);
    if (!event.success) {
      this.pushError(`server sent an unrecognised event: ${event.error.message.slice(0, 200)}`);
      return;
    }
    const e = event.data;
    this.events.push(e);
    this.recentInteractionIds.push(e.message_id);
    if (this.recentInteractionIds.length > 50) this.recentInteractionIds.shift();
    if (e.type === "ack") {
      const waiter = this.pendingAcks.get(e.payload.command_id);
      if (waiter) {
        this.pendingAcks.delete(e.payload.command_id);
        waiter(e.payload);
      }
    }
    if (e.type === "conversation_started") this.conversationId = e.payload.conversation_id;
    if (e.type === "error") this.pushError(`${e.payload.code}: ${e.payload.message}`);
    this.emit("event", e);
    // "error" is reserved by EventEmitter; server error events are re-emitted as "server_error".
    this.emit(e.type === "error" ? "server_error" : e.type, e);
  }

  private pushError(message: string): void {
    this.recentErrors.push({ at: new Date().toISOString(), message });
    if (this.recentErrors.length > 20) this.recentErrors.shift();
    this.emit("client_error", message);
  }

  /** Send a command and wait for its acknowledgement. */
  send<T extends ClientCommand["type"]>(
    type: T,
    payload: Extract<ClientCommand, { type: T }>["payload"],
    messageId = `cmd_${randomUUID()}`,
  ): Promise<AckPayload> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("not connected"));
    const envelope = {
      protocol_version: PROTOCOL_VERSION,
      message_id: messageId,
      client_id: this.clientId,
      type,
      payload,
    };
    this.recentInteractionIds.push(messageId);
    return new Promise<AckPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(messageId);
        reject(new Error(`no acknowledgement for ${type} (${messageId}) within 30s`));
      }, 30_000);
      this.pendingAcks.set(messageId, (ack) => {
        clearTimeout(timer);
        resolve(ack);
      });
      socket.send(JSON.stringify(envelope));
    });
  }

  /** Send raw text (tests use this to exercise validation paths). */
  sendRaw(text: string): void {
    this.socket?.send(text);
  }

  diagnostics(): ClientDiagnostics {
    return {
      build: this.options.build,
      connection_state: this.connectionState,
      recent_interaction_ids: [...this.recentInteractionIds].slice(-20),
      recent_errors: [...this.recentErrors],
      voice: "not_applicable",
      display: "not_applicable",
      captured_at: new Date().toISOString(),
    };
  }

  async startConversation(): Promise<string> {
    const ack = await this.send("start_conversation", {});
    if (ack.disposition === "rejected")
      throw new Error(`start_conversation rejected: ${ack.error?.code}: ${ack.error?.message}`);
    const id = (ack.result?.conversation_id as string | undefined) ?? this.conversationId;
    if (!id) throw new Error("server did not return a conversation id");
    this.conversationId = id;
    return id;
  }

  submitText(text: string, messageId?: string): Promise<AckPayload> {
    if (!this.conversationId) throw new Error("no conversation");
    return this.send("submit_text", { conversation_id: this.conversationId, text }, messageId);
  }

  decide(
    taskId: string,
    approvalId: string,
    decision: Decision,
    messageId?: string,
  ): Promise<AckPayload> {
    if (!this.conversationId) throw new Error("no conversation");
    return this.send(
      "approval_decision",
      { conversation_id: this.conversationId, task_id: taskId, approval_id: approvalId, decision },
      messageId,
    );
  }

  interrupt(taskId: string, messageId?: string): Promise<AckPayload> {
    if (!this.conversationId) throw new Error("no conversation");
    return this.send(
      "interrupt_task",
      { conversation_id: this.conversationId, task_id: taskId },
      messageId,
    );
  }

  sendDiagnostics(): Promise<AckPayload> {
    return this.send("diagnostic_snapshot", {
      conversation_id: this.conversationId,
      diagnostics: this.diagnostics(),
    });
  }

  heartbeat(): Promise<AckPayload> {
    return this.send("heartbeat", {
      conversation_id: this.conversationId,
      captured_at: new Date().toISOString(),
      connection_state: this.connectionState,
    });
  }

  /** Wait for the next event of a type that satisfies the predicate. */
  waitFor<T extends ServerEventType>(
    type: T,
    predicate: (e: ServerEventOf<T>) => boolean = () => true,
    timeoutMs = 120_000,
  ): Promise<ServerEventOf<T>> {
    const existing = this.events.find(
      (e) => e.type === type && predicate(e as ServerEventOf<T>),
    ) as ServerEventOf<T> | undefined;
    if (existing) return Promise.resolve(existing);
    const channel = type === "error" ? "server_error" : type;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(channel, handler);
        reject(new Error(`timed out waiting for ${type}`));
      }, timeoutMs);
      const handler = (e: ServerEvent) => {
        if (predicate(e as ServerEventOf<T>)) {
          clearTimeout(timer);
          this.off(channel, handler);
          resolve(e as ServerEventOf<T>);
        }
      };
      this.on(channel, handler);
    });
  }

  close(): void {
    this.socket?.close(1000, "client closing");
  }
}
