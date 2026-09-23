import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { match } from "ts-pattern";
import {
  policyFor,
  readHookEvidence,
  readRuntimeFile,
  type HookEvidence,
  type RuntimeFileRead,
  type RuntimeEvent,
  type PermissionDecision,
  type PermissionRequest,
  type Profile,
  type TurnHandle,
  type TurnOptions,
  type TurnResult,
} from "@mia/agent-adapter";
import {
  PROTOCOL_VERSION,
  canonicalDigest,
  errorMessage,
  redactValue,
  type ApprovalStatus,
  type ClientCommand,
  type ClientDiagnostics,
  type Decision,
  type ErrorCode,
  type EventPayload,
  type ServerEvent,
  type ServerEventType,
  type TaskStatus,
  type ToolCallPolicy,
  type ToolCallStatus,
} from "@mia/protocol";
import { newId, nowIso, type ArtifactKind, type Catalog, type RecordWriter } from "@mia/records";
import {
  captureFields,
  extractDeclaredArtifact,
  type Capture,
  type DeclaredArtifact,
} from "./artifact-capture.ts";
import { collectArtifact } from "./artifact-collector.ts";
import { createConversationProvenance } from "./provenance.ts";
import {
  bindPermissionRequest,
  bindStreamProposal,
  bindToolResult,
  classifyActions,
  classifyTask,
  decideAbandonment,
  decideApproval,
  decideInterruption,
  evaluatePermission,
  executionStatusFor,
  noteAfterTurn,
  statusAfterResult,
  supersedeBinding,
  type ApprovalChange,
  type ApprovalOutcome,
  type CallChange,
  type InterruptionOutcome,
  type PermissionRule,
} from "./transitions.ts";

/** Sends one event to one connection. */
export type Delivery = (connectionId: string, event: ServerEvent) => void;

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
  policy: ToolCallPolicy;
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

/** Pending approvals the task has besides `approvalId`: what is left once that one is resolved. */
const otherPending = (task: TaskState, approvalId: string | null): number =>
  task.pendingApprovals.size -
  (approvalId !== null && task.pendingApprovals.has(approvalId) ? 1 : 0);

/**
 * What a task-scoped command is allowed to act on. `rejected` and `no_active_task` carry the answer
 * to send back, so a caller that has nothing to add returns it unread; `approvalDecision` looks a
 * resolved approval up before falling back to it.
 */
type AddressedTask =
  | { kind: "active"; task: TaskState }
  | { kind: "rejected"; result: CommandResult }
  | { kind: "no_active_task"; result: CommandResult };

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
  /** The server process's environment; conversation provenance probes the runtime with it. */
  env: NodeJS.ProcessEnv;
  log: (message: string) => void;
}

/** Linkage recorded with an event: the task and execution it belongs to and the event that caused it. */
interface EventOpts {
  taskId?: string | null;
  executionId?: string | null;
  causedBy?: string | null;
}

/** A client-facing event as a correlated type/payload pair, so the envelope needs no assertion. */
type OutgoingEvent = {
  [T in ServerEventType]: { type: T; payload: EventPayload<T> };
}[ServerEventType];

interface NewCallInput {
  runtimeCallId: string;
  toolIdentity: string;
  digest: string;
  args: unknown;
  policy: ToolCallPolicy;
  proposalEventId: string | null;
}

const RUNTIME_IDENTITY = "claude-code";

/** An artifact a finished turn retains for its task, with the bytes read for it or why they could not be. */
interface TurnEvidence {
  kind: ArtifactKind;
  name: string;
  relation: "runtime_transcript" | "task_output";
  originalPath: string | null;
  content: Exclude<RuntimeFileRead, { status: "absent" }>;
}

/** A tool output a completed call declared, and the tool_result event that declared it. */
interface DeclaredOutput {
  task: TaskState;
  call: ToolCallState;
  declared: DeclaredArtifact;
  eventId: string;
}

/** State changes and effects a transaction queues; neither runs unless it commits. */
interface CommitQueue {
  state: (() => void)[];
  effects: (() => void)[];
}

const emptyQueue = (): CommitQueue => ({ state: [], effects: [] });

/** Effective effort reported by one PreToolUse hook record: `effort.level`, a bare `effort`, else CLAUDE_EFFORT. */
const effortLevelOf = (hook: Record<string, unknown>): unknown => {
  const effort = hook.effort;
  if (typeof effort === "object" && effort !== null)
    return ("level" in effort ? effort.level : undefined) ?? hook.env_claude_effort;
  return effort ?? hook.env_claude_effort;
};

/** Why the effort evidence holds no effort level, or null when the hook reported samples. */
const effortNote = ({ records, malformedLines, readError }: HookEvidence): string | null => {
  if (records.length > 0) return null;
  if (readError !== null)
    return `hook evidence unreadable (${readError}); effective effort unreported`;
  if (malformedLines > 0)
    return `hook evidence unreadable (${malformedLines} malformed lines); effective effort unreported`;
  return "no tool use in this turn; effective effort unreported";
};

