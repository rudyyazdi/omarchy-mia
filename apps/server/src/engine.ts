import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  readHookEvidence,
  type AdapterEvent,
  type PermissionDecision,
  type PermissionRequest,
  type TurnHandle,
  type TurnOptions,
  type TurnResult,
} from "@mia/agent-adapter";
import { PROTOCOL_VERSION, canonicalDigest, redactValue, sha256Hex, type ClientDiagnostics, type Decision, type ErrorCode, type EventPayload, type ServerEvent, type ServerEventType, type TaskStatus, type ToolCallStatus } from "@mia/protocol";
import { newId, nowIso, type Catalog, type RecordWriter } from "@mia/records";
import type { Profile } from "./config.ts";
import { createConversationProvenance } from "./provenance.ts";

/** What the engine needs from an adapter; the real ClaudeCodeAdapter and scripted test substitutes both satisfy it. */
export interface TurnRunner {
  submitTurn(options: TurnOptions): TurnHandle;
}

export interface CommandContext {
  connectionId: string;
  clientId: string;
  commandId: string;
  clientBuild: unknown;
}

export type CommandResult = { ok: true; result?: Record<string, unknown> } | { ok: false; code: ErrorCode; message: string };

interface ToolCallState {
  id: string;
  runtimeCallId: string;
  revision: number;
  toolIdentity: string;
  digest: string;
  redactedArguments: unknown;
  policy: string;
  status: ToolCallStatus;
  approvalId: string | null;
  resolve: ((decision: PermissionDecision) => void) | null;
}

interface TaskState {
  id: string;
  executionId: string;
  epoch: number;
  status: TaskStatus;
  gateOpen: boolean;
  interrupted: boolean;
  handle: TurnHandle | null;
  calls: Map<string, ToolCallState[]>;
  pendingApprovals: Map<string, ToolCallState>;
  /** Calls whose held approval prompt the runtime dropped before a decision; never released. */
  abandoned: ToolCallState[];
  clientId: string;
  reportedModel: string | null;
  finished: Promise<void>;
}

interface ConversationState {
  id: string;
  runtimeConversationId: string;
  provenanceSetId: string;
  directory: string;
  /** Retained copy of the agent prompt used for every turn of this conversation. */
  promptFile: string;
  turnCount: number;
  epoch: number;
  /** Mia-authored note carried into the next runtime turn after an interruption or unknown outcome. */
  pendingNote: string | null;
}

export interface EngineDeps {
  profile: Profile;
  catalog: Catalog;
  writer: RecordWriter;
  adapter: TurnRunner;
  sourceRoot: string;
  log: (message: string) => void;
}

const RUNTIME_IDENTITY = "claude-code";
const TERMINAL: ReadonlySet<ToolCallStatus> = new Set(["denied", "blocked_gate", "invalidated", "completed", "failed", "cancelled", "unknown"]);

/**
 * Conversation/task coordinator plus approval and interruption controller. One conversation, one task,
 * one active client. Every state transition is persisted in the same transaction as its event; client
 * notifications queued during a transaction are delivered only after it commits.
 */
export class Engine {
  conversation: ConversationState | null = null;
  task: TaskState | null = null;
  activeConnectionId: string | null = null;
  activeClientId: string | null = null;
  /** Delivers events to a connection; set by the gateway once it is listening. */
  send: (connectionId: string, event: ServerEvent) => void = () => undefined;
  /**
   * Work deferred until the current transaction commits: client event deliveries and runtime permission settlements
   * (approve/deny of a held call). Nothing observable leaves the engine before its record is durable.
   */
  private afterCommit: Array<() => void> = [];

  constructor(private readonly deps: EngineDeps) {}

  // ---------------------------------------------------------------- event plumbing

  /** Run fn in one catalog transaction; queued client sends go out after commit and are dropped on failure. */
  private tx<T>(fn: () => T): T {
    try {
      const result = this.deps.catalog.transaction(fn);
      const deferred = this.afterCommit;
      this.afterCommit = [];
      for (const fn of deferred) fn();
      return result;
    } catch (error) {
      this.afterCommit = [];
      throw error;
    }
  }

  private deliver<T extends ServerEventType>(type: T, id: string, sequence: number | null, payload: EventPayload<T>): void {
    const connectionId = this.activeConnectionId;
    if (!connectionId) return;
    this.send(connectionId, {
      protocol_version: PROTOCOL_VERSION,
      message_id: id,
      type,
      conversation_id: this.conversation?.id ?? null,
      sequence,
      server_time: nowIso(),
      payload,
    } as ServerEvent);
  }

  /** Persist an event (inside tx) and queue its delivery with the persisted id and sequence. */
  private emit<T extends ServerEventType>(type: T, payload: EventPayload<T>, opts: { taskId?: string | null; executionId?: string | null; causedBy?: string | null } = {}): { id: string; sequence: number } {
    const ev = this.record(type, payload, opts);
    this.afterCommit.push(() => this.deliver(type, ev.id, ev.sequence, payload));
    return ev;
  }

  /** Persist evidence that has no client-facing schema (inside tx). */
  private record(type: string, payload: unknown, opts: { taskId?: string | null; executionId?: string | null; causedBy?: string | null } = {}): { id: string; sequence: number } {
    const appended = this.deps.writer.appendEvent({
      conversationId: this.conversation!.id,
      type,
      payload,
      taskId: opts.taskId ?? null,
      executionId: opts.executionId ?? null,
      clientId: this.activeClientId,
      clientConnectionId: this.activeConnectionId,
      causedByEventId: opts.causedBy ?? null,
    });
    return { id: appended.id, sequence: appended.sequence };
  }

