import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { match } from "ts-pattern";
import { z } from "zod";
import {
  readHookEvidence,
  type AdapterEvent,
  type PermissionDecision,
  type PermissionRequest,
  type TurnHandle,
  type TurnOptions,
  type TurnResult,
} from "@mia/agent-adapter";
import {
  PROTOCOL_VERSION,
  canonicalDigest,
  errorMessage,
  redactValue,
  sha256Hex,
  type ClientDiagnostics,
  type Decision,
  type ErrorCode,
  type EventPayload,
  type ServerEvent,
  type ServerEventType,
  type TaskStatus,
  type ToolCallStatus,
} from "@mia/protocol";
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

export type CommandResult =
  { ok: true; result?: Record<string, unknown> } | { ok: false; code: ErrorCode; message: string };

const fail = (code: ErrorCode, message: string): CommandResult => ({ ok: false, code, message });

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

/** Linkage recorded with an event: the task and execution it belongs to and the event that caused it. */
interface EventOpts {
  taskId?: string | null;
  executionId?: string | null;
  causedBy?: string | null;
}

interface NewCallInput {
  runtimeCallId: string;
  toolIdentity: string;
  digest: string;
  args: unknown;
  policy: string;
  proposalEventId: string | null;
}

const RUNTIME_IDENTITY = "claude-code";
const TERMINAL: ReadonlySet<ToolCallStatus> = new Set([
  "denied",
  "blocked_gate",
  "invalidated",
  "completed",
  "failed",
  "cancelled",
  "unknown",
]);

const detailFor = (status: ToolCallStatus): string | undefined =>
  match(status)
    .with("unknown", () => "released; no result observed; effect unknown")
    .with("blocked_gate", () => "not released: action gate closed")
    .with("invalidated", () => "never released: proposal or pending approval invalidated")
    .otherwise(() => undefined);

/** Final status of every call in the task: released-without-result is unknown; anything still held can never run. */
const classifyActions = (task: TaskState): EventPayload<"interruption_outcome">["actions"] =>
  task.calls
    .values()
    .flatMap((revisions) => revisions)
    .map((call) => {
      if (call.status === "dispatched") call.status = "unknown";
      if (call.status === "awaiting_approval" || call.status === "proposed")
        call.status = task.interrupted ? "blocked_gate" : "invalidated";
      return {
        tool_call_id: call.id,
        tool_identity: call.toolIdentity,
        status: call.status,
        detail: detailFor(call.status),
      };
    })
    .toArray();

/** Task status is separate from action outcomes: an interrupted or completed task with an unknown action is outcome_unknown. */
const classifyTask = (
  task: TaskState,
  result: TurnResult,
  unknown: boolean,
): { status: TaskStatus; error?: string } => {
  if (task.interrupted) return { status: unknown ? "outcome_unknown" : "interrupted" };
  if (result.status === "completed") return { status: unknown ? "outcome_unknown" : "completed" };
  return {
    status: unknown ? "outcome_unknown" : "failed",
    error: result.error ?? "runtime failed",
  };
};

/** Effective effort reported by one PreToolUse hook record: `effort.level`, a bare `effort`, else CLAUDE_EFFORT. */
const effortLevelOf = (hook: Record<string, unknown>): unknown => {
  const effort = hook.effort;
  if (typeof effort === "object" && effort !== null)
    return ("level" in effort ? effort.level : undefined) ?? hook.env_claude_effort;
  return effort ?? hook.env_claude_effort;
};

/** Distinct effective-effort values reported by the PreToolUse hook. */
const effortLevels = (hooks: Record<string, unknown>[]): string[] => {
  const levels = hooks.map(effortLevelOf);
  return [...new Set(levels.filter((level): level is string => typeof level === "string"))];
};

const executionStatusFor = (task: TaskState, result: TurnResult): string => {
  if (result.status === "completed") return "completed";
  return task.interrupted ? "killed" : "failed";
};

const describeAction = (toolIdentity: string, args: unknown): string => {
  const parsed = /^mcp__(.+?)__(.+)$/.exec(toolIdentity);
  const argText = JSON.stringify(args ?? {});
  const server = parsed?.[1];
  const tool = parsed?.[2];
  if (server !== undefined && tool !== undefined)
    return `Call tool "${tool}" on MCP server "${server}" with arguments ${argText}`;
  return `Call ${toolIdentity} with arguments ${argText}`;
};

const DeclaredArtifactSchema = z.object({
  path: z.string(),
  sha256: z.string().optional(),
  name: z.string().optional(),
  mime_type: z.string().optional(),
});
const ArtifactDeclarationSchema = z.object({ artifact: DeclaredArtifactSchema });
type DeclaredArtifact = z.infer<typeof DeclaredArtifactSchema>;

/** Text blocks of a tool result: a bare string, or the `text` of every block that carries one. */
const resultTexts = (content: unknown): string[] => {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: unknown) => {
    const text = typeof block === "object" && block !== null && "text" in block ? block.text : null;
    return typeof text === "string" ? [text] : [];
  });
};

