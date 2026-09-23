import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  ServerEventSchema,
  type Cancellable,
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
/** An ack for a command that was accepted: it may carry a result. */
export type AcceptedAck = Extract<AckPayload, { disposition: "accepted" }>;
/** An ack for a command that was rejected or failed: it always carries the error. */
export type RefusedAck = Exclude<AckPayload, AcceptedAck>;

/** A command's options; a resend passes the original command's `messageId`. */
export interface SendOptions extends Cancellable {
  messageId?: string;
}

const isEventOf =
  <T extends ServerEventType>(type: T) =>
  (event: ServerEvent): event is ServerEventOf<T> =>
    event.type === type;

/**
 * Programmatic Mia client used by the terminal UI, the acceptance harness and the promptfoo provider.
 * Every command gets a unique message_id; a resend reuses it, and the server answers it with the original
 * reply marked `duplicate` instead of running it again. The server keys that on `clientId`, which an instance
 * keeps across `connect()` calls; a new instance (after a restart, say) without an explicit `clientId` gets
 * a fresh one, so dedupe does not survive it. An abort while an operation is still waiting rejects it with
 * the signal's reason.
 */
export class MiaClient extends EventEmitter {
  readonly clientId: string;
  private socket: WebSocket | null = null;
  // Each waiter settles exactly once: by its ack, its caller's signal, or the socket closing first.
  private pendingAcks = new Map<
    string,
    { acknowledge: (ack: AckPayload) => void; abandon: () => void }
  >();
  // Like an ack, an awaited event cannot arrive on a closed socket: each entry rejects its `waitFor`.
  private pendingWaits = new Set<() => void>();
  readonly recentInteractionIds: string[] = [];
  readonly recentErrors: { at: string; message: string }[] = [];
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