/** Distinct effective-effort values reported by the PreToolUse hook. */
const effortLevels = (hooks: Record<string, unknown>[]): string[] => {
  const levels = hooks.map(effortLevelOf);
  return [...new Set(levels.filter((level): level is string => typeof level === "string"))];
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

/**
 * Conversation/task coordinator plus approval and interruption controller. One conversation, one task,
 * one active client. The rules live in ./transitions.ts; the engine commits what they decide, applies it
 * to its state only after the commit, then performs the effects (see `tx`).
 */
export class Engine {
  conversation: ConversationState | null = null;
  task: TaskState | null = null;
  activeConnectionId: string | null = null;
  activeClientId: string | null = null;
  /** Delivers events to a connection while one is attached (attachDelivery); until then nothing is sent. */
  private delivery: Delivery | null = null;
  /** Set once by shutdown: from then on every command is refused and no new task can start. */
  private shuttingDown = false;
  /** What the transaction in progress will apply and perform once it commits. */
  private queued: CommitQueue = emptyQueue();

  constructor(private readonly deps: EngineDeps) {}

  /** The conversation every guarded command and runtime callback operates on; callers check for one first. */
  private get activeConversation(): ConversationState {
    if (!this.conversation) throw new Error("engine has no active conversation");
    return this.conversation;
  }

  // ---------------------------------------------------------------- event plumbing

  /**
   * Write `records` in one catalog transaction. A failed commit throws, applies no queued state change and
   * performs no queued effect, so nothing is released or delivered. After a commit the queued state changes
   * apply, then each effect runs on its own: one that throws is logged as a delivery failure, never reported
   * as a persistence failure, and the records, the state, and the remaining effects stand.
   */
  private tx<T>(records: () => T): T {
    let result: T;
    try {
      result = this.deps.catalog.transaction(records);
    } catch (error) {
      this.queued = emptyQueue();
      throw error;
    }
    const { state, effects } = this.queued;
    this.queued = emptyQueue();
    for (const apply of state) apply();
    for (const effect of effects) {
      try {
        effect();
      } catch (error) {
        this.deps.log(`delivery failed after commit; records stand: ${errorMessage(error)}`);
      }
    }
    return result;
  }

  /**
   * Queue a state change for when the transaction in progress commits (inside tx). It must not throw: it runs
   * after the commit, where a throw would read as a persistence failure and skip the queued effects.
   */
  private onCommit(apply: () => void): void {
    this.queued.state.push(apply);
  }

  /** Queue an effect (client delivery or runtime answer) for after the commit and its state changes (inside tx). */
  private afterCommit(effect: () => void): void {
    this.queued.effects.push(effect);
  }

  private deliver(event: OutgoingEvent, envelope: { id: string; sequence: number | null }): void {
    const connectionId = this.activeConnectionId;
    if (!connectionId || !this.delivery) return;
    this.delivery(connectionId, {
      protocol_version: PROTOCOL_VERSION,
      message_id: envelope.id,
      conversation_id: this.conversation?.id ?? null,
      sequence: envelope.sequence,
      server_time: nowIso(),
      ...event,
    });
  }

  /** Persist an event (inside tx) and queue its delivery with the persisted id and sequence. */
  private emit(event: OutgoingEvent, opts: EventOpts = {}): { id: string; sequence: number } {
    const ev = this.record(event.type, event.payload, opts);
    this.afterCommit(() => this.deliver(event, { id: ev.id, sequence: ev.sequence }));
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
    this.deliver(
      {
        type: "tool_call",
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
      },
      { id: newId("evt"), sequence: null },
    );
  }

  /**
   * Attach the function that delivers events to connections; the gateway attaches its own once it is
   * listening and calls the returned detach when it closes. Attaching replaces any earlier delivery, and a
   * detach removes only the delivery it attached, so a stale detach cannot silence its replacement.
   */
  attachDelivery(delivery: Delivery): () => void {
    this.delivery = delivery;
    return () => {
      if (this.delivery === delivery) this.delivery = null;
    };
  }

  // ---------------------------------------------------------------- commands

  /** Run one validated client command; once shutdown has begun, every command is refused unrun. */
  handle(ctx: CommandContext, command: ClientCommand): CommandResult {
    if (this.shuttingDown) return fail("invalid_state", "the server is shutting down");
    return match(command)
      .with({ type: "start_conversation" }, () => this.startConversation(ctx))
      .with({ type: "submit_text" }, (cmd) => this.submitText(ctx, cmd.payload))
      .with({ type: "approval_decision" }, (cmd) => this.approvalDecision(ctx, cmd.payload))
      .with({ type: "interrupt_task" }, (cmd) => this.interruptTask(ctx, cmd.payload))
      .with({ type: "diagnostic_snapshot" }, (cmd) => this.diagnosticSnapshot(ctx, cmd.payload))
      .with({ type: "heartbeat" }, (cmd) => this.heartbeat(ctx, cmd.payload))
      .exhaustive();
  }

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
      // Unlike task transitions, this sets state inside the transaction, because `record` reads the active
      // conversation; the catch below restores it.
      return this.tx(() => {
        const provenance = createConversationProvenance({
          writer,
          profile,
          clientBuild: ctx.clientBuild,
          sourceRoot: this.deps.sourceRoot,
          env: this.deps.env,
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
        this.emit({
          type: "conversation_started",
          payload: {
            conversation_id: conv.id,
            started_at: conv.startedAt,
            provenance_set_id: provenance.provenance_set_id,
          },
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
          {
            type: "task_started",
            payload: {
              conversation_id: conversation.id,
              task_id: taskId,
              execution_id: executionId,
              execution_epoch: epoch,
              text: payload.text,
            },
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
      onEvent: (event) => this.onRuntimeEvent(task, event),
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
    const addressed = this.addressTask(ctx, payload);
    if (addressed.kind === "rejected") return addressed.result;
    if (addressed.kind === "no_active_task") {
      const known = this.deps.catalog.get<{ status: ApprovalStatus; task_id: string }>(
        "SELECT a.status, t.task_id FROM approvals a JOIN tool_calls t ON t.id = a.tool_call_id WHERE a.id = ?",
        payload.approval_id,
      );
      if (known && known.task_id === payload.task_id)
        return fail(
          "invalid_state",
          `approval ${payload.approval_id} is ${known.status} and task ${payload.task_id} is no longer active; a decision cannot be reused`,
        );
      return addressed.result;
    }
    const { task } = addressed;
    const call = task.pendingApprovals.get(payload.approval_id);
    const outcome = decideApproval({
      decision: payload.decision,
      ownerClientId: task.clientId,
      deciderClientId: ctx.clientId,
      call,
      task: {
        status: task.status,
        gateOpen: task.gateOpen,
        epoch: task.epoch,
        otherPending: otherPending(task, call ? payload.approval_id : null),
      },
      conversationEpoch: this.activeConversation.epoch,
    });
    return match(outcome)
      .with({ kind: "not_owner" }, () =>
        fail("unauthenticated", "decision must come from the client that owns the task"),
      )
      .with({ kind: "not_pending" }, () => {
        const known = this.deps.catalog.get<{ status: ApprovalStatus }>(
          "SELECT a.status FROM approvals a JOIN tool_calls t ON t.id = a.tool_call_id WHERE a.id = ? AND t.task_id = ?",
          payload.approval_id,
          task.id,
        );
        // A row still pending here is no longer held in memory, for example because its abandonment could not
        // be recorded: Mia never released its call and no decision can now.
        if (known?.status === "pending")
          return fail(
            "invalid_state",
            `approval ${payload.approval_id} can no longer be decided; its call was not released`,
          );
        if (known)
          return fail(
            "invalid_state",
            `approval ${payload.approval_id} is ${known.status}, not pending; a decision cannot be reused`,
          );
        return fail("not_found", `approval ${payload.approval_id} does not exist for this task`);
      })
      .with({ kind: "decided" }, (decided) => this.commitDecision({ ctx, task, payload, decided }))
      .exhaustive();
  }

  /** Persist a user decision before any release; the held call changes and is answered only after the commit. */
  private commitDecision(input: {
    ctx: CommandContext;
    task: TaskState;
    payload: { approval_id: string; decision: Decision };
    decided: Extract<ApprovalOutcome<ToolCallState>, { kind: "decided" }>;
  }): CommandResult {
    const { ctx, task, payload, decided } = input;
    const approvalId = payload.approval_id;
    const { call, change } = decided;
    try {
      this.tx(() => {
        const { writer } = this.deps;
        const resolved = this.emit(
          this.approvalResolved(task, { approvalId, callId: call.id, status: decided.approval }),
          this.taskOpts(task),
        );
        writer.updateApproval(approvalId, {
          status: decided.approval,
          decisionEventId: resolved.id,
          decisionClientId: ctx.clientId,
        });
        if (decided.release)
          this.recordDispatch(task, call, { via: "approval", causedBy: resolved.id });
        else this.recordCallChange(change);
        this.recordTaskStatus(task, decided.taskStatus);
        this.onCommit(() => task.pendingApprovals.delete(approvalId));
        this.afterCommit(() => this.notifyToolCall(task, call, change.notice));
        this.commitCallChange(call, change);
      });
    } catch (error) {
      // Record failure: the call stays held and pending; nothing is released.
      return fail(
        "record_failure",
        `decision not recorded; call remains held: ${errorMessage(error)}`,
      );
    }
    return {
      ok: true,
      result: { approval_id: approvalId, released: decided.release, decision: payload.decision },
    };
  }

  interruptTask(
    ctx: CommandContext,
    payload: { conversation_id: string; task_id: string },
  ): CommandResult {
    const addressed = this.addressTask(ctx, payload);
    if (addressed.kind !== "active") return addressed.result;
    return this.interrupt(addressed.task);
  }

  /** Interrupt the active task through the recorded path, whoever asked: a client or shutdown. */
  private interrupt(task: TaskState): CommandResult {
    const outcome = decideInterruption({
      taskStatus: task.status,
      conversationEpoch: this.activeConversation.epoch,
      pending: [...task.pendingApprovals].map(([approvalId, call]) => ({ approvalId, call })),
    });
    return match(outcome)
      .with({ kind: "already_interrupting" }, (): CommandResult => ({
        ok: true,
        result: { already_interrupting: true },
      }))
      .with({ kind: "invalid" }, ({ taskStatus }) => fail("invalid_state", `task is ${taskStatus}`))
      .with({ kind: "interrupt" }, (interruption) => this.commitInterruption(task, interruption))
      .exhaustive();
  }

  /** Atomically: close the gate, advance the epoch, invalidate pending approvals, record the order. */
  private commitInterruption(
    task: TaskState,
    interruption: Extract<InterruptionOutcome<ToolCallState>, { kind: "interrupt" }>,
  ): CommandResult {
    const conversation = this.activeConversation;
    const opts = this.taskOpts(task);
    try {
      this.tx(() => {
        const requested = this.emit(
          {
            type: "interruption_requested",
            payload: {
              conversation_id: conversation.id,
              task_id: task.id,
              execution_epoch: interruption.epoch,
            },
          },
          opts,
        );
        for (const change of interruption.approvals)
          this.recordApprovalChange(task, change, { decisionEventId: requested.id });
        this.deps.writer.updateTask(task.id, { status: interruption.task.status });
        this.onCommit(() => {
          task.status = interruption.task.status;
          task.gateOpen = interruption.task.gateOpen;
          task.interrupted = interruption.task.interrupted;
          conversation.epoch = interruption.epoch;
          task.pendingApprovals.clear();
        });
        for (const { call, change } of interruption.calls) {
          this.recordCallChange(change);
          this.afterCommit(() => this.notifyToolCall(task, call, change.notice));
          this.commitCallChange(call, change);
        }
        this.afterCommit(() => {
          if (task.handle)
            task.handle
              .interrupt()
              .catch((error) => this.deps.log(`interrupt failed: ${String(error)}`));
        });
      });
    } catch (error) {
      return fail("record_failure", `interruption not recorded: ${errorMessage(error)}`);
    }
    return { ok: true, result: { execution_epoch: interruption.epoch } };
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

  /** The preamble every task-scoped command shares: guard the conversation, then address the one active task. */
  private addressTask(
    ctx: CommandContext,
    payload: { conversation_id: string; task_id: string },
  ): AddressedTask {
    const guard = this.guard(ctx, payload.conversation_id);
    if (guard) return { kind: "rejected", result: guard };
    const task = this.task;
    if (!task || task.id !== payload.task_id)
      return {
        kind: "no_active_task",
        result: fail("not_found", `task ${payload.task_id} is not the active task`),
      };
    return { kind: "active", task };
  }

  private settle(call: ToolCallState, decision: PermissionDecision): void {
    const resolve = call.resolve;
    call.resolve = null;
    resolve?.(decision);
  }

  private taskOpts(task: TaskState): EventOpts {
    return { taskId: task.id, executionId: task.executionId };
  }

  // ---------------------------------------------------------------- committing transitions

  private approvalResolved(
    task: TaskState,
    resolved: Pick<ApprovalChange, "approvalId" | "callId"> & {
      status: EventPayload<"approval_resolved">["status"];
      reason?: string;
    },
  ): OutgoingEvent {
    return {
      type: "approval_resolved",
      payload: {
        conversation_id: this.activeConversation.id,
        task_id: task.id,
        approval_id: resolved.approvalId,
        tool_call_id: resolved.callId,
        status: resolved.status,
        ...(resolved.reason ? { reason: resolved.reason } : {}),
      },
    };
  }

  /** Record an approval resolved without a user decision, and the event that tells the client (inside tx). */
  private recordApprovalChange(
    task: TaskState,
    change: ApprovalChange,
    cause: { decisionEventId: string | null } = { decisionEventId: null },
  ): void {
    this.deps.writer.updateApproval(change.approvalId, {
      status: change.status,
      reason: change.reason,
      ...(cause.decisionEventId ? { decisionEventId: cause.decisionEventId } : {}),
    });
    this.emit(this.approvalResolved(task, change), {
      ...this.taskOpts(task),
      causedBy: cause.decisionEventId,
    });
  }

  private recordCallChange(change: CallChange): void {
    this.deps.writer.updateToolCall(change.callId, {
      status: change.status,
      ...(change.detail ? { detail: change.detail } : {}),
    });
  }

  /** Record a call's release; the runtime learns of it only through the settle queued after the commit (inside tx). */
  private recordDispatch(
    task: TaskState,
    call: ToolCallState,
    cause: { via: "approval" | "policy"; causedBy: string },
  ): void {
    const dispatched = this.record(
      "tool_dispatched",
      {
        tool_call_id: call.id,
        runtime_call_id: call.runtimeCallId,
        tool_identity: call.toolIdentity,
        policy: call.policy,
        via: cause.via,
      },
      { ...this.taskOpts(task), causedBy: cause.causedBy },
    );
    this.deps.writer.updateToolCall(call.id, {
      status: "dispatched",
      dispatchEventId: dispatched.id,
    });
  }

  /** The call takes its new status once the records commit; its held prompt, if any, is answered after (inside tx). */
  private commitCallChange(call: ToolCallState, change: CallChange): void {
    this.onCommit(() => {
      call.status = change.status;
    });
    const settle = change.settle;
    if (settle) this.afterCommit(() => this.settle(call, settle));
  }

  // ---------------------------------------------------------------- runtime events

  private onRuntimeEvent(task: TaskState, event: RuntimeEvent): void {
    const conversation = this.conversation;
    if (!conversation) return;
    const opts = this.taskOpts(task);
    try {
      this.tx(() =>
        match(event)
          .with({ type: "runtime_started" }, (started) => {
            this.record("runtime_started", { pid: started.pid, launch: started.launch }, opts);
          })
          .with({ type: "runtime_init" }, ({ init }) => {
            this.record("runtime_init", init.evidence, opts);
            this.deps.writer.updateExecution(task.executionId, { reportedModel: init.model });
            this.onCommit(() => {
              task.reportedModel = init.model;
            });
          })
          .with({ type: "text_delta" }, (delta) => {
            this.emit(
              {
                type: "text_delta",
                payload: {
                  conversation_id: conversation.id,
                  task_id: task.id,
                  execution_id: task.executionId,
                  text: delta.text,
                },
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
            const revisions = task.calls.get(proposed.runtimeCallId) ?? [];
            const binding = bindStreamProposal(revisions, {
              toolIdentity: proposed.toolIdentity,
              digest,
            });
            if (binding.kind === "attach") {
              this.deps.writer.updateToolCall(binding.call.id, { proposalEventId: proposal.id });
              return;
            }
            const last = revisions.at(-1);
            if (last) this.supersede(task, last, { toolIdentity: proposed.toolIdentity, digest });
            const policy = policyFor(this.deps.profile.runtime, proposed.toolIdentity);
            const state = this.proposeCall(task, {
              runtimeCallId: proposed.runtimeCallId,
              toolIdentity: proposed.toolIdentity,
              digest,
              args: proposed.arguments,
              policy,
              proposalEventId: proposal.id,
            });
            this.afterCommit(() => this.notifyToolCall(task, state));
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
            const binding = bindToolResult(task.calls.get(toolResult.runtimeCallId) ?? []);
            if (binding.kind === "unmatched") {
              this.record(
                "tool_result_unmatched",
                { runtime_call_id: toolResult.runtimeCallId },
                opts,
              );
              return;
            }
            const { call } = binding;
            const status = statusAfterResult(call.status, toolResult.isError);
            this.deps.writer.updateToolCall(call.id, { status, resultEventId: result.id });
            if (status === "completed")
              this.collectArtifacts(task, call, {
                content: toolResult.content,
                eventId: result.id,
              });
            this.onCommit(() => {
              call.status = status;
            });
            this.afterCommit(() => this.notifyToolCall(task, call));
          })
          .with({ type: "turn_result" }, ({ summary }) => {
            this.record("runtime_result", summary.evidence, opts);
            this.deps.writer.updateExecution(task.executionId, {
              usage: {
                usage: summary.usage,
                totalCostUsd: summary.totalCostUsd,
                durationMs: summary.durationMs,
                durationApiMs: summary.durationApiMs,
                numTurns: summary.numTurns,
              },
            });
          })
          .with({ type: "runtime_stderr" }, (stderr) => {
            this.record("runtime_stderr", { text: stderr.text }, opts);
          })
          .with({ type: "malformed_event" }, (malformed) => {
            this.emit(
              {
                type: "error",
                payload: {
                  code: "runtime_failure",
                  message: `malformed runtime event: ${malformed.error}`,
                  conversation_id: conversation.id,
                  task_id: task.id,
                },
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

  /** Record a new binding revision; the task tracks it only once the records commit (inside tx). */
  private proposeCall(task: TaskState, input: NewCallInput): ToolCallState {
    const { runtimeCallId, toolIdentity, digest, policy, proposalEventId } = input;
    const revision = (task.calls.get(runtimeCallId)?.at(-1)?.revision ?? 0) + 1;
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
    this.onCommit(() => {
      const revisions = task.calls.get(runtimeCallId) ?? [];
      revisions.push(state);
      task.calls.set(runtimeCallId, revisions);
    });
    return state;
  }

  /** Invalidate a held earlier binding and any pending approval it carries (inside tx). */
  private supersede(
    task: TaskState,
    last: ToolCallState,
    next: { toolIdentity: string; digest: string },
  ): void {
    const superseded = supersedeBinding(last, next, {
      status: task.status,
      otherPending: otherPending(task, last.approvalId),
    });
    if (!superseded) return;
    const { approval, call, taskStatus } = superseded;
    if (approval) {
      this.recordApprovalChange(task, approval);
      this.onCommit(() => task.pendingApprovals.delete(approval.approvalId));
    }
    this.recordCallChange(call);
    this.commitCallChange(last, call);
    this.recordTaskStatus(task, taskStatus);
  }

  /**
   * Record the task's status and apply it once the transaction commits (inside tx). It writes even an unchanged
   * status: comparing against `task.status` would read the committed value, not one an earlier step of the same
   * transaction set. The write and the queued change both keep transaction order, so the last one wins in the
   * records and in memory alike (a superseded approval resumes the task, then the new revision's ask holds it).
   */
  private recordTaskStatus(task: TaskState, status: TaskStatus): void {
    this.deps.writer.updateTask(task.id, { status });
    this.onCommit(() => {
      task.status = status;
    });
  }

  // ---------------------------------------------------------------- approval controller

  private async handlePermission(
    task: TaskState,
    req: PermissionRequest,
  ): Promise<PermissionDecision> {
    if (!this.conversation || this.task !== task)
      return { behavior: "deny", message: "Mia has no active task for this call." };
    const opts = this.taskOpts(task);
    const runtimeCallId = req.toolUseId;
    if (!runtimeCallId)
      return this.refuseRequest(task, {
        detail: `permission request for ${req.toolName} carried no runtime call id; rejected`,
        settle: {
          behavior: "deny",
          message: "Mia cannot bind this call to a runtime call id; rejected.",
        },
      });
    const digest = canonicalDigest(req.input);
    const last = task.calls.get(runtimeCallId)?.at(-1);
    const binding = bindPermissionRequest(last, { toolIdentity: req.toolName, digest });
    if (binding.kind === "duplicate")
      return this.refuseRequest(task, {
        detail: `permission request for ${req.toolName} (${runtimeCallId}) ${binding.detail}; denied`,
        settle: binding.settle,
      });
    // Policy is exactly what the profile says. After an interruption the next turn's Mia note tells the model which
    // effects are unknown; deciding whether a repeat is safe is the model's job, not a reason to re-prompt an allowed tool.
    const policy = policyFor(this.deps.profile.runtime, req.toolName);
    const rule = evaluatePermission({
      policy,
      gateOpen: task.gateOpen,
      toolIdentity: req.toolName,
    });
    let call: ToolCallState;
    try {
      call = this.tx(() => {
        let bound: ToolCallState;
        if (binding.kind === "reuse") {
          bound = binding.call;
        } else {
          if (last) this.supersede(task, last, { toolIdentity: req.toolName, digest });
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
          bound = this.proposeCall(task, {
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
        this.recordPermission({ task, call: bound, rule, evaluationId: evaluation.id });
        this.afterCommit(() => this.notifyToolCall(task, bound));
        return bound;
      });
    } catch (error) {
      this.deps.log(`permission handling failed: ${errorMessage(error)}`);
      return { behavior: "deny", message: "Mia could not record this call; it was not released." };
    }
    return match(rule)
      .with({ kind: "deny" }, (denial): PermissionDecision =>
        denial.interrupt
          ? { behavior: "deny", message: denial.message, interrupt: true }
          : { behavior: "deny", message: denial.message },
      )
      .with({ kind: "dispatch" }, (): PermissionDecision => ({ behavior: "allow" }))
      .with({ kind: "ask" }, () => {
        const { promise, resolve } = Promise.withResolvers<PermissionDecision>();
        call.resolve = resolve;
        req.abandoned.addEventListener("abort", () => this.abandon(task, call, resolve), {
          once: true,
        });
        return promise;
      })
      .exhaustive();
  }

  /**
   * Refuse a permission request that binds to no new call: nothing is proposed or approved, and the runtime
   * gets the refusal even if recording it fails.
   */
  private refuseRequest(
    task: TaskState,
    refusal: { detail: string; settle: PermissionDecision },
  ): PermissionDecision {
    try {
      this.tx(() =>
        this.emit(
          {
            type: "error",
            payload: {
              code: "runtime_failure",
              message: refusal.detail,
              conversation_id: this.activeConversation.id,
              task_id: task.id,
            },
          },
          this.taskOpts(task),
        ),
      );
    } catch (error) {
      this.deps.log(`could not record a refused permission request: ${errorMessage(error)}`);
    }
    return refusal.settle;
  }

  /** Record what the permission rule decided for a bound call (inside tx). */
  private recordPermission(input: {
    task: TaskState;
    call: ToolCallState;
    rule: PermissionRule;
    evaluationId: string;
  }): void {
    const { task, call, rule, evaluationId } = input;
    const conversation = this.activeConversation;
    const opts = this.taskOpts(task);
    match(rule)
      .with({ kind: "deny" }, (denial) => {
        if (denial.unlisted)
          this.emit(
            {
              type: "error",
              payload: {
                code: "configuration_error",
                message: `tool ${call.toolIdentity} is not listed in toolPolicy; call denied`,
                conversation_id: conversation.id,
                task_id: task.id,
              },
            },
            opts,
          );
        const change: CallChange = {
          callId: call.id,
          status: denial.status,
          detail: denial.detail,
          settle: null,
        };
        this.recordCallChange(change);
        this.commitCallChange(call, change);
      })
      .with({ kind: "dispatch" }, () => {
        this.recordDispatch(task, call, { via: "policy", causedBy: evaluationId });
        this.onCommit(() => {
          call.status = "dispatched";
        });
      })
      .with({ kind: "ask" }, () => {
        // Durable pending approval bound to (conversation, task, runtime call, revision, tool, digest, epoch).
        const approvalId = this.deps.writer.createApproval({
          toolCallId: call.id,
          executionEpoch: task.epoch,
          requestingEventId: null,
        });
        const requested = this.emit(
          {
            type: "approval_requested",
            payload: {
              conversation_id: conversation.id,
              task_id: task.id,
              approval_id: approvalId,
              tool_call_id: call.id,
              runtime_call_id: call.runtimeCallId,
              binding_revision: call.revision,
              execution_epoch: task.epoch,
              tool_identity: call.toolIdentity,
              intended_action: describeAction(call.toolIdentity, call.redactedArguments),
              redacted_arguments: call.redactedArguments,
              argument_digest: call.digest,
              explainable: true,
            },
          },
          opts,
        );
        this.deps.catalog.update("approvals", approvalId, { requesting_event_id: requested.id });
        this.deps.writer.updateToolCall(call.id, { status: "awaiting_approval" });
        this.onCommit(() => {
          call.status = "awaiting_approval";
          call.approvalId = approvalId;
          task.pendingApprovals.set(approvalId, call);
        });
        this.recordTaskStatus(task, "awaiting_approval");
      })
      .exhaustive();
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
    const { expire, settle } = decideAbandonment({
      call,
      approvalId,
      pending: approvalId !== null && task.pendingApprovals.has(approvalId),
      task: { status: task.status, otherPending: otherPending(task, approvalId) },
    });
    if (expire) {
      const applyExpiry = (): void => {
        call.status = expire.call.status;
        task.status = expire.taskStatus;
        task.pendingApprovals.delete(expire.approval.approvalId);
        task.abandoned.push(call);
      };
      try {
        this.tx(() => {
          this.recordApprovalChange(task, expire.approval);
          this.recordCallChange(expire.call);
          this.deps.writer.updateTask(task.id, { status: expire.taskStatus });
          this.onCommit(applyExpiry);
        });
      } catch (error) {
        this.deps.log(`could not record abandoned approval: ${String(error)}`);
        // The runtime is denied below whatever the records say, so memory takes the expiry anyway: a later
        // decision finds nothing pending and cannot release the call. The catalog keeps the approval pending
        // until finishTurn records the call's final status and expires every approval still pending.
        applyExpiry();
      }
    }
    resolve(settle);
  }

  // ---------------------------------------------------------------- turn completion

  private async finishTurn(task: TaskState, result: TurnResult): Promise<void> {
    const conversation = this.conversation;
    if (!conversation) return;
    const opts = this.taskOpts(task);
    const calls = [...task.calls.values().flatMap((revisions) => revisions)];
    const actions = classifyActions(calls, task.interrupted);
    const unknown = actions.some((action) => action.status === "unknown");
    const { status, error } = classifyTask({ interrupted: task.interrupted, result, unknown });
    // Read before the transaction: retaining evidence is best-effort, recording that the task finished is not.
    const transcript = readRuntimeFile(result.streamLogPath);
    const hookEvidence = readHookEvidence(result.hookEvidencePath);
    const { records: hooks, malformedLines, readError } = hookEvidence;
    const efforts = effortLevels(hooks);
    try {
      this.tx(() => {
        const { writer } = this.deps;
        for (const action of actions)
          writer.updateToolCall(action.tool_call_id, {
            status: action.status,
            detail: action.detail,
          });
        // Every approval the records still hold pending, not only the ones in memory: an abandonment whose
        // commit failed left memory without its approval and the catalog with a pending row.
        const stillPending = this.deps.catalog.all<{ id: string }>(
          "SELECT a.id FROM approvals a JOIN tool_calls t ON t.id = a.tool_call_id WHERE t.task_id = ? AND a.status = 'pending'",
          task.id,
        );
        for (const approval of stillPending)
          writer.updateApproval(approval.id, { status: "expired", reason: "task ended" });
        if (transcript.status !== "absent")
          this.retainEvidence(task, {
            kind: "runtime_transcript",
            name: `turn-${conversation.turnCount}.stream.jsonl`,
            relation: "runtime_transcript",
            originalPath: result.streamLogPath,
            content: transcript,
          });
        if (hooks.length > 0)
          this.retainEvidence(task, {
            kind: "effort_evidence",
            name: `turn-${conversation.turnCount}.hooks.jsonl`,
            relation: "task_output",
            originalPath: null,
            content: {
              status: "read",
              bytes: Buffer.from(hooks.map((hook) => JSON.stringify(hook)).join("\n") + "\n"),
            },
          });
        writer.updateExecution(task.executionId, {
          status: executionStatusFor(task.interrupted, result),
          endedAt: nowIso(),
          reportedModel: task.reportedModel,
          reportedEffort: efforts.length === 1 ? (efforts[0] ?? null) : null,
          effortEvidence: {
            source: "PreToolUse hook",
            values: efforts,
            samples: hooks.length,
            malformed_lines: malformedLines,
            read_error: readError,
            note: effortNote(hookEvidence),
          },
        });
        if (task.interrupted)
          this.emit(
            {
              type: "interruption_outcome",
              payload: {
                conversation_id: conversation.id,
                task_id: task.id,
                task_status: status,
                actions,
                runtime_cancellation: result.runtimeCancellation,
              },
            },
            opts,
          );
        writer.updateTask(task.id, { status, finishedAt: nowIso() });
        this.emit(
          {
            type: "task_finished",
            payload: {
              conversation_id: conversation.id,
              task_id: task.id,
              status,
              ...(error ? { error } : {}),
              usage: result.summary?.usage ?? undefined,
            },
          },
          opts,
        );
        if (error)
          this.emit(
            {
              type: "error",
              payload: {
                code: "runtime_failure",
                message: error,
                conversation_id: conversation.id,
                task_id: task.id,
              },
            },
            opts,
          );
        const finalStatus = new Map(actions.map((action) => [action.tool_call_id, action.status]));
        this.onCommit(() => {
          for (const call of calls) call.status = finalStatus.get(call.id) ?? call.status;
          task.pendingApprovals.clear();
          task.status = status;
        });
      });
    } catch (recordError) {
      this.deps.log(`finishTurn record failure: ${String(recordError)}`);
    }
    // Set even when the records failed: the note is how the next turn learns what may have happened.
    const note = noteAfterTurn({
      interrupted: task.interrupted,
      actions,
      abandoned: task.abandoned,
    });
    if (note) conversation.pendingNote = note;
  }

  /** Retain one piece of a finished turn's evidence, linked to its task (inside tx), best-effort. */
  private retainEvidence(task: TaskState, evidence: TurnEvidence): void {
    const capture = match(evidence.content)
      .with({ status: "read" }, ({ bytes }): Capture => ({ status: "retained", bytes }))
      .with({ status: "unreadable" }, ({ reason }): Capture => ({
        status: "failed",
        reason: `unreadable: ${reason}`,
      }))
      .exhaustive();
    this.retainBestEffort(evidence.name, capture, (attempt) =>
      this.registerEvidence(task, evidence, attempt),
    );
  }

  /**
   * Register a capture (inside tx) so that retaining it is best-effort and the records committed with it are
   * not. The attempt runs in a savepoint: bytes that cannot be stored leave a failed capture that says why,
   * and if even that cannot be recorded the loss is logged. A savepoint undoes rows only, so register must
   * queue no state change or effect.
   */
  private retainBestEffort(
    name: string,
    capture: Capture,
    register: (capture: Capture) => void,
  ): void {
    const { catalog } = this.deps;
    const first = catalog.savepoint(() => register(capture));
    if (first.ok) return;
    const reason = `not retained: ${errorMessage(first.error)}`;
    const fallback = catalog.savepoint(() => register({ status: "failed", reason }));
    if (!fallback.ok)
      this.deps.log(`${name} lost, ${reason}; not recorded: ${errorMessage(fallback.error)}`);
  }

  private registerEvidence(task: TaskState, evidence: TurnEvidence, capture: Capture): void {
    const { writer } = this.deps;
    const artifact = writer.registerArtifact({
      kind: evidence.kind,
      logicalName: evidence.name,
      mimeType: "application/x-ndjson",
      producerExecutionId: task.executionId,
      originalPath: evidence.originalPath,
      ...captureFields(capture),
    });
    writer.linkArtifact({
      conversationId: this.activeConversation.id,
      artifactId: artifact.artifactId,
      relation: evidence.relation,
      taskId: task.id,
    });
  }

  /**
   * Records a declared tool output whatever its capture status, best-effort, so a failed write cannot undo
   * the tool result and call update recorded with it.
   */
  private collectArtifacts(
    task: TaskState,
    call: ToolCallState,
    result: { content: unknown; eventId: string },
  ): void {
    const declared = extractDeclaredArtifact(result.content);
    if (!declared) return;
    const capture = collectArtifact(declared, this.deps.profile.runtime.outputDirectories);
    const output: DeclaredOutput = { task, call, declared, eventId: result.eventId };
    this.retainBestEffort(`tool output ${declared.path}`, capture, (attempt) =>
      this.registerToolOutput(output, attempt),
    );
  }

  /**
   * Only a retained tool output becomes a task output and gets an artifact_registered event. It runs in a
   * savepoint (retainBestEffort), so it writes rows only: `record`, never `emit` or a commit queue.
   */
  private registerToolOutput(output: DeclaredOutput, capture: Capture): void {
    const { task, call, declared, eventId } = output;
    const { writer } = this.deps;
    const conversationId = this.activeConversation.id;
    const art = writer.registerArtifact({
      kind: "tool_output",
      logicalName: declared.name ?? declared.path,
      mimeType: declared.mimeType ?? "application/octet-stream",
      producerExecutionId: task.executionId,
      producerEventId: eventId,
      originalPath: declared.path,
      externalLocator: capture.status === "retained" ? null : declared.path,
      ...captureFields(capture),
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
        { taskId: task.id, executionId: task.executionId, causedBy: eventId },
      );
    }
  }

  /**
   * Stop for good: refuse every later command, interrupt the active task exactly as interrupt_task does (the
   * gate closes, pending approvals are invalidated, the outcome is recorded), then wait for the task to
   * finish or for `turnWait` to abort. It never rejects. When the interruption cannot be recorded the
   * runtime is killed anyway, because a runtime left running outlives the server and can keep calling tools.
   * A task still running when `turnWait` aborts finishes, if ever, into a closed catalog and stays unrecorded.
   */
  async shutdown(turnWait: AbortSignal): Promise<void> {
    this.shuttingDown = true;
    const task = this.task;
    if (!task) return;
    const interruption = this.interrupt(task);
    if (!interruption.ok) {
      this.deps.log(`shutdown: ${interruption.message}; killing the runtime anyway`);
      task.handle
        ?.interrupt()
        .catch((error: unknown) => this.deps.log(`interrupt failed: ${errorMessage(error)}`));
    }
    const timedOut = Promise.withResolvers<"timed_out">();
    const onAbort = () => timedOut.resolve("timed_out");
    if (turnWait.aborted) onAbort();
    else turnWait.addEventListener("abort", onAbort, { once: true });
    const outcome = await Promise.race([
      task.finished.then(() => "finished" as const),
      timedOut.promise,
    ]).finally(() => turnWait.removeEventListener("abort", onAbort));
    if (outcome === "timed_out")
      this.deps.log(`shutdown: task ${task.id} did not finish in time; its outcome is unrecorded`);
  }
}