export const extractDeclaredArtifact = (content: unknown): DeclaredArtifact | null => {
  for (const text of resultTexts(content)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue; // not JSON
    }
    const declaration = ArtifactDeclarationSchema.safeParse(parsed);
    if (declaration.success) return declaration.data.artifact;
  }
  return null;
};

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
  private afterCommit: (() => void)[] = [];

  constructor(private readonly deps: EngineDeps) {}

  /** The conversation every guarded command and runtime callback operates on; callers check for one first. */
  private get activeConversation(): ConversationState {
    if (!this.conversation) throw new Error("engine has no active conversation");
    return this.conversation;
  }

  // ---------------------------------------------------------------- event plumbing

  /** Run fn in one catalog transaction; queued client sends go out after commit and are dropped on failure. */
  private tx<T>(fn: () => T): T {
    try {
      const result = this.deps.catalog.transaction(fn);
      const deferred = this.afterCommit;
      this.afterCommit = [];
      for (const run of deferred) run();
      return result;
    } catch (error) {
      this.afterCommit = [];
      throw error;
    }
  }

  private deliver<T extends ServerEventType>(event: {
    type: T;
    id: string;
    sequence: number | null;
    payload: EventPayload<T>;
  }): void {
    const connectionId = this.activeConnectionId;
    if (!connectionId) return;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- TypeScript cannot correlate the generic `type`/`payload` pair with one member of the ServerEvent union; EventPayload<T> guarantees the pairing.
    const envelope = {
      protocol_version: PROTOCOL_VERSION,
      message_id: event.id,
      type: event.type,
      conversation_id: this.conversation?.id ?? null,
      sequence: event.sequence,
      server_time: nowIso(),
      payload: event.payload,
    } as ServerEvent;
    this.send(connectionId, envelope);
  }

  /** Persist an event (inside tx) and queue its delivery with the persisted id and sequence. */
  private emit<T extends ServerEventType>(
    type: T,
    payload: EventPayload<T>,
    opts: EventOpts = {},
  ): { id: string; sequence: number } {
    const ev = this.record(type, payload, opts);
    this.afterCommit.push(() => this.deliver({ type, id: ev.id, sequence: ev.sequence, payload }));
    return ev;
  }

  /** Persist evidence that has no client-facing schema (inside tx). */
  private record(
    type: string,
    payload: unknown,
    opts: EventOpts = {},
  ): { id: string; sequence: number } {
    const appended = this.deps.writer.appendEvent({
      conversationId: this.activeConversation.id,
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
    this.deliver({
      type: "tool_call",
      id: newId("evt"),
      sequence: null,
      payload: {
        conversation_id: this.activeConversation.id,
        task_id: task.id,
        tool_call_id: call.id,
        runtime_call_id: call.runtimeCallId,
        tool_identity: call.toolIdentity,
        status: call.status,
        ...(detail ? { detail } : {}),
        redacted_arguments: call.redactedArguments,
      },
    });
  }

  // ---------------------------------------------------------------- commands

  startConversation(ctx: CommandContext): CommandResult {
    if (this.task)
      return fail(
        "busy",
        "a task is running; interrupt it or wait before starting a new conversation",
      );
    if (
      this.conversation &&
      this.activeConnectionId &&
      this.activeConnectionId !== ctx.connectionId
    ) {
      return fail("busy", "another client owns the active conversation");
    }
    const { writer, profile } = this.deps;
    const previous = {
      conversation: this.conversation,
      connection: this.activeConnectionId,
      client: this.activeClientId,
    };
    try {
      return this.tx(() => {
        const provenance = createConversationProvenance({
          writer,
          profile,
          clientBuild: ctx.clientBuild,
          sourceRoot: this.deps.sourceRoot,
        });
        const runtimeConversationId = randomUUID();
        const conv = writer.createConversation({
          provenanceSetId: provenance.provenance_set_id,
          runtimeConversationId,
        });
        writer.linkProvenanceSet(conv.id, provenance.provenance_set_id);
        if (previous.conversation)
          writer.updateConversation(previous.conversation.id, { status: "closed" });
        // Every turn of this conversation appends exactly the prompt bytes recorded in provenance.
        const promptFile = join(conv.directory, "agent-prompt.md");
        writeFileSync(
          promptFile,
          existsSync(profile.runtime.agentPromptFile)
            ? readFileSync(profile.runtime.agentPromptFile)
            : "",
          { mode: 0o600 },
        );
        this.conversation = {
          id: conv.id,
          runtimeConversationId,
          provenanceSetId: provenance.provenance_set_id,
          directory: conv.directory,
          promptFile,
          turnCount: 0,
          epoch: 0,
          pendingNote: null,
        };
        this.activeConnectionId = ctx.connectionId;
        this.activeClientId = ctx.clientId;
        this.record("provenance_recorded", provenance);
        this.emit("conversation_started", {
          conversation_id: conv.id,
          started_at: conv.startedAt,
          provenance_set_id: provenance.provenance_set_id,
        });
        return {
          ok: true,
          result: { conversation_id: conv.id, provenance_set_id: provenance.provenance_set_id },
        };
      });
    } catch (error) {
      this.conversation = previous.conversation;
      this.activeConnectionId = previous.connection;
      this.activeClientId = previous.client;
      return fail("record_failure", `could not create conversation: ${errorMessage(error)}`);
    }
  }

  submitText(
    ctx: CommandContext,
    payload: { conversation_id: string; text: string },
  ): CommandResult {
    const guard = this.guard(ctx, payload.conversation_id);
    if (guard) return guard;
    const conversation = this.activeConversation;
    if (this.task) {
      const pending = [...this.task.pendingApprovals.keys()];
      const hint =
        pending.length > 0
          ? `approve or reject ${pending.join(", ")}, or interrupt it`
          : "wait for it to finish or interrupt it";
      return fail("busy", `task ${this.task.id} is ${this.task.status}; ${hint}`);
    }
    const { writer, profile } = this.deps;
    const epoch = conversation.epoch + 1;
    const turnIndex = conversation.turnCount + 1;
    const note = conversation.pendingNote;
    const runtimePrompt = note ? `${note}\n\n${payload.text}` : payload.text;
    let ids: { taskId: string; executionId: string };
    try {
      ids = this.tx(() => {
        const taskId = writer.createTask({
          conversationId: conversation.id,
          text: payload.text,
          clientId: ctx.clientId,
        });
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
        this.record(
          "task_submitted",
          {
            text: payload.text,
            runtime_prompt: runtimePrompt,
            mia_note: note,
            command_id: ctx.commandId,
          },
          opts,
        );
        this.emit(
          "task_started",
          {
            conversation_id: conversation.id,
            task_id: taskId,
            execution_id: executionId,
            execution_epoch: epoch,
            text: payload.text,
          },
          opts,
        );
        return { taskId, executionId };
      });
    } catch (error) {
      return fail("record_failure", `could not record task: ${errorMessage(error)}`);
    }
    conversation.epoch = epoch;
    conversation.turnCount = turnIndex;
    conversation.pendingNote = null;
    const finished: PromiseWithResolvers<void> = Promise.withResolvers();
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
      finished: finished.promise,
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
      .catch((error) =>
        this.deps.log(
          `finishTurn failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        ),
      )
      .finally(() => {
        if (this.task === task) this.task = null;
        finished.resolve();
      });
    return {
      ok: true,
      result: { task_id: task.id, execution_id: task.executionId, execution_epoch: epoch },
    };
  }

  approvalDecision(
    ctx: CommandContext,
    payload: { conversation_id: string; task_id: string; approval_id: string; decision: Decision },
  ): CommandResult {
    const guard = this.guard(ctx, payload.conversation_id);
    if (guard) return guard;
    const task = this.task;
    if (!task || task.id !== payload.task_id) {
      const known = this.deps.catalog.get<{ status: string; task_id: string }>(
        "SELECT a.status, t.task_id FROM approvals a JOIN tool_calls t ON t.id = a.tool_call_id WHERE a.id = ?",
        payload.approval_id,
      );
      if (known && known.task_id === payload.task_id)
        return fail(
          "invalid_state",
          `approval ${payload.approval_id} is ${known.status} and task ${payload.task_id} is no longer active; a decision cannot be reused`,
        );
      return fail("not_found", `task ${payload.task_id} is not the active task`);
    }
    if (ctx.clientId !== task.clientId)
      return fail("unauthenticated", "decision must come from the client that owns the task");
    const call = task.pendingApprovals.get(payload.approval_id);
    if (!call || call.status !== "awaiting_approval" || !call.approvalId) {
      const known = this.deps.catalog.get<{ status: string }>(
        "SELECT status FROM approvals WHERE id = ?",
        payload.approval_id,
      );
      if (known)
        return fail(
          "invalid_state",
          `approval ${payload.approval_id} is ${known.status}, not pending; a decision cannot be reused`,
        );
      return fail("not_found", `approval ${payload.approval_id} does not exist for this task`);
    }
    const approvalId = call.approvalId;
    const approve = payload.decision === "approve";
    const conversation = this.activeConversation;
    const opts = { taskId: task.id, executionId: task.executionId };
    // Release only if the gate is still open in the current epoch; the decision is persisted before any release.
    const release = approve && task.gateOpen && task.epoch === conversation.epoch;
    const outcome = ((): { status: ToolCallStatus; detail: string | undefined } => {
      if (release) return { status: "dispatched", detail: undefined };
      if (approve) return { status: "blocked_gate", detail: "approved after gate closed" };
      return { status: "denied", detail: "rejected" };
    })();
    const nextStatus = outcome.status;
    try {
      this.tx(() => {
        const { writer } = this.deps;
        const decided = this.emit(
          "approval_resolved",
          {
            conversation_id: conversation.id,
            task_id: task.id,
            approval_id: approvalId,
            tool_call_id: call.id,
            status: approve ? "approved" : "rejected",
          },
          opts,
        );
        writer.updateApproval(approvalId, {
          status: approve ? "approved" : "rejected",
          decisionEventId: decided.id,
          decisionClientId: ctx.clientId,
        });
        if (release) {
          const dispatched = this.record(
            "tool_dispatched",
            {
              tool_call_id: call.id,
              runtime_call_id: call.runtimeCallId,
              tool_identity: call.toolIdentity,
              policy: call.policy,
              via: "approval",
            },
            { ...opts, causedBy: decided.id },
          );
          writer.updateToolCall(call.id, { status: "dispatched", dispatchEventId: dispatched.id });
        } else {
          writer.updateToolCall(call.id, {
            status: nextStatus,
            detail: approve
              ? "approved after the action gate closed; not released"
              : "rejected by user",
          });
        }
      });
    } catch (error) {
      // Record failure: the call stays held and pending; nothing is released.
      return fail(
        "record_failure",
        `decision not recorded; call remains held: ${errorMessage(error)}`,
      );
    }
    call.status = nextStatus;
    task.pendingApprovals.delete(approvalId);
    if (task.pendingApprovals.size === 0 && task.status === "awaiting_approval")
      task.status = "running";
    this.notifyToolCall(task, call, outcome.detail);
    if (release) this.settle(call, { behavior: "allow" });
    else
      this.settle(call, {
        behavior: "deny",
        message: approve
          ? "Mia blocked this call: the task was interrupted before it could be released."
          : "The user rejected this call. Do not retry it.",
      });
    return {
      ok: true,
      result: { approval_id: approvalId, released: release, decision: payload.decision },
    };
  }

  interruptTask(
    ctx: CommandContext,
    payload: { conversation_id: string; task_id: string },
  ): CommandResult {
    const guard = this.guard(ctx, payload.conversation_id);
    if (guard) return guard;
    const task = this.task;
    if (!task || task.id !== payload.task_id)
      return fail("not_found", `task ${payload.task_id} is not the active task`);
    if (task.status === "interrupting") return { ok: true, result: { already_interrupting: true } };
    if (task.status !== "running" && task.status !== "awaiting_approval")
      return fail("invalid_state", `task is ${task.status}`);
    const conversation = this.activeConversation;
    const epoch = conversation.epoch + 1;
    // Pending approvals are keyed by their approval id.
    const pending = [...task.pendingApprovals.entries()];
    const opts = { taskId: task.id, executionId: task.executionId };
    try {
      // Atomically: close the gate, advance the epoch, invalidate pending approvals, record the order. Memory changes after commit.
      this.tx(() => {
        const requested = this.emit(
          "interruption_requested",
          { conversation_id: conversation.id, task_id: task.id, execution_epoch: epoch },
          opts,
        );
        for (const [approvalId, call] of pending) {
          this.deps.writer.updateApproval(approvalId, {
            status: "invalidated",
            reason: "interrupted",
            decisionEventId: requested.id,
          });
          this.deps.writer.updateToolCall(call.id, {
            status: "invalidated",
            detail: "pending approval invalidated by interruption",
          });
          this.emit(
            "approval_resolved",
            {
              conversation_id: conversation.id,
              task_id: task.id,
              approval_id: approvalId,
              tool_call_id: call.id,
              status: "invalidated",
              reason: "interrupted",
            },
            { ...opts, causedBy: requested.id },
          );
        }
        this.deps.writer.updateTask(task.id, { status: "interrupting" });
      });
    } catch (error) {
      return fail("record_failure", `interruption not recorded: ${errorMessage(error)}`);
    }
    task.gateOpen = false;
    task.interrupted = true;
    task.status = "interrupting";
    conversation.epoch = epoch;
    task.pendingApprovals.clear();
    for (const [, call] of pending) {
      call.status = "invalidated";
      this.notifyToolCall(task, call, "interrupted");
      this.settle(call, {
        behavior: "deny",
        message: "Mia blocked this call: the user interrupted the task.",
        interrupt: true,
      });
    }
    void task.handle
      ?.interrupt()
      .catch((error) => this.deps.log(`interrupt failed: ${String(error)}`));
    return { ok: true, result: { execution_epoch: epoch } };
  }

  diagnosticSnapshot(
    ctx: CommandContext,
    payload: { conversation_id: string | null; diagnostics: ClientDiagnostics },
  ): CommandResult {
    const conversationId =
      payload.conversation_id && this.conversation?.id === payload.conversation_id
        ? payload.conversation_id
        : null;
    try {
      this.tx(() => {
        const ev = conversationId
          ? this.record(
              "client_diagnostics",
              {
                client_id: ctx.clientId,
                captured_at: payload.diagnostics.captured_at,
                connection_state: payload.diagnostics.connection_state,
              },
              { taskId: this.task?.id ?? null },
            )
          : null;
        this.deps.writer.recordDiagnostics({
          conversationId,
          clientId: ctx.clientId,
          clientConnectionId: ctx.connectionId,
          taskId: this.task?.id ?? null,
          eventId: ev?.id ?? null,
          capturedAt: payload.diagnostics.captured_at,
          state: payload.diagnostics,
        });
      });
      return { ok: true };
    } catch (error) {
      return fail("record_failure", String(error));
    }
  }

  heartbeat(
    ctx: CommandContext,
    payload: { conversation_id: string | null; captured_at: string; connection_state: string },
  ): CommandResult {
    try {
      this.deps.writer.touchConnection(ctx.connectionId);
      const conversationId =
        payload.conversation_id && this.conversation?.id === payload.conversation_id
          ? payload.conversation_id
          : null;
      this.deps.writer.recordDiagnostics({
        conversationId,
        clientId: ctx.clientId,
        clientConnectionId: ctx.connectionId,
        eventId: null,
        capturedAt: payload.captured_at,
        state: { heartbeat: true, connection_state: payload.connection_state },
      });
      return { ok: true };
    } catch (error) {
      return fail("record_failure", String(error));
    }
  }

  /** Disconnection is not consent: pending approvals stay pending; the connection simply stops being active. */
  onDisconnect(connectionId: string): void {
    if (this.activeConnectionId !== connectionId) return;
    if (this.conversation) {
      try {
        this.tx(() =>
          this.record(
            "client_disconnected",
            {
              connection_id: connectionId,
              pending_approvals: [...(this.task?.pendingApprovals.keys() ?? [])],
            },
            { taskId: this.task?.id ?? null },
          ),
        );
      } catch (error) {
        this.deps.log(`could not record disconnect: ${String(error)}`);
      }
    }
    this.activeConnectionId = null;
  }

  /** A reconnecting client (same client id) may resume ownership when no other connection is active. */
  adoptConnection(connectionId: string, clientId: string): boolean {
    if (
      this.activeConnectionId === null &&
      (this.activeClientId === null || this.activeClientId === clientId)
    ) {
      this.activeConnectionId = connectionId;
      this.activeClientId = clientId;
      return true;
    }
    return false;
  }

  private guard(ctx: CommandContext, conversationId: string): CommandResult | null {
    if (!this.conversation)
      return fail("invalid_state", "no conversation; send start_conversation first");
    if (this.conversation.id !== conversationId)
      return fail("not_found", `conversation ${conversationId} is not active`);
    if (this.activeConnectionId && this.activeConnectionId !== ctx.connectionId)
      return fail("busy", "another client owns the active conversation");
    if (!this.activeConnectionId && !this.adoptConnection(ctx.connectionId, ctx.clientId))
      return fail("busy", "the conversation belongs to another client");
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
      this.tx(() =>
        match(event)
          .with({ type: "runtime_started" }, (started) => {
            this.record("runtime_started", { pid: started.pid, launch: started.launch }, opts);
          })
          .with({ type: "runtime_init" }, (init) => {
            task.reportedModel = init.init.model;
            this.record("runtime_init", init.init, opts);
            this.deps.writer.updateExecution(task.executionId, { reportedModel: init.init.model });
          })
          .with({ type: "text_delta" }, (delta) => {
            this.emit(
              "text_delta",
              {
                conversation_id: conversation.id,
                task_id: task.id,
                execution_id: task.executionId,
                text: delta.text,
              },
              opts,
            );
          })
          .with({ type: "tool_proposed" }, (proposed) => {
            if (!proposed.complete) {
              this.record(
                "tool_proposal_started",
                { runtime_call_id: proposed.runtimeCallId, tool_identity: proposed.toolIdentity },
                opts,
              );
              return;
            }
            const digest = canonicalDigest(proposed.arguments);
            const proposal = this.record(
              "tool_proposed",
              {
                runtime_call_id: proposed.runtimeCallId,
                tool_identity: proposed.toolIdentity,
                redacted_arguments: redactValue(proposed.arguments),
                argument_digest: digest,
              },
              opts,
            );
            const last = task.calls.get(proposed.runtimeCallId)?.at(-1);
            if (last && last.digest === digest) {
              this.deps.writer.updateToolCall(last.id, { proposalEventId: proposal.id });
              return;
            }
            if (last) this.supersede(task, last);
            const policy =
              this.deps.profile.runtime.toolPolicy[proposed.toolIdentity] ?? "unlisted";
            const state = this.newCallState(task, {
              runtimeCallId: proposed.runtimeCallId,
              toolIdentity: proposed.toolIdentity,
              digest,
              args: proposed.arguments,
              policy,
              proposalEventId: proposal.id,
            });
            this.afterCommit.push(() => this.notifyToolCall(task, state));
          })
          .with({ type: "assistant_message" }, (message) => {
            this.record("assistant_message", message.message, opts);
          })
          .with({ type: "tool_result" }, (toolResult) => {
            const result = this.record(
              "tool_result",
              {
                runtime_call_id: toolResult.runtimeCallId,
                is_error: toolResult.isError,
                content: toolResult.content,
                raw: toolResult.raw,
              },
              opts,
            );
            const call = task.calls.get(toolResult.runtimeCallId)?.at(-1);
            if (!call) {
              this.record(
                "tool_result_unmatched",
                { runtime_call_id: toolResult.runtimeCallId },
                opts,
              );
              return;
            }
            if (!TERMINAL.has(call.status))
              call.status = toolResult.isError ? "failed" : "completed";
            this.deps.writer.updateToolCall(call.id, {
              status: call.status,
              resultEventId: result.id,
            });
            if (call.status === "completed")
              this.collectArtifacts(task, call, {
                content: toolResult.content,
                eventId: result.id,
              });
            this.afterCommit.push(() => this.notifyToolCall(task, call));
          })
          .with({ type: "turn_result" }, (turn) => {
            this.record("runtime_result", turn.result, opts);
            this.deps.writer.updateExecution(task.executionId, {
              usage: {
                usage: turn.result.usage,
                total_cost_usd: turn.result.total_cost_usd,
                duration_ms: turn.result.duration_ms,
                duration_api_ms: turn.result.duration_api_ms,
                num_turns: turn.result.num_turns,
              },
            });
          })
          .with({ type: "runtime_stderr" }, (stderr) => {
            this.record("runtime_stderr", { text: stderr.text }, opts);
          })
          .with({ type: "malformed_event" }, (malformed) => {
            this.emit(
              "error",
              {
                code: "runtime_failure",
                message: `malformed runtime event: ${malformed.error}`,
                conversation_id: conversation.id,
                task_id: task.id,
              },
              opts,
            );
          })
          .with({ type: "runtime_exit" }, (exit) => {
            this.record("runtime_exit", { code: exit.code, signal: exit.signal }, opts);
          })
          .exhaustive(),
      );
    } catch (error) {
      this.deps.log(`failed to record ${event.type}: ${errorMessage(error)}`);
    }
  }

  private newCallState(task: TaskState, input: NewCallInput): ToolCallState {
    const { runtimeCallId, toolIdentity, digest, policy, proposalEventId } = input;
    const revisions = task.calls.get(runtimeCallId) ?? [];
    const revision = (revisions.at(-1)?.revision ?? 0) + 1;
    const redactedArguments = redactValue(input.args);
    const id = this.deps.writer.createToolCall({
      conversationId: this.activeConversation.id,
      taskId: task.id,
      executionId: task.executionId,
      runtimeCallId,
      bindingRevision: revision,
      toolIdentity,
      argumentDigest: digest,
      redactedArguments,
      policy,
      status: "proposed",
      proposalEventId,
    });
    const state: ToolCallState = {
      id,
      runtimeCallId,
      revision,
      toolIdentity,
      digest,
      redactedArguments,
      policy,
      status: "proposed",
      approvalId: null,
      resolve: null,
    };
    revisions.push(state);
    task.calls.set(runtimeCallId, revisions);
    return state;
  }

  /** Changed arguments under the same runtime call id: the old binding (and any pending approval) can never release anything. */
  private supersede(task: TaskState, last: ToolCallState): void {
    if (last.status !== "awaiting_approval" && last.status !== "proposed") return;
    const conversation = this.activeConversation;
    const opts = { taskId: task.id, executionId: task.executionId };
    if (last.approvalId) {
      this.deps.writer.updateApproval(last.approvalId, {
        status: "invalidated",
        reason: "arguments changed",
      });
      task.pendingApprovals.delete(last.approvalId);
      this.emit(
        "approval_resolved",
        {
          conversation_id: conversation.id,
          task_id: task.id,
          approval_id: last.approvalId,
          tool_call_id: last.id,
          status: "invalidated",
          reason: "arguments changed",
        },
        opts,
      );
    }
    this.deps.writer.updateToolCall(last.id, {
      status: "invalidated",
      detail: "superseded by a new binding revision",
    });
    last.status = "invalidated";
    this.afterCommit.push(() =>
      this.settle(last, {
        behavior: "deny",
        message: "Mia invalidated the earlier approval: the arguments changed.",
      }),
    );
  }

  // ---------------------------------------------------------------- approval controller

  private async handlePermission(
    task: TaskState,
    req: PermissionRequest,
  ): Promise<PermissionDecision> {
    const conversation = this.conversation;
    if (!conversation || this.task !== task)
      return { behavior: "deny", message: "Mia has no active task for this call." };
    const opts = { taskId: task.id, executionId: task.executionId };
    const runtimeCallId = req.toolUseId;
    if (!runtimeCallId) {
      this.tx(() =>
        this.emit(
          "error",
          {
            code: "runtime_failure",
            message: `permission request for ${req.toolName} carried no runtime call id; rejected`,
            conversation_id: conversation.id,
            task_id: task.id,
          },
          opts,
        ),
      );
      return {
        behavior: "deny",
        message: "Mia cannot bind this call to a runtime call id; rejected.",
      };
    }
    const digest = canonicalDigest(req.input);
    // Policy is exactly what the profile says. After an interruption the next turn's Mia note tells the model which
    // effects are unknown; deciding whether a repeat is safe is the model's job, not a reason to re-prompt an allowed tool.
    const policy = this.deps.profile.runtime.toolPolicy[req.toolName] ?? "unlisted";
    let call: ToolCallState;
    let decision: PermissionDecision | null;
    try {
      ({ call, decision } = this.tx<{ call: ToolCallState; decision: PermissionDecision | null }>(
        () => {
          const last = task.calls.get(runtimeCallId)?.at(-1);
          let bound: ToolCallState;
          if (
            last &&
            last.digest === digest &&
            last.toolIdentity === req.toolName &&
            (last.status === "proposed" || last.status === "awaiting_approval")
          ) {
            bound = last;
          } else {
            if (last) this.supersede(task, last);
            const proposal = this.record(
              "tool_proposed",
              {
                runtime_call_id: runtimeCallId,
                tool_identity: req.toolName,
                redacted_arguments: redactValue(req.input),
                argument_digest: digest,
                source: "permission_request",
              },
              opts,
            );
            bound = this.newCallState(task, {
              runtimeCallId,
              toolIdentity: req.toolName,
              digest,
              args: req.input,
              policy,
              proposalEventId: proposal.id,
            });
          }
          const evaluation = this.record(
            "policy_evaluated",
            {
              tool_call_id: bound.id,
              tool_identity: bound.toolIdentity,
              policy,
              gate_open: task.gateOpen,
              execution_epoch: task.epoch,
              binding_revision: bound.revision,
            },
            opts,
          );
          const deny = (denial: {
            status: ToolCallStatus;
            detail: string;
            message: string;
            interrupt?: boolean;
          }): PermissionDecision => {
            this.deps.writer.updateToolCall(bound.id, {
              status: denial.status,
              detail: denial.detail,
            });
            bound.status = denial.status;
            return denial.interrupt
              ? { behavior: "deny", message: denial.message, interrupt: denial.interrupt }
              : { behavior: "deny", message: denial.message };
          };
          if (policy === "unlisted") {
            this.emit(
              "error",
              {
                code: "configuration_error",
                message: `tool ${bound.toolIdentity} is not listed in toolPolicy; call denied`,
                conversation_id: conversation.id,
                task_id: task.id,
              },
              opts,
            );
            return {
              call: bound,
              decision: deny({
                status: "denied",
                detail: "tool not listed in toolPolicy",
                message: `Mia denied ${bound.toolIdentity}: it is not part of the configured policy.`,
              }),
            };
          }
          if (policy === "deny")
            return {
              call: bound,
              decision: deny({
                status: "denied",
                detail: "denied by policy",
                message: `Mia denied ${bound.toolIdentity}: policy forbids it.`,
              }),
            };
          if (!task.gateOpen)
            return {
              call: bound,
              decision: deny({
                status: "blocked_gate",
                detail: "action gate closed by interruption",
                message: "Mia blocked this call: the task is being interrupted.",
                interrupt: true,
              }),
            };
          if (policy === "allow") {
            const dispatched = this.record(
              "tool_dispatched",
              {
                tool_call_id: bound.id,
                runtime_call_id: bound.runtimeCallId,
                tool_identity: bound.toolIdentity,
                policy,
                via: "policy",
              },
              { ...opts, causedBy: evaluation.id },
            );
            this.deps.writer.updateToolCall(bound.id, {
              status: "dispatched",
              dispatchEventId: dispatched.id,
            });
            bound.status = "dispatched";
            return { call: bound, decision: { behavior: "allow" } };
          }
          // ask: durable pending approval bound to (conversation, task, runtime call, revision, tool, digest, epoch).
          const approvalId = this.deps.writer.createApproval({
            toolCallId: bound.id,
            executionEpoch: task.epoch,
            requestingEventId: null,
          });
          const requested = this.emit(
            "approval_requested",
            {
              conversation_id: conversation.id,
              task_id: task.id,
              approval_id: approvalId,
              tool_call_id: bound.id,
              runtime_call_id: bound.runtimeCallId,
              binding_revision: bound.revision,
              execution_epoch: task.epoch,
              tool_identity: bound.toolIdentity,
              intended_action: describeAction(bound.toolIdentity, bound.redactedArguments),
              redacted_arguments: bound.redactedArguments,
              argument_digest: bound.digest,
              explainable: true,
            },
            opts,
          );
          this.deps.catalog.update("approvals", approvalId, {
            requesting_event_id: requested.id,
          });
          this.deps.writer.updateToolCall(bound.id, { status: "awaiting_approval" });
          this.deps.writer.updateTask(task.id, { status: "awaiting_approval" });
          bound.status = "awaiting_approval";
          bound.approvalId = approvalId;
          task.pendingApprovals.set(approvalId, bound);
          task.status = "awaiting_approval";
          return { call: bound, decision: null };
        },
      ));
    } catch (error) {
      this.deps.log(`permission handling failed: ${errorMessage(error)}`);
      return { behavior: "deny", message: "Mia could not record this call; it was not released." };
    }
    this.notifyToolCall(task, call);
    if (decision) return decision;
    return new Promise<PermissionDecision>((resolve) => {
      call.resolve = resolve;
      req.abandoned.addEventListener("abort", () => this.abandon(task, call, resolve), {
        once: true,
      });
    });
  }

  /** The runtime dropped the held prompt (process gone or turn aborted): the pending approval can never release anything. */
  private abandon(
    task: TaskState,
    call: ToolCallState,
    resolve: (decision: PermissionDecision) => void,
  ): void {
    if (call.resolve !== resolve) return;
    call.resolve = null;
    const approvalId = call.approvalId;
    if (approvalId && task.pendingApprovals.has(approvalId)) {
      try {
        this.tx(() => {
          this.deps.writer.updateApproval(approvalId, {
            status: "expired",
            reason: "runtime abandoned the prompt",
          });
          this.deps.writer.updateToolCall(call.id, {
            status: "invalidated",
            detail: "runtime abandoned the held call",
          });
          this.emit(
            "approval_resolved",
            {
              conversation_id: this.activeConversation.id,
              task_id: task.id,
              approval_id: approvalId,
              tool_call_id: call.id,
              status: "expired",
              reason: "runtime abandoned the prompt",
            },
            { taskId: task.id, executionId: task.executionId },
          );
        });
        call.status = "invalidated";
        task.pendingApprovals.delete(approvalId);
        task.abandoned.push(call);
      } catch (error) {
        this.deps.log(`could not record abandoned approval: ${String(error)}`);
      }
    }
    resolve({
      behavior: "deny",
      message: `Mia: the approval prompt for ${call.toolIdentity} was abandoned before the user decided. This call was never released and did not run; its outcome is known, not unknown. Do not retry it.`,
    });
  }

  // ---------------------------------------------------------------- turn completion

  private async finishTurn(task: TaskState, result: TurnResult): Promise<void> {
    const conversation = this.conversation;
    if (!conversation) return;
    const opts = { taskId: task.id, executionId: task.executionId };
    const actions = classifyActions(task);
    const unknown = actions.some((action) => action.status === "unknown");
    const { status, error } = classifyTask(task, result, unknown);
    const hooks = readHookEvidence(result.hookEvidencePath);
    const efforts = effortLevels(hooks);
    try {
      this.tx(() => {
        const { writer } = this.deps;
        for (const call of task.calls.values().flatMap((revisions) => revisions))
          writer.updateToolCall(call.id, { status: call.status, detail: detailFor(call.status) });
        for (const call of task.pendingApprovals.values())
          if (call.approvalId)
            writer.updateApproval(call.approvalId, { status: "expired", reason: "task ended" });
        const retain = (artifact: {
          kind: string;
          name: string;
          bytes: Buffer;
          relation: "runtime_transcript" | "task_output";
          originalPath?: string;
        }) => {
          const art = writer.registerArtifact({
            kind: artifact.kind,
            logicalName: artifact.name,
            mimeType: "application/x-ndjson",
            bytes: artifact.bytes,
            producerExecutionId: task.executionId,
            originalPath: artifact.originalPath ?? null,
          });
          writer.linkArtifact({
            conversationId: conversation.id,
            artifactId: art.artifactId,
            relation: artifact.relation,
            taskId: task.id,
          });
        };
        if (existsSync(result.streamLogPath))
          retain({
            kind: "runtime_transcript",
            name: `turn-${conversation.turnCount}.stream.jsonl`,
            bytes: readFileSync(result.streamLogPath),
            relation: "runtime_transcript",
            originalPath: result.streamLogPath,
          });
        if (hooks.length > 0)
          retain({
            kind: "effort_evidence",
            name: `turn-${conversation.turnCount}.hooks.jsonl`,
            bytes: Buffer.from(hooks.map((hook) => JSON.stringify(hook)).join("\n") + "\n"),
            relation: "task_output",
          });
        writer.updateExecution(task.executionId, {
          status: executionStatusFor(task, result),
          endedAt: nowIso(),
          reportedModel: task.reportedModel,
          reportedEffort: efforts.length === 1 ? (efforts[0] ?? null) : null,
          effortEvidence: {
            source: "PreToolUse hook",
            values: efforts,
            samples: hooks.length,
            note:
              hooks.length === 0 ? "no tool use in this turn; effective effort unreported" : null,
          },
        });
        if (task.interrupted)
          this.emit(
            "interruption_outcome",
            {
              conversation_id: conversation.id,
              task_id: task.id,
              task_status: status,
              actions,
              runtime_cancellation: result.runtimeCancellation,
            },
            opts,
          );
        writer.updateTask(task.id, { status, finishedAt: nowIso() });
        this.emit(
          "task_finished",
          {
            conversation_id: conversation.id,
            task_id: task.id,
            status,
            ...(error ? { error } : {}),
            usage: result.result?.usage ?? undefined,
          },
          opts,
        );
        if (error)
          this.emit(
            "error",
            {
              code: "runtime_failure",
              message: error,
              conversation_id: conversation.id,
              task_id: task.id,
            },
            opts,
          );
      });
    } catch (recordError) {
      this.deps.log(`finishTurn record failure: ${String(recordError)}`);
    }
    task.pendingApprovals.clear();
    task.status = status;
    if (task.interrupted || unknown) {
      // The runtime's own memory of a killed turn is incomplete (capability record L1); Mia's records are authoritative.
      const lines = actions
        .filter((action) => action.status !== "denied")
        .map(
          (action) =>
            `- ${action.tool_identity}: ${action.status}${action.detail ? ` (${action.detail})` : ""}`,
        );
      conversation.pendingNote = `[Mia note, not from the user] Your previous turn was ${task.interrupted ? "interrupted by the user" : "ended by a runtime failure"}. Mia's records of tool calls in that turn:\n${lines.join("\n") || "- no tool calls"}\nAn "unknown" action may or may not have taken effect; do not repeat any of those actions unless the user asks again, and if they do, weigh whether a repeat could double an effect before calling.`;
    } else if (task.abandoned.length > 0) {
      const lines = task.abandoned.map(
        (call) => `- ${call.toolIdentity} ${JSON.stringify(call.redactedArguments)}`,
      );
      conversation.pendingNote = `[Mia note, not from the user] In your previous turn the runtime abandoned the approval prompt for these calls before the user decided:\n${lines.join("\n")}\nMia never released them: they did not run and their outcome is known (nothing happened), not unknown. If you reported otherwise, correct it. Do not retry them unless the user asks again.`;
    }
  }

  /** A tool result may declare a generated file as {"artifact": {...}}; only files inside the configured output directories are retained. */
  private collectArtifacts(
    task: TaskState,
    call: ToolCallState,
    result: { content: unknown; eventId: string },
  ): void {
    const declared = extractDeclaredArtifact(result.content);
    if (!declared) return;
    const { writer } = this.deps;
    let capture:
      | { status: "retained"; bytes: Buffer }
      | { status: "external_only" | "missing" | "failed"; reason: string };
    if (!existsSync(declared.path))
      capture = { status: "missing", reason: "declared file not found at collection time" };
    else {
      const real = realpathSync(declared.path);
      if (
        !this.deps.profile.runtime.outputDirectories.some((dir) =>
          real.startsWith(realpathSync(dir) + sep),
        )
      )
        capture = {
          status: "external_only",
          reason: "declared path resolves outside the configured output directories",
        };
      else {
        const bytes = readFileSync(real);
        const digest = sha256Hex(bytes);
        capture =
          declared.sha256 && declared.sha256 !== digest
            ? {
                status: "failed",
                reason: `declared sha256 ${declared.sha256} does not match file ${digest}`,
              }
            : { status: "retained", bytes };
      }
    }
    const conversationId = this.activeConversation.id;
    const art = writer.registerArtifact({
      kind: "tool_output",
      logicalName: declared.name ?? declared.path,
      mimeType: declared.mime_type ?? "application/octet-stream",
      producerExecutionId: task.executionId,
      producerEventId: result.eventId,
      originalPath: declared.path,
      ...(capture.status === "retained"
        ? { bytes: capture.bytes }
        : {
            captureStatus: capture.status,
            externalLocator: declared.path,
            captureReason: capture.reason,
          }),
    });
    writer.linkArtifact({
      conversationId,
      artifactId: art.artifactId,
      relation: "tool_result",
      toolCallId: call.id,
      taskId: task.id,
    });
    if (capture.status === "retained") {
      writer.linkArtifact({
        conversationId,
        artifactId: art.artifactId,
        relation: "task_output",
        taskId: task.id,
      });
      this.record(
        "artifact_registered",
        {
          artifact_id: art.artifactId,
          tool_call_id: call.id,
          digest: art.digest,
          size: art.byteSize,
          original_path: declared.path,
        },
        { taskId: task.id, executionId: task.executionId, causedBy: result.eventId },
      );
    }
  }

  async waitForIdle(): Promise<void> {
    await this.task?.finished;
  }
}