  /** Unpersisted status notification (tool call progress); the durable evidence is the underlying events. */
  private notifyToolCall(task: TaskState, call: ToolCallState, detail?: string): void {
    this.deliver("tool_call", newId("evt"), null, {
      conversation_id: this.conversation!.id,
      task_id: task.id,
      tool_call_id: call.id,
      runtime_call_id: call.runtimeCallId,
      tool_identity: call.toolIdentity,
      status: call.status,
      ...(detail ? { detail } : {}),
      redacted_arguments: call.redactedArguments,
    });
  }

  // ---------------------------------------------------------------- commands

  startConversation(ctx: CommandContext): CommandResult {
    if (this.task) return { ok: false, code: "busy", message: "a task is running; interrupt it or wait before starting a new conversation" };
    if (this.conversation && this.activeConnectionId && this.activeConnectionId !== ctx.connectionId) {
      return { ok: false, code: "busy", message: "another client owns the active conversation" };
    }
    const { writer, profile } = this.deps;
    const previous = { conversation: this.conversation, connection: this.activeConnectionId, client: this.activeClientId };
    try {
      return this.tx(() => {
        const provenance = createConversationProvenance(writer, profile, ctx.clientBuild, this.deps.sourceRoot);
        const runtimeConversationId = randomUUID();
        const conv = writer.createConversation({ provenanceSetId: provenance.provenance_set_id, runtimeConversationId });
        writer.linkProvenanceSet(conv.id, provenance.provenance_set_id);
        if (previous.conversation) writer.updateConversation(previous.conversation.id, { status: "closed" });
        // Every turn of this conversation appends exactly the prompt bytes recorded in provenance.
        const promptFile = join(conv.directory, "agent-prompt.md");
        writeFileSync(promptFile, existsSync(profile.runtime.agentPromptFile) ? readFileSync(profile.runtime.agentPromptFile) : "", { mode: 0o600 });
        this.conversation = { id: conv.id, runtimeConversationId, provenanceSetId: provenance.provenance_set_id, directory: conv.directory, promptFile, turnCount: 0, epoch: 0, pendingNote: null };
        this.activeConnectionId = ctx.connectionId;
        this.activeClientId = ctx.clientId;
        this.record("provenance_recorded", provenance);
        this.emit("conversation_started", { conversation_id: conv.id, started_at: conv.startedAt, provenance_set_id: provenance.provenance_set_id });
        return { ok: true, result: { conversation_id: conv.id, provenance_set_id: provenance.provenance_set_id } };
      });
    } catch (error) {
      this.conversation = previous.conversation;
      this.activeConnectionId = previous.connection;
      this.activeClientId = previous.client;
      return { ok: false, code: "record_failure", message: `could not create conversation: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  submitText(ctx: CommandContext, payload: { conversation_id: string; text: string }): CommandResult {
    const guard = this.guard(ctx, payload.conversation_id);
    if (guard) return guard;
    const conversation = this.conversation!;
    if (this.task) {
      const pending = [...this.task.pendingApprovals.keys()];
      const hint = pending.length > 0 ? `approve or reject ${pending.join(", ")}, or interrupt it` : "wait for it to finish or interrupt it";
      return { ok: false, code: "busy", message: `task ${this.task.id} is ${this.task.status}; ${hint}` };
    }
    const { writer, profile } = this.deps;
    const epoch = conversation.epoch + 1;
    const turnIndex = conversation.turnCount + 1;
    const note = conversation.pendingNote;
    const runtimePrompt = note ? `${note}\n\n${payload.text}` : payload.text;
    let ids: { taskId: string; executionId: string };
    try {
      ids = this.tx(() => {
        const taskId = writer.createTask({ conversationId: conversation.id, text: payload.text, clientId: ctx.clientId });
        const executionId = writer.createExecution({
          taskId,
          conversationId: conversation.id,
          runtimeIdentity: RUNTIME_IDENTITY,
          runtimeConversationId: conversation.runtimeConversationId,
          requestedModel: profile.runtime.model,
          requestedEffort: profile.runtime.effort,
          provenanceSetId: conversation.provenanceSetId,
          executionEpoch: epoch,
        });
        const opts = { taskId, executionId };
        this.record("task_submitted", { text: payload.text, runtime_prompt: runtimePrompt, mia_note: note, command_id: ctx.commandId }, opts);
        this.emit("task_started", { conversation_id: conversation.id, task_id: taskId, execution_id: executionId, execution_epoch: epoch, text: payload.text }, opts);
        return { taskId, executionId };
      });
    } catch (error) {
      return { ok: false, code: "record_failure", message: `could not record task: ${error instanceof Error ? error.message : String(error)}` };
    }
    conversation.epoch = epoch;
    conversation.turnCount = turnIndex;
    conversation.pendingNote = null;
    let resolveFinished: () => void = () => undefined;
    const task: TaskState = {
      id: ids.taskId,
      executionId: ids.executionId,
      epoch,
      status: "running",
      gateOpen: true,
      interrupted: false,
      handle: null,
      calls: new Map(),
      pendingApprovals: new Map(),
      abandoned: [],
      clientId: ctx.clientId,
      reportedModel: null,
      finished: new Promise<void>((r) => {
        resolveFinished = r;
      }),
    };
    this.task = task;
    const handle = this.deps.adapter.submitTurn({
      text: runtimePrompt,
      runtimeConversationId: conversation.runtimeConversationId,
      firstTurn: turnIndex === 1,
      runtimeDir: resolve(conversation.directory, "runtime"),
      turnIndex,
      agentPromptFile: conversation.promptFile,
      permissionHandler: (req) => this.handlePermission(task, req),
      onEvent: (event) => this.onAdapterEvent(task, event),
    });
    task.handle = handle;
    void handle.result
      .then((result) => this.finishTurn(task, result))
      .catch((error) => this.deps.log(`finishTurn failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`))
      .finally(() => {
        if (this.task === task) this.task = null;
        resolveFinished();
      });
    return { ok: true, result: { task_id: task.id, execution_id: task.executionId, execution_epoch: epoch } };
  }

  approvalDecision(ctx: CommandContext, payload: { conversation_id: string; task_id: string; approval_id: string; decision: Decision }): CommandResult {
    const guard = this.guard(ctx, payload.conversation_id);
    if (guard) return guard;
    const task = this.task;
    if (!task || task.id !== payload.task_id) {
      const known = this.deps.catalog.get<{ status: string; task_id: string }>("SELECT a.status, t.task_id FROM approvals a JOIN tool_calls t ON t.id = a.tool_call_id WHERE a.id = ?", payload.approval_id);
      if (known && known.task_id === payload.task_id) return { ok: false, code: "invalid_state", message: `approval ${payload.approval_id} is ${known.status} and task ${payload.task_id} is no longer active; a decision cannot be reused` };
      return { ok: false, code: "not_found", message: `task ${payload.task_id} is not the active task` };
    }
    if (ctx.clientId !== task.clientId) return { ok: false, code: "unauthenticated", message: "decision must come from the client that owns the task" };
    const call = task.pendingApprovals.get(payload.approval_id);
    if (!call || call.status !== "awaiting_approval" || !call.approvalId) {
      const known = this.deps.catalog.get<{ status: string }>("SELECT status FROM approvals WHERE id = ?", payload.approval_id);
      if (known) return { ok: false, code: "invalid_state", message: `approval ${payload.approval_id} is ${known.status}, not pending; a decision cannot be reused` };
      return { ok: false, code: "not_found", message: `approval ${payload.approval_id} does not exist for this task` };
    }
    const approvalId = call.approvalId;
    const approve = payload.decision === "approve";
    const conversation = this.conversation!;
    const opts = { taskId: task.id, executionId: task.executionId };
    // Release only if the gate is still open in the current epoch; the decision is persisted before any release.
    const release = approve && task.gateOpen && task.epoch === conversation.epoch;
    const nextStatus: ToolCallStatus = release ? "dispatched" : approve ? "blocked_gate" : "denied";
    try {
      this.tx(() => {
        const { writer } = this.deps;
        const decided = this.emit("approval_resolved", { conversation_id: conversation.id, task_id: task.id, approval_id: approvalId, tool_call_id: call.id, status: approve ? "approved" : "rejected" }, opts);
        writer.updateApproval(approvalId, { status: approve ? "approved" : "rejected", decisionEventId: decided.id, decisionClientId: ctx.clientId });
        if (release) {
          const dispatched = this.record("tool_dispatched", { tool_call_id: call.id, runtime_call_id: call.runtimeCallId, tool_identity: call.toolIdentity, policy: call.policy, via: "approval" }, { ...opts, causedBy: decided.id });
          writer.updateToolCall(call.id, { status: "dispatched", dispatchEventId: dispatched.id });
        } else {
          writer.updateToolCall(call.id, { status: nextStatus, detail: approve ? "approved after the action gate closed; not released" : "rejected by user" });
        }
      });
    } catch (error) {
      // Record failure: the call stays held and pending; nothing is released.
      return { ok: false, code: "record_failure", message: `decision not recorded; call remains held: ${error instanceof Error ? error.message : String(error)}` };
    }
    call.status = nextStatus;
    task.pendingApprovals.delete(approvalId);
    if (task.pendingApprovals.size === 0 && task.status === "awaiting_approval") task.status = "running";
    this.notifyToolCall(task, call, release ? undefined : approve ? "approved after gate closed" : "rejected");
    this.settle(call, release ? { behavior: "allow" } : { behavior: "deny", message: approve ? "Mia blocked this call: the task was interrupted before it could be released." : "The user rejected this call. Do not retry it." });
    return { ok: true, result: { approval_id: approvalId, released: release, decision: payload.decision } };
  }

  interruptTask(ctx: CommandContext, payload: { conversation_id: string; task_id: string }): CommandResult {
    const guard = this.guard(ctx, payload.conversation_id);
    if (guard) return guard;
    const task = this.task;
    if (!task || task.id !== payload.task_id) return { ok: false, code: "not_found", message: `task ${payload.task_id} is not the active task` };
    if (task.status === "interrupting") return { ok: true, result: { already_interrupting: true } };
    if (task.status !== "running" && task.status !== "awaiting_approval") return { ok: false, code: "invalid_state", message: `task is ${task.status}` };
    const conversation = this.conversation!;
    const epoch = conversation.epoch + 1;
    const pending = [...task.pendingApprovals.values()];
    const opts = { taskId: task.id, executionId: task.executionId };
    try {
      // Atomically: close the gate, advance the epoch, invalidate pending approvals, record the order. Memory changes after commit.
      this.tx(() => {
        const requested = this.emit("interruption_requested", { conversation_id: conversation.id, task_id: task.id, execution_epoch: epoch }, opts);
        for (const call of pending) {
          this.deps.writer.updateApproval(call.approvalId!, { status: "invalidated", reason: "interrupted", decisionEventId: requested.id });
          this.deps.writer.updateToolCall(call.id, { status: "invalidated", detail: "pending approval invalidated by interruption" });
          this.emit("approval_resolved", { conversation_id: conversation.id, task_id: task.id, approval_id: call.approvalId!, tool_call_id: call.id, status: "invalidated", reason: "interrupted" }, { ...opts, causedBy: requested.id });
        }
        this.deps.writer.updateTask(task.id, { status: "interrupting" });
      });
    } catch (error) {
      return { ok: false, code: "record_failure", message: `interruption not recorded: ${error instanceof Error ? error.message : String(error)}` };
    }
    task.gateOpen = false;
    task.interrupted = true;
    task.status = "interrupting";
    conversation.epoch = epoch;
    task.pendingApprovals.clear();
    for (const call of pending) {
      call.status = "invalidated";
      this.notifyToolCall(task, call, "interrupted");
      this.settle(call, { behavior: "deny", message: "Mia blocked this call: the user interrupted the task.", interrupt: true });
    }
    void task.handle?.interrupt().catch((error) => this.deps.log(`interrupt failed: ${String(error)}`));
    return { ok: true, result: { execution_epoch: epoch } };
  }

  diagnosticSnapshot(ctx: CommandContext, payload: { conversation_id: string | null; diagnostics: ClientDiagnostics }): CommandResult {
    const conversationId = payload.conversation_id && this.conversation?.id === payload.conversation_id ? payload.conversation_id : null;
    try {
      this.tx(() => {
        const ev = conversationId ? this.record("client_diagnostics", { client_id: ctx.clientId, captured_at: payload.diagnostics.captured_at, connection_state: payload.diagnostics.connection_state }, { taskId: this.task?.id ?? null }) : null;
        this.deps.writer.recordDiagnostics({ conversationId, clientId: ctx.clientId, clientConnectionId: ctx.connectionId, taskId: this.task?.id ?? null, eventId: ev?.id ?? null, capturedAt: payload.diagnostics.captured_at, state: payload.diagnostics });
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, code: "record_failure", message: String(error) };
    }
  }

  heartbeat(ctx: CommandContext, payload: { conversation_id: string | null; captured_at: string; connection_state: string }): CommandResult {
    try {
      this.deps.writer.touchConnection(ctx.connectionId);
      const conversationId = payload.conversation_id && this.conversation?.id === payload.conversation_id ? payload.conversation_id : null;
      this.deps.writer.recordDiagnostics({ conversationId, clientId: ctx.clientId, clientConnectionId: ctx.connectionId, eventId: null, capturedAt: payload.captured_at, state: { heartbeat: true, connection_state: payload.connection_state } });
      return { ok: true };
    } catch (error) {
      return { ok: false, code: "record_failure", message: String(error) };
    }
  }

  /** Disconnection is not consent: pending approvals stay pending; the connection simply stops being active. */
  onDisconnect(connectionId: string): void {
    if (this.activeConnectionId !== connectionId) return;
    if (this.conversation) {
      try {
        this.tx(() => this.record("client_disconnected", { connection_id: connectionId, pending_approvals: [...(this.task?.pendingApprovals.keys() ?? [])] }, { taskId: this.task?.id ?? null }));
      } catch (error) {
        this.deps.log(`could not record disconnect: ${String(error)}`);
      }
    }
    this.activeConnectionId = null;
  }

  /** A reconnecting client (same client id) may resume ownership when no other connection is active. */
  adoptConnection(connectionId: string, clientId: string): boolean {
    if (this.activeConnectionId === null && (this.activeClientId === null || this.activeClientId === clientId)) {
      this.activeConnectionId = connectionId;
      this.activeClientId = clientId;
      return true;
    }
    return false;
  }

  private guard(ctx: CommandContext, conversationId: string): CommandResult | null {
    if (!this.conversation) return { ok: false, code: "invalid_state", message: "no conversation; send start_conversation first" };
    if (this.conversation.id !== conversationId) return { ok: false, code: "not_found", message: `conversation ${conversationId} is not active` };
    if (this.activeConnectionId && this.activeConnectionId !== ctx.connectionId) return { ok: false, code: "busy", message: "another client owns the active conversation" };
    if (!this.activeConnectionId && !this.adoptConnection(ctx.connectionId, ctx.clientId)) return { ok: false, code: "busy", message: "the conversation belongs to another client" };
    return null;
  }

  private settle(call: ToolCallState, decision: PermissionDecision): void {
    const resolve = call.resolve;
    call.resolve = null;
    resolve?.(decision);
  }

  // ---------------------------------------------------------------- runtime events

  private onAdapterEvent(task: TaskState, event: AdapterEvent): void {
    const conversation = this.conversation;
    if (!conversation) return;
    const opts = { taskId: task.id, executionId: task.executionId };
    try {
      this.tx(() => {
        switch (event.type) {
          case "runtime_started":
            this.record("runtime_started", { pid: event.pid, launch: event.launch }, opts);
            return;
          case "runtime_init":
            task.reportedModel = event.init.model;
            this.record("runtime_init", event.init, opts);
            this.deps.writer.updateExecution(task.executionId, { reportedModel: event.init.model });
            return;
          case "text_delta":
            this.emit("text_delta", { conversation_id: conversation.id, task_id: task.id, execution_id: task.executionId, text: event.text }, opts);
            return;
          case "tool_proposed": {
            if (!event.complete) {
              this.record("tool_proposal_started", { runtime_call_id: event.runtime_call_id, tool_identity: event.tool_identity }, opts);
              return;
            }
            const digest = canonicalDigest(event.arguments);
            const proposal = this.record("tool_proposed", { runtime_call_id: event.runtime_call_id, tool_identity: event.tool_identity, redacted_arguments: redactValue(event.arguments), argument_digest: digest }, opts);
            const last = task.calls.get(event.runtime_call_id)?.at(-1);
            if (last && last.digest === digest) {
              this.deps.writer.updateToolCall(last.id, { proposalEventId: proposal.id });
              return;
            }
            if (last) this.supersede(task, last);
            const policy = this.deps.profile.runtime.toolPolicy[event.tool_identity] ?? "unlisted";
            const state = this.newCallState(task, event.runtime_call_id, event.tool_identity, digest, event.arguments, policy, proposal.id);
            this.afterCommit.push(() => this.notifyToolCall(task, state));
            return;
          }
          case "assistant_message":
            this.record("assistant_message", event.message, opts);
            return;
          case "tool_result": {
            const result = this.record("tool_result", { runtime_call_id: event.runtime_call_id, is_error: event.is_error, content: event.content, raw: event.raw }, opts);
            const call = task.calls.get(event.runtime_call_id)?.at(-1);
            if (!call) {
              this.record("tool_result_unmatched", { runtime_call_id: event.runtime_call_id }, opts);
              return;
            }
            if (!TERMINAL.has(call.status)) call.status = event.is_error ? "failed" : "completed";
            this.deps.writer.updateToolCall(call.id, { status: call.status, resultEventId: result.id });
            if (call.status === "completed") this.collectArtifacts(task, call, event.content, result.id);
            this.afterCommit.push(() => this.notifyToolCall(task, call));
            return;
          }
          case "turn_result":
            this.record("runtime_result", event.result, opts);
            this.deps.writer.updateExecution(task.executionId, { usage: { usage: event.result.usage, total_cost_usd: event.result.total_cost_usd, duration_ms: event.result.duration_ms, duration_api_ms: event.result.duration_api_ms, num_turns: event.result.num_turns } });
            return;
          case "runtime_stderr":
            this.record("runtime_stderr", { text: event.text }, opts);
            return;
          case "malformed_event":
            this.emit("error", { code: "runtime_failure", message: `malformed runtime event: ${event.error}`, conversation_id: conversation.id, task_id: task.id }, opts);
            return;
          case "runtime_exit":
            this.record("runtime_exit", { code: event.code, signal: event.signal }, opts);
            return;
        }
      });
    } catch (error) {
      this.deps.log(`failed to record ${event.type}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private newCallState(task: TaskState, runtimeCallId: string, toolIdentity: string, digest: string, args: unknown, policy: string, proposalEventId: string | null): ToolCallState {
    const revisions = task.calls.get(runtimeCallId) ?? [];
    const revision = (revisions.at(-1)?.revision ?? 0) + 1;
    const redactedArguments = redactValue(args);
    const id = this.deps.writer.createToolCall({ conversationId: this.conversation!.id, taskId: task.id, executionId: task.executionId, runtimeCallId, bindingRevision: revision, toolIdentity, argumentDigest: digest, redactedArguments, policy, status: "proposed", proposalEventId });
    const state: ToolCallState = { id, runtimeCallId, revision, toolIdentity, digest, redactedArguments, policy, status: "proposed", approvalId: null, resolve: null };
    revisions.push(state);
    task.calls.set(runtimeCallId, revisions);
    return state;
  }

  /** Changed arguments under the same runtime call id: the old binding (and any pending approval) can never release anything. */
  private supersede(task: TaskState, last: ToolCallState): void {
    if (last.status !== "awaiting_approval" && last.status !== "proposed") return;
    const conversation = this.conversation!;
    const opts = { taskId: task.id, executionId: task.executionId };
    if (last.approvalId) {
      this.deps.writer.updateApproval(last.approvalId, { status: "invalidated", reason: "arguments changed" });
      task.pendingApprovals.delete(last.approvalId);
      this.emit("approval_resolved", { conversation_id: conversation.id, task_id: task.id, approval_id: last.approvalId, tool_call_id: last.id, status: "invalidated", reason: "arguments changed" }, opts);
    }
    this.deps.writer.updateToolCall(last.id, { status: "invalidated", detail: "superseded by a new binding revision" });
    last.status = "invalidated";
    this.afterCommit.push(() => this.settle(last, { behavior: "deny", message: "Mia invalidated the earlier approval: the arguments changed." }));
  }

  // ---------------------------------------------------------------- approval controller

  private async handlePermission(task: TaskState, req: PermissionRequest): Promise<PermissionDecision> {
    const conversation = this.conversation;
    if (!conversation || this.task !== task) return { behavior: "deny", message: "Mia has no active task for this call." };
    const opts = { taskId: task.id, executionId: task.executionId };
    const runtimeCallId = req.tool_use_id;
    if (!runtimeCallId) {
      this.tx(() => this.emit("error", { code: "runtime_failure", message: `permission request for ${req.tool_name} carried no runtime call id; rejected`, conversation_id: conversation.id, task_id: task.id }, opts));
      return { behavior: "deny", message: "Mia cannot bind this call to a runtime call id; rejected." };
    }
    const digest = canonicalDigest(req.input);
    // Policy is exactly what the profile says. After an interruption the next turn's Mia note tells the model which
    // effects are unknown; deciding whether a repeat is safe is the model's job, not a reason to re-prompt an allowed tool.
    const policy = this.deps.profile.runtime.toolPolicy[req.tool_name] ?? "unlisted";
    let call: ToolCallState;
    let decision: PermissionDecision | null;
    try {
      ({ call, decision } = this.tx(() => {
        const last = task.calls.get(runtimeCallId)?.at(-1);
        let c: ToolCallState;
        if (last && last.digest === digest && last.toolIdentity === req.tool_name && (last.status === "proposed" || last.status === "awaiting_approval")) {
          c = last;
        } else {
          if (last) this.supersede(task, last);
          const proposal = this.record("tool_proposed", { runtime_call_id: runtimeCallId, tool_identity: req.tool_name, redacted_arguments: redactValue(req.input), argument_digest: digest, source: "permission_request" }, opts);
          c = this.newCallState(task, runtimeCallId, req.tool_name, digest, req.input, policy, proposal.id);
        }
        const evaluation = this.record("policy_evaluated", { tool_call_id: c.id, tool_identity: c.toolIdentity, policy, gate_open: task.gateOpen, execution_epoch: task.epoch, binding_revision: c.revision }, opts);
        const deny = (status: ToolCallStatus, detail: string, message: string, interrupt = false): PermissionDecision => {
          this.deps.writer.updateToolCall(c.id, { status, detail });
          c.status = status;
          return interrupt ? { behavior: "deny", message, interrupt } : { behavior: "deny", message };
        };
        if (policy === "unlisted") {
          this.emit("error", { code: "configuration_error", message: `tool ${c.toolIdentity} is not listed in toolPolicy; call denied`, conversation_id: conversation.id, task_id: task.id }, opts);
          return { call: c, decision: deny("denied", "tool not listed in toolPolicy", `Mia denied ${c.toolIdentity}: it is not part of the configured policy.`) };
        }
        if (policy === "deny") return { call: c, decision: deny("denied", "denied by policy", `Mia denied ${c.toolIdentity}: policy forbids it.`) };
        if (!task.gateOpen) return { call: c, decision: deny("blocked_gate", "action gate closed by interruption", "Mia blocked this call: the task is being interrupted.", true) };
        if (policy === "allow") {
          const dispatched = this.record("tool_dispatched", { tool_call_id: c.id, runtime_call_id: c.runtimeCallId, tool_identity: c.toolIdentity, policy, via: "policy" }, { ...opts, causedBy: evaluation.id });
          this.deps.writer.updateToolCall(c.id, { status: "dispatched", dispatchEventId: dispatched.id });
          c.status = "dispatched";
          return { call: c, decision: { behavior: "allow" } as PermissionDecision };
        }
        // ask: durable pending approval bound to (conversation, task, runtime call, revision, tool, digest, epoch).
        const approvalId = this.deps.writer.createApproval({ toolCallId: c.id, executionEpoch: task.epoch, requestingEventId: null });
        const requested = this.emit("approval_requested", {
          conversation_id: conversation.id,
          task_id: task.id,
          approval_id: approvalId,
          tool_call_id: c.id,
          runtime_call_id: c.runtimeCallId,
          binding_revision: c.revision,
          execution_epoch: task.epoch,
          tool_identity: c.toolIdentity,
          intended_action: describeAction(c.toolIdentity, c.redactedArguments),
          redacted_arguments: c.redactedArguments,
          argument_digest: c.digest,
          explainable: true,
        }, opts);
        this.deps.catalog.update("approvals", approvalId, { requesting_event_id: requested.id });
        this.deps.writer.updateToolCall(c.id, { status: "awaiting_approval" });
        this.deps.writer.updateTask(task.id, { status: "awaiting_approval" });
        c.status = "awaiting_approval";
        c.approvalId = approvalId;
        task.pendingApprovals.set(approvalId, c);
        task.status = "awaiting_approval";
        return { call: c, decision: null };
      }));
    } catch (error) {
      this.deps.log(`permission handling failed: ${error instanceof Error ? error.message : String(error)}`);
      return { behavior: "deny", message: "Mia could not record this call; it was not released." };
    }
    this.notifyToolCall(task, call);
    if (decision) return decision;
    return new Promise<PermissionDecision>((resolve) => {
      call.resolve = resolve;
      req.abandoned.addEventListener("abort", () => this.abandon(task, call, resolve), { once: true });
    });
  }

  /** The runtime dropped the held prompt (process gone or turn aborted): the pending approval can never release anything. */
  private abandon(task: TaskState, call: ToolCallState, resolve: (d: PermissionDecision) => void): void {
    if (call.resolve !== resolve) return;
    call.resolve = null;
    const approvalId = call.approvalId;
    if (approvalId && task.pendingApprovals.has(approvalId)) {
      try {
        this.tx(() => {
          this.deps.writer.updateApproval(approvalId, { status: "expired", reason: "runtime abandoned the prompt" });
          this.deps.writer.updateToolCall(call.id, { status: "invalidated", detail: "runtime abandoned the held call" });
          this.emit("approval_resolved", { conversation_id: this.conversation!.id, task_id: task.id, approval_id: approvalId, tool_call_id: call.id, status: "expired", reason: "runtime abandoned the prompt" }, { taskId: task.id, executionId: task.executionId });
        });
        call.status = "invalidated";
        task.pendingApprovals.delete(approvalId);
        task.abandoned.push(call);
      } catch (error) {
        this.deps.log(`could not record abandoned approval: ${String(error)}`);
      }
    }
    resolve({ behavior: "deny", message: `Mia: the approval prompt for ${call.toolIdentity} was abandoned before the user decided. This call was never released and did not run; its outcome is known, not unknown. Do not retry it.` });
  }

  // ---------------------------------------------------------------- turn completion

  private async finishTurn(task: TaskState, result: TurnResult): Promise<void> {
    const conversation = this.conversation;
    if (!conversation) return;
    const opts = { taskId: task.id, executionId: task.executionId };
    const actions = classifyActions(task);
    const unknown = actions.some((a) => a.status === "unknown");
    const { status, error } = classifyTask(task, result, unknown);
    const hooks = readHookEvidence(result.hookEvidencePath);
    const efforts = effortLevels(hooks);
    try {
      this.tx(() => {
        const { writer } = this.deps;
        for (const revisions of task.calls.values()) for (const call of revisions) writer.updateToolCall(call.id, { status: call.status, detail: detailFor(call.status) });
        for (const call of task.pendingApprovals.values()) if (call.approvalId) writer.updateApproval(call.approvalId, { status: "expired", reason: "task ended" });
        const retain = (kind: string, name: string, bytes: Buffer, relation: "runtime_transcript" | "task_output", originalPath?: string) => {
          const art = writer.registerArtifact({ kind, logicalName: name, mimeType: "application/x-ndjson", bytes, producerExecutionId: task.executionId, originalPath: originalPath ?? null });
          writer.linkArtifact({ conversationId: conversation.id, artifactId: art.artifactId, relation, taskId: task.id });
        };
        if (existsSync(result.streamLogPath)) retain("runtime_transcript", `turn-${conversation.turnCount}.stream.jsonl`, readFileSync(result.streamLogPath), "runtime_transcript", result.streamLogPath);
        if (hooks.length > 0) retain("effort_evidence", `turn-${conversation.turnCount}.hooks.jsonl`, Buffer.from(hooks.map((h) => JSON.stringify(h)).join("\n") + "\n"), "task_output");
        writer.updateExecution(task.executionId, {
          status: result.status === "completed" ? "completed" : task.interrupted ? "killed" : "failed",
          endedAt: nowIso(),
          reportedModel: task.reportedModel,
          reportedEffort: efforts.length === 1 ? (efforts[0] as string) : null,
          effortEvidence: { source: "PreToolUse hook", values: efforts, samples: hooks.length, note: hooks.length === 0 ? "no tool use in this turn; effective effort unreported" : null },
        });
        if (task.interrupted) this.emit("interruption_outcome", { conversation_id: conversation.id, task_id: task.id, task_status: status, actions, runtime_cancellation: result.runtimeCancellation }, opts);
        writer.updateTask(task.id, { status, finishedAt: nowIso() });
        this.emit("task_finished", { conversation_id: conversation.id, task_id: task.id, status, ...(error ? { error } : {}), usage: result.result?.usage ?? undefined }, opts);
        if (error) this.emit("error", { code: "runtime_failure", message: error, conversation_id: conversation.id, task_id: task.id }, opts);
      });
    } catch (recordError) {
      this.deps.log(`finishTurn record failure: ${String(recordError)}`);
    }
    task.pendingApprovals.clear();
    task.status = status;
    if (task.interrupted || unknown) {
      // The runtime's own memory of a killed turn is incomplete (capability record L1); Mia's records are authoritative.
      const lines = actions.filter((a) => a.status !== "denied").map((a) => `- ${a.tool_identity}: ${a.status}${a.detail ? ` (${a.detail})` : ""}`);
      conversation.pendingNote = `[Mia note, not from the user] Your previous turn was ${task.interrupted ? "interrupted by the user" : "ended by a runtime failure"}. Mia's records of tool calls in that turn:\n${lines.join("\n") || "- no tool calls"}\nAn "unknown" action may or may not have taken effect; do not repeat any of those actions unless the user asks again, and if they do, weigh whether a repeat could double an effect before calling.`;
    } else if (task.abandoned.length > 0) {
      const lines = task.abandoned.map((c) => `- ${c.toolIdentity} ${JSON.stringify(c.redactedArguments)}`);
      conversation.pendingNote = `[Mia note, not from the user] In your previous turn the runtime abandoned the approval prompt for these calls before the user decided:\n${lines.join("\n")}\nMia never released them: they did not run and their outcome is known (nothing happened), not unknown. If you reported otherwise, correct it. Do not retry them unless the user asks again.`;
    }
  }

  /** A tool result may declare a generated file as {"artifact": {...}}; only files inside the configured output directories are retained. */
  private collectArtifacts(task: TaskState, call: ToolCallState, content: unknown, resultEventId: string): void {
    const declared = extractDeclaredArtifact(content);
    if (!declared) return;
    const { writer } = this.deps;
    let capture: { status: "retained"; bytes: Buffer } | { status: "external_only" | "missing" | "failed"; reason: string };
    if (!existsSync(declared.path)) capture = { status: "missing", reason: "declared file not found at collection time" };
    else {
      const real = realpathSync(declared.path);
      if (!this.deps.profile.runtime.outputDirectories.some((dir) => real.startsWith(realpathSync(dir) + sep))) capture = { status: "external_only", reason: "declared path resolves outside the configured output directories" };
      else {
        const bytes = readFileSync(real);
        const digest = sha256Hex(bytes);
        capture = declared.sha256 && declared.sha256 !== digest ? { status: "failed", reason: `declared sha256 ${declared.sha256} does not match file ${digest}` } : { status: "retained", bytes };
      }
    }
    const art = writer.registerArtifact({
      kind: "tool_output",
      logicalName: declared.name ?? declared.path,
      mimeType: declared.mime_type ?? "application/octet-stream",
      producerExecutionId: task.executionId,
      producerEventId: resultEventId,
      originalPath: declared.path,
      ...(capture.status === "retained" ? { bytes: capture.bytes } : { captureStatus: capture.status, externalLocator: declared.path, captureReason: capture.reason }),
    });
    writer.linkArtifact({ conversationId: this.conversation!.id, artifactId: art.artifactId, relation: "tool_result", toolCallId: call.id, taskId: task.id });
    if (capture.status === "retained") {
      writer.linkArtifact({ conversationId: this.conversation!.id, artifactId: art.artifactId, relation: "task_output", taskId: task.id });
      this.record("artifact_registered", { artifact_id: art.artifactId, tool_call_id: call.id, digest: art.digest, size: art.byteSize, original_path: declared.path }, { taskId: task.id, executionId: task.executionId, causedBy: resultEventId });
    }
  }

  async waitForIdle(): Promise<void> {
    await this.task?.finished;
  }
}

/** Final status of every call in the task: released-without-result is unknown; anything still held can never run. */
function classifyActions(task: TaskState): EventPayload<"interruption_outcome">["actions"] {
  const actions: EventPayload<"interruption_outcome">["actions"] = [];
  for (const revisions of task.calls.values()) {
    for (const call of revisions) {
      if (call.status === "dispatched") call.status = "unknown";
      if (call.status === "awaiting_approval" || call.status === "proposed") call.status = task.interrupted ? "blocked_gate" : "invalidated";
      actions.push({ tool_call_id: call.id, tool_identity: call.toolIdentity, status: call.status, detail: detailFor(call.status) });
    }
  }
  return actions;
}

/** Task status is separate from action outcomes: an interrupted or completed task with an unknown action is outcome_unknown. */
function classifyTask(task: TaskState, result: TurnResult, unknown: boolean): { status: TaskStatus; error?: string } {
  if (task.interrupted) return { status: unknown ? "outcome_unknown" : "interrupted" };
  if (result.status === "completed") return { status: unknown ? "outcome_unknown" : "completed" };
  return { status: unknown ? "outcome_unknown" : "failed", error: result.error ?? "runtime failed" };
}

/** Distinct effective-effort values reported by the PreToolUse hook (`effort.level`, else CLAUDE_EFFORT). */
function effortLevels(hooks: Array<Record<string, unknown>>): string[] {
  const levels = hooks.map((h) => {
    const effort = h.effort as { level?: string } | string | undefined;
    return (typeof effort === "object" && effort ? effort.level : effort) ?? (h.env_claude_effort as string | undefined);
  });
  return [...new Set(levels.filter((l): l is string => typeof l === "string"))];
}

function detailFor(status: ToolCallStatus): string | undefined {
  switch (status) {
    case "unknown":
      return "released; no result observed; effect unknown";
    case "blocked_gate":
      return "not released: action gate closed";
    case "invalidated":
      return "never released: proposal or pending approval invalidated";
    default:
      return undefined;
  }
}

function describeAction(toolIdentity: string, args: unknown): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(toolIdentity);
  const argText = JSON.stringify(args ?? {});
  return m ? `Call tool "${m[2]}" on MCP server "${m[1]}" with arguments ${argText}` : `Call ${toolIdentity} with arguments ${argText}`;
}

interface DeclaredArtifact {
  path: string;
  sha256?: string;
  name?: string;
  mime_type?: string;
}

export function extractDeclaredArtifact(content: unknown): DeclaredArtifact | null {
  const texts: string[] = typeof content === "string" ? [content] : Array.isArray(content) ? content.map((b) => (b as { text?: unknown })?.text).filter((t): t is string => typeof t === "string") : [];
  for (const text of texts) {
    try {
      const parsed = JSON.parse(text) as { artifact?: DeclaredArtifact };
      if (parsed?.artifact && typeof parsed.artifact.path === "string") return parsed.artifact;
    } catch {
      /* not JSON */
    }
  }
  return null;
}