  async connect({ signal }: Cancellable = {}): Promise<void> {
    signal?.throwIfAborted();
    this.connectionState = "connecting";
    const socket = new WebSocket(this.options.url, {
      headers: { authorization: `Bearer ${this.options.secret}` },
    });
    this.socket = socket;
    const { promise, resolve, reject } = Promise.withResolvers<undefined>();
    socket.once("open", () => resolve(undefined));
    // Stays attached after an abort: terminating a connecting socket emits "error" on the next tick.
    socket.once("error", (error) => reject(error));
    socket.once("unexpected-response", (_, res) =>
      reject(new Error(`server refused the connection: HTTP ${res.statusCode}`)),
    );
    // An abort after "open" but before this resumes leaves the connection alone, since connect() resolves.
    const onAbort = () => {
      if (socket.readyState === WebSocket.CONNECTING) reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await promise;
    } catch (error) {
      // A refused upgrade leaves the socket connecting; terminating one already closed does nothing.
      socket.terminate();
      this.connectionState = "disconnected";
      // A wait started before or during the handshake would otherwise outlive the connection it waited on.
      this.abandonPending();
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    this.connectionState = "connected";
    socket.on("message", (data) => this.onMessage(data.toString("utf8")));
    socket.on("close", (code, reason) => {
      this.connectionState = "disconnected";
      this.abandonPending();
      this.emit("disconnected", { code, reason: reason.toString() });
    });
    socket.on("error", (error) => this.pushError(error.message));
  }

  /** No ack or event can arrive on a closed socket, so its waiters fail now rather than at their caller's deadline. */
  private abandonPending(): void {
    for (const waiter of this.pendingAcks.values()) waiter.abandon();
    this.pendingAcks.clear();
    for (const abandon of this.pendingWaits) abandon();
    this.pendingWaits.clear();
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
    const serverEvent = event.data;
    this.events.push(serverEvent);
    this.recentInteractionIds.push(serverEvent.message_id);
    if (this.recentInteractionIds.length > 50) this.recentInteractionIds.shift();
    if (serverEvent.type === "ack") {
      const waiter = this.pendingAcks.get(serverEvent.payload.command_id);
      if (waiter) {
        this.pendingAcks.delete(serverEvent.payload.command_id);
        waiter.acknowledge(serverEvent.payload);
      }
    }
    if (serverEvent.type === "conversation_started")
      this.conversationId = serverEvent.payload.conversation_id;
    if (serverEvent.type === "error")
      this.pushError(`${serverEvent.payload.code}: ${serverEvent.payload.message}`);
    this.emit("event", serverEvent);
    // "error" is reserved by EventEmitter; server error events are re-emitted as "server_error".
    this.emit(serverEvent.type === "error" ? "server_error" : serverEvent.type, serverEvent);
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
    { messageId = `cmd_${randomUUID()}`, signal }: SendOptions = {},
  ): Promise<AckPayload> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("not connected"));
    if (signal?.aborted) return Promise.reject(signal.reason);
    const envelope = {
      protocol_version: PROTOCOL_VERSION,
      message_id: messageId,
      client_id: this.clientId,
      type,
      payload,
    };
    this.recentInteractionIds.push(messageId);
    const { promise, resolve, reject } = Promise.withResolvers<AckPayload>();
    const waiter = {
      acknowledge: resolve,
      abandon: () =>
        reject(new Error(`connection closed before ${type} (${messageId}) was acknowledged`)),
    };
    // Removes only this send's waiter: a resend with the same id may have replaced it.
    const forget = () => {
      if (this.pendingAcks.get(messageId) === waiter) this.pendingAcks.delete(messageId);
    };
    const onAbort = () => {
      forget();
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    this.pendingAcks.set(messageId, waiter);
    try {
      socket.send(JSON.stringify(envelope));
    } catch (error) {
      forget();
      reject(error);
    }
    return promise.finally(() => signal?.removeEventListener("abort", onAbort));
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

  async startConversation({ signal }: Cancellable = {}): Promise<string> {
    const ack = await this.send("start_conversation", {}, { signal });
    if (ack.disposition !== "accepted")
      throw new Error(
        `start_conversation ${ack.disposition}: ${ack.error.code}: ${ack.error.message}`,
      );
    const fromResult = ack.result?.conversation_id;
    const id = typeof fromResult === "string" ? fromResult : this.conversationId;
    if (!id) throw new Error("server did not return a conversation id");
    this.conversationId = id;
    return id;
  }

  submitText(text: string, options: SendOptions = {}): Promise<AckPayload> {
    if (!this.conversationId) throw new Error("no conversation");
    return this.send("submit_text", { conversation_id: this.conversationId, text }, options);
  }

  decide({
    taskId,
    approvalId,
    decision,
    ...options
  }: SendOptions & {
    taskId: string;
    approvalId: string;
    decision: Decision;
  }): Promise<AckPayload> {
    if (!this.conversationId) throw new Error("no conversation");
    return this.send(
      "approval_decision",
      { conversation_id: this.conversationId, task_id: taskId, approval_id: approvalId, decision },
      options,
    );
  }

  interrupt(taskId: string, options: SendOptions = {}): Promise<AckPayload> {
    if (!this.conversationId) throw new Error("no conversation");
    return this.send(
      "interrupt_task",
      { conversation_id: this.conversationId, task_id: taskId },
      options,
    );
  }

  sendDiagnostics({ signal }: Cancellable = {}): Promise<AckPayload> {
    return this.send(
      "diagnostic_snapshot",
      { conversation_id: this.conversationId, diagnostics: this.diagnostics() },
      { signal },
    );
  }

  heartbeat({ signal }: Cancellable = {}): Promise<AckPayload> {
    return this.send(
      "heartbeat",
      {
        conversation_id: this.conversationId,
        captured_at: new Date().toISOString(),
        connection_state: this.connectionState,
      },
      { signal },
    );
  }

  /**
   * Wait for the next event of a type that satisfies the predicate. An event already received resolves at once, even
   * after the connection closed; otherwise the wait rejects when the connection closes.
   */
  waitFor<T extends ServerEventType>(
    type: T,
    predicate: (event: ServerEventOf<T>) => boolean = () => true,
    { signal }: Cancellable = {},
  ): Promise<ServerEventOf<T>> {
    const isWanted = isEventOf(type);
    const existing = this.events.find(
      (event): event is ServerEventOf<T> => isWanted(event) && predicate(event),
    );
    if (existing) return Promise.resolve(existing);
    if (signal?.aborted) return Promise.reject(signal.reason);
    const closed = new Error(`connection closed while waiting for ${type}`);
    // Only a socket that is closing or closed (including one whose handshake failed) rejects at once; with no socket
    // yet, or one still connecting, the wait is registered and the events may still come.
    const state = this.socket?.readyState;
    if (state === WebSocket.CLOSING || state === WebSocket.CLOSED) return Promise.reject(closed);
    const channel = type === "error" ? "server_error" : type;
    const { promise, resolve, reject } = Promise.withResolvers<ServerEventOf<T>>();
    const onAbort = () => reject(signal?.reason);
    const abandon = () => reject(closed);
    const handler = (event: ServerEvent) => {
      if (isWanted(event) && predicate(event)) resolve(event);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    this.pendingWaits.add(abandon);
    this.on(channel, handler);
    return promise.finally(() => {
      signal?.removeEventListener("abort", onAbort);
      this.pendingWaits.delete(abandon);
      this.off(channel, handler);
    });
  }

  close(): void {
    this.socket?.close(1000, "client closing");
  }
}
