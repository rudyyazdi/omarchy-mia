import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { match } from "ts-pattern";
import {
  policyFor,
  hookEvidenceFrom,
  type HookEvidence,
  type RuntimeFileRead,
  type RuntimeFileReader,
  type RuntimeEvent,
  type PermissionDecision,
  type PermissionRequest,
  type Profile,
  type TurnHandle,
  type TurnOptions,
  type TurnResult,
} from "@mia/agent-adapter";
import { Holds } from "@mia/kernel";
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
import {
  type ArtifactKind,
  type Catalog,
  type NewId,
  type JournalEventType,
  type LinkRelation,
  type RecordWriter,
  type StoredObject,
} from "@mia/records";
import {
  captureFields,
  extractDeclaredArtifact,
  type Capture,
  type DeclaredArtifact,
  type Retention,
} from "./artifact-capture.ts";
import type { ArtifactCollector } from "./artifact-collector.ts";
import {
  linkConversationProvenance,
  planConversationProvenance,
  readConversationFiles,
  recordConversationProvenance,
  storeProvenance,
  type ProvenancePlan,
  type ServerIdentity,
} from "./provenance.ts";
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

/**
 * How many permission prompts the server holds open at once, across tasks, waiting for the user's decision. A
 * call that would ask beyond it is denied without asking (evaluatePermission), so no approval is recorded that
 * cannot be held. Far above what one turn asks in parallel; it bounds a runtime that keeps asking.
 */
export const MAX_HELD_PROMPTS = 32;

/** The answer to a prompt still held once its turn has ended, recorded or not: the runtime is gone, and nothing was released. */
const TURN_ENDED: PermissionDecision = {
  behavior: "deny",
  message: "Mia: the turn ended before the user decided; this call was not released.",
};

/**
 * What a recorded permission request answers the runtime: at once, or by holding its prompt, under the approval
 * the request recorded, until the user decides.
 */
type PermissionAnswer =
  { kind: "answer"; decision: PermissionDecision } | { kind: "hold"; approvalId: string };

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
}

interface TaskState {
  id: string;
  executionId: string;
  epoch: number;
  status: TaskStatus;
  gateOpen: boolean;
  interrupted: boolean;
  /**
   * The runtime's turn has ended and finishTurn is recording it. Memory only: the task stays running in the
   * records until finishTurn commits, but nothing can be released to or interrupted in a runtime that is gone.
   */
  runtimeEnded: boolean;
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
  /**
   * The retained agent prompt object every turn of this conversation appends; null when the prompt file was missing
   * at start, so provenance recorded it unavailable and no turn appends one.
   */
  promptFile: string | null;
  turnCount: number;
  /**
   * A runtime has started this conversation's session, so the next turn resumes it instead of creating it. Set
   * when a turn's runtime_init commits, not from the turn count: a turn whose runtime never spawned (a failed
   * launch, or an interruption before spawn) leaves no session to resume. Keyed off the init event rather than
   * the spawn, so a runtime that exits before its init (rejecting its arguments or settings) leaves the session
   * to be created again; one that exits after init but before it persists the session still sets it. Only a
   * committed init sets it, as memory follows the records: if that commit fails, the next turn tries to create a
   * session that exists and fails, and the turn after resumes once its init commits.
   */
  sessionStarted: boolean;
  epoch: number;
  /** Mia-authored note carried into the next runtime turn after an interruption or unknown outcome. */
  pendingNote: string | null;
}

export interface EngineDeps {
  profile: Profile;
  catalog: Catalog;
  writer: RecordWriter;
  adapter: TurnRunner;
  /** Computed once at startup; every conversation's provenance records it. */
  identity: ServerIdentity;
  /**
   * A fresh deadline for one batch of evidence reads and stores: a finished turn's transcript and hook evidence, or
   * a starting conversation's prompt, architecture document and provenance snapshots. A turn-end read still
   * pending when it aborts is recorded unreadable, so a read that never returns cannot keep the task from
   * finishing; a store it interrupts is recorded not retained (an fsync already under way still completes). A
   * conversation start it interrupts is refused.
   */
  evidenceReadDeadline: () => AbortSignal;
  /**
   * Reads the transcript and the hook evidence at turn end, and the agent prompt and architecture document at
   * conversation start: `readRuntimeFile`, or a test's own.
   */
  readEvidence: RuntimeFileReader;
  /** Captures a tool output a completed call declared: `collectArtifact`, or a test's own. */
  collectArtifact: ArtifactCollector;
  /**
   * Names the conversations, tasks, executions, tool calls, approvals, events, provenance sets and entries, artifacts,
   * artifact links and diagnostics the engine records (see RecordWriter), and every event it sends: `newId`. Injected
   * randomness, so a transition's ids are chosen before its records are written and can refer to each other.
   */
  newId: NewId;
  /**
   * The clock. Each transaction reads it once, and every row it writes carries that time; a heartbeat's diagnostics
   * row, written outside any transaction, reads it too, and so does each event sent, for its `server_time`.
   */
  now: () => Date;
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

/** An artifact a finished turn retains for its task, with the object its bytes were stored as or why they were not. */
interface TurnEvidence {
  kind: ArtifactKind;
  name: string;
  relation: Extract<LinkRelation, "runtime_transcript" | "task_output">;
  originalPath: string | null;
  retention: Retention;
}

/** A tool output a tool result declared, and what reading and storing it produced. */
interface CapturedOutput {
  declared: DeclaredArtifact;
  retention: Retention;
}

/** What a turn-end read gives to retain: the bytes read, or why they could not be. */
const evidenceCapture = (content: Exclude<RuntimeFileRead, { status: "absent" }>): Capture =>
  match(content)
    .with({ status: "read" }, ({ bytes }): Capture => ({ status: "retained", bytes }))
    .with({ status: "unreadable" }, ({ reason }): Capture => ({
      status: "failed",
      reason: `unreadable: ${reason}`,
    }))
    .exhaustive();

/** A tool output a completed call declared, and the tool_result event that declared it. */
interface DeclaredOutput {
  task: TaskState;
  call: ToolCallState;
  declared: DeclaredArtifact;
  eventId: string;
}

/**
 * The one conversation start awaiting its reads and stores. Shutdown abandons its I/O and refuses it. A disconnect
 * of the connection that asked does not: the start still commits, with no active connection, so the client's
 * resend of the same message_id on a new connection gets the start's reply and adopts the conversation.
 */
interface PendingStart {
  connectionId: string;
  disconnected: boolean;
  abandon: AbortController;
}

/** The answer to a start whose I/O shutdown abandoned, or null while it was not. */
const abandonedStart = (pending: PendingStart): CommandResult | null =>
  pending.abandon.signal.aborted
    ? fail(
        "invalid_state",
        `conversation start abandoned: ${errorMessage(pending.abandon.signal.reason)}`,
      )
    : null;

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
  /**
   * Aborted when shutdown stops waiting: a turn-end evidence read still pending is abandoned so the turn is
   * recorded before the catalog closes. Not at the start of shutdown, so a turn it kills keeps its evidence.
   */
  private readonly stopping = new AbortController();
  /**
   * The conversation start awaiting its I/O, if any. One at a time: a second start is refused as busy meanwhile,
   * so at most one command holds the gateway's reply across an await.
   */
  private starting: PendingStart | null = null;
  /** What the transaction in progress will apply and perform once it commits. */
  private queued: CommitQueue = emptyQueue();
  /**
   * The runtime's permission prompts waiting for the user's decision, keyed by approval id. Each is answered once:
   * by `answerPrompt` after a commit, by its abandonment, or once its turn has ended (submitText).
   */
  private readonly prompts = new Holds<PermissionDecision>(MAX_HELD_PROMPTS);
  /**
   * When the transaction in progress was decided, or null outside one. One reading per transaction, as a kernel
   * dispatch hands its `decide` one `now`, so the transition rows of one commit (see `EngineDeps.now`) agree on when
   * it happened.
   */
  private transactionTime: string | null = null;

  constructor(private readonly deps: EngineDeps) {}

  /** The time the rows of the transaction in progress record (inside tx). */
  private get recordedAt(): string {
    if (this.transactionTime === null) throw new Error("engine records only inside a transaction");
    return this.transactionTime;
  }

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
    this.transactionTime = this.deps.now().toISOString();
    try {
      result = this.deps.catalog.transaction(records);
    } catch (error) {
      this.queued = emptyQueue();
      throw error;
    } finally {
      this.transactionTime = null;
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
      server_time: this.deps.now().toISOString(),
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
    type: JournalEventType,
    payload: unknown,
    opts: EventOpts = {},
  ): { id: string; sequence: number } {
    const appended = this.deps.writer.appendEvent({
      id: this.deps.newId("evt"),
      receivedAt: this.recordedAt,
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
      { id: this.deps.newId("evt"), sequence: null },
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

  /**
   * Run one validated client command; once shutdown has begun, every command is refused unrun. Every command but
   * start_conversation decides and commits before this returns; a start awaits its reads and stores first, so the
   * gateway answers other connections meanwhile.
   */
  async handle(ctx: CommandContext, command: ClientCommand): Promise<CommandResult> {
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

  /**
   * Why a conversation cannot start for `ctx` now, or null; checked again once the start's I/O has settled. A start
   * whose connection has closed (`disconnected`) yields only to another client: its own client may already have
   * reconnected and adopted the conversation, to resend this very start.
   */
  private refuseStart(ctx: CommandContext, disconnected = false): CommandResult | null {
    if (this.shuttingDown) return fail("invalid_state", "the server is shutting down");
    if (this.task)
      return fail(
        "busy",
        "a task is running; interrupt it or wait before starting a new conversation",
      );
    if (
      this.conversation &&
      this.activeConnectionId &&
      this.activeConnectionId !== ctx.connectionId &&
      !(disconnected && this.activeClientId === ctx.clientId)
    ) {
      return fail("busy", "another client owns the active conversation");
    }
    return null;
  }

  /**
   * Reads the conversation's files and stores its provenance snapshots before the transaction opens, then
   * re-checks the guards, because a task, another client or shutdown may have arrived while it awaited.
   */
  async startConversation(ctx: CommandContext): Promise<CommandResult> {
    const refused = this.refuseStart(ctx);
    if (refused) return refused;
    if (this.starting) return fail("busy", "another conversation is starting");
    const pending: PendingStart = {
      connectionId: ctx.connectionId,
      disconnected: false,
      abandon: new AbortController(),
    };
    this.starting = pending;
    try {
      const signal = AbortSignal.any([pending.abandon.signal, this.deps.evidenceReadDeadline()]);
      let plan: ProvenancePlan<StoredObject>;
      try {
        const files = await readConversationFiles({
          profile: this.deps.profile,
          read: this.deps.readEvidence,
          signal,
        });
        plan = await storeProvenance(
          planConversationProvenance({
            profile: this.deps.profile,
            clientBuild: ctx.clientBuild,
            identity: this.deps.identity,
            files,
          }),
          { objects: this.deps.writer.objects, signal },
        );
      } catch (error) {
        return (
          abandonedStart(pending) ??
          fail("record_failure", `could not create conversation: ${errorMessage(error)}`)
        );
      }
      return (
        abandonedStart(pending) ??
        this.refuseStart(ctx, pending.disconnected) ??
        this.commitStart({ ctx, plan, connected: !pending.disconnected })
      );
    } finally {
      this.starting = null;
    }
  }

  /**
   * Records a conversation whose provenance is stored, and makes it the active one. When the connection that asked
   * has closed meanwhile (`connected` false), the conversation belongs to its client, through the connection that
   * client has adopted since, or none, as `onDisconnect` would have left it.
   */
  private commitStart(input: {
    ctx: CommandContext;
    plan: ProvenancePlan<StoredObject>;
    connected: boolean;
  }): CommandResult {
    const { ctx, plan, connected } = input;
    const { writer } = this.deps;
    const previous = {
      conversation: this.conversation,
      connection: this.activeConnectionId,
      client: this.activeClientId,
    };
    try {
      // Unlike task transitions, this sets state inside the transaction, because `record` reads the active
      // conversation; the catch below restores it.
      return this.tx(() => {
        const startedAt = this.recordedAt;
        const provenance = recordConversationProvenance(writer, plan, {
          newId: this.deps.newId,
          createdAt: startedAt,
        });
        const runtimeConversationId = randomUUID();
        const conversationId = this.deps.newId("conv");
        const conv = writer.createConversation({
          id: conversationId,
          startedAt,
          provenanceSetId: provenance.provenance_set_id,
          runtimeConversationId,
        });
        linkConversationProvenance(writer, { conversationId, provenance }, this.deps.newId);
        if (previous.conversation)
          writer.updateConversation(previous.conversation.id, { status: "closed" });
        // Every turn of this conversation appends the prompt bytes recorded in provenance: the runtime reads the
        // retained object itself, so no second read of the prompt file or copy of it can drift from the record.
        const promptFile =
          provenance.agent_prompt_digest === null
            ? null
            : writer.objects.pathFor(provenance.agent_prompt_digest);
        this.conversation = {
          id: conversationId,
          runtimeConversationId,
          provenanceSetId: provenance.provenance_set_id,
          directory: conv.directory,
          promptFile,
          turnCount: 0,
          sessionStarted: false,
          epoch: 0,
          pendingNote: null,
        };
        // Disconnected, the active connection is none or one of this client's (refuseStart), so it stays.
        if (connected) this.activeConnectionId = ctx.connectionId;
        this.activeClientId = ctx.clientId;
        this.record("provenance_recorded", provenance);
        this.emit({
          type: "conversation_started",
          payload: {
            conversation_id: conversationId,
            started_at: startedAt,
            provenance_set_id: provenance.provenance_set_id,
          },
        });
        return {
          ok: true,
          result: {
            conversation_id: conversationId,
            provenance_set_id: provenance.provenance_set_id,
          },
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
    const taskId = this.deps.newId("task");
    const executionId = this.deps.newId("exec");
    try {
      this.tx(() => {
        writer.createTask({
          id: taskId,
          createdAt: this.recordedAt,
          conversationId: conversation.id,
          text: payload.text,
          clientId: ctx.clientId,
        });
        writer.createExecution({
          id: executionId,
          startedAt: this.recordedAt,
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
      });
    } catch (error) {
      return fail("record_failure", `could not record task: ${errorMessage(error)}`);
    }
    conversation.epoch = epoch;
    conversation.turnCount = turnIndex;
    conversation.pendingNote = null;
    const finished: PromiseWithResolvers<void> = Promise.withResolvers();
    const task: TaskState = {
      id: taskId,
      executionId,
      epoch,
      status: "running",
      gateOpen: true,
      interrupted: false,
      runtimeEnded: false,
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
      firstTurn: !conversation.sessionStarted,
      // The launch creates this directory and the conversation directory above it, owner-only, on the first turn.
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
        // However finishTurn ended, even by throwing: the runtime has ended, so a prompt it never abandoned is
        // answered with a denial rather than left holding a place under MAX_HELD_PROMPTS. One already answered is
        // skipped.
        for (const revisions of task.calls.values())
          for (const call of revisions) this.answerPrompt(call, TURN_ENDED);
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
          consumedAt: this.recordedAt,
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
      runtimeEnded: task.runtimeEnded,
      conversationEpoch: this.activeConversation.epoch,
      pending: [...task.pendingApprovals].map(([approvalId, call]) => ({ approvalId, call })),
    });
    return match(outcome)
      .with({ kind: "already_interrupting" }, (): CommandResult => ({
        ok: true,
        result: { already_interrupting: true },
      }))
      .with({ kind: "runtime_ended" }, (): CommandResult => ({
        ok: true,
        result: { runtime_ended: true },
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
          id: this.deps.newId("diag"),
          receivedAt: this.recordedAt,
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
    payload: Extract<ClientCommand, { type: "heartbeat" }>["payload"],
  ): CommandResult {
    try {
      this.deps.writer.touchConnection(ctx.connectionId);
      const conversationId =
        payload.conversation_id && this.conversation?.id === payload.conversation_id
          ? payload.conversation_id
          : null;
      this.deps.writer.recordDiagnostics({
        id: this.deps.newId("diag"),
        receivedAt: this.deps.now().toISOString(),
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
    if (this.starting?.connectionId === connectionId) this.starting.disconnected = true;
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

  /**
   * Answer the prompt held for `call`'s approval, if one is still held. None is when the call never asked, or its
   * prompt was already answered: abandoned by the runtime, or denied once its turn ended. The
   * runtime then already has a denial, and this answer is dropped.
   */
  private answerPrompt(call: ToolCallState, decision: PermissionDecision): void {
    if (call.approvalId !== null) this.prompts.reply(call.approvalId, decision);
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
      consumedAt: this.recordedAt,
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
      updatedAt: this.recordedAt,
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
      updatedAt: this.recordedAt,
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
    if (settle) this.afterCommit(() => this.answerPrompt(call, settle));
  }

  // ---------------------------------------------------------------- runtime events

  /**
   * Handles one runtime event; it never rejects. A tool result that declares an output file is captured and
   * stored first, outside the transaction, because the read and write can take long; every other event is
   * recorded before this returns.
   * A failed result never completes its call, so the file it declares is not read.
   * The adapter hands over the next stdout event only once this settles, so events still commit in the order the
   * runtime wrote them. The turn ends before the capture and store only when the adapter stops reading a runtime whose
   * interruption did not end it; the result is then dropped with a log line, because the turn has already been
   * recorded without it.
   */
  private async onRuntimeEvent(task: TaskState, event: RuntimeEvent): Promise<void> {
    const declared =
      event.type === "tool_result" && !event.isError
        ? extractDeclaredArtifact(event.content)
        : null;
    if (!declared) {
      this.recordRuntimeEvent(task, event, null);
      return;
    }
    const capture = await this.deps
      .collectArtifact(declared, this.deps.profile.runtime.outputDirectories)
      .catch((error: unknown): Capture => ({
        status: "failed",
        reason: `declared file unreadable: ${errorMessage(error)}`,
      }));
    const retention = await this.store(capture, this.stopping.signal);
    this.recordRuntimeEvent(task, event, { declared, retention });
  }

  /**
   * Stores a retained capture's bytes, before the transaction that registers them opens. Retaining is best-effort,
   * so bytes that cannot be stored before `signal` aborts become a failed capture that says why. Bytes whose
   * transaction then fails, or that it does not register (an event dropped because its runtime ended, a result
   * that completes no call), are left as an unreferenced object, never a row that points at unwritten bytes.
   */
  private async store(capture: Capture, signal: AbortSignal): Promise<Retention> {
    if (capture.status !== "retained") return capture;
    return this.deps.writer.objects.put(capture.bytes, { signal }).then(
      (stored): Retention => ({ status: "retained", stored }),
      (error: unknown): Retention => ({
        status: "failed",
        reason: `not retained: ${errorMessage(error)}`,
      }),
    );
  }

  /**
   * Records one runtime event, with the tool output its result declared already captured. An event handled after
   * the task's runtime ended is dropped: the runtime hands over its exit before the turn ends, so only an event
   * left pending when a stuck runtime was abandoned gets here, and the turn was recorded without it.
   */
  private recordRuntimeEvent(
    task: TaskState,
    event: RuntimeEvent,
    output: CapturedOutput | null,
  ): void {
    if (task.runtimeEnded || this.task !== task) {
      const captured = output ? ` (output ${output.declared.path} captured)` : "";
      this.deps.log(
        `${event.type}${captured} for task ${task.id} handled after its runtime ended; not recorded`,
      );
      return;
    }
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
              conversation.sessionStarted = true;
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
              this.deps.writer.updateToolCall(binding.call.id, {
                updatedAt: this.recordedAt,
                proposalEventId: proposal.id,
              });
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
            this.deps.writer.updateToolCall(call.id, {
              updatedAt: this.recordedAt,
              status,
              resultEventId: result.id,
            });
            if (status === "completed" && output)
              this.retainToolOutput(
                { task, call, declared: output.declared, eventId: result.id },
                output.retention,
              );
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
    const id = this.deps.newId("call");
    this.deps.writer.createToolCall({
      id,
      createdAt: this.recordedAt,
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
      promptsFull: this.prompts.full,
    });
    let recorded: { call: ToolCallState; answer: PermissionAnswer };
    try {
      recorded = this.tx(() => {
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
        const answer = this.recordPermission({
          task,
          call: bound,
          rule,
          evaluationId: evaluation.id,
        });
        this.afterCommit(() => this.notifyToolCall(task, bound));
        return { call: bound, answer };
      });
    } catch (error) {
      // Nothing was requested, so nothing is held: the runtime is denied at once.
      this.deps.log(`permission handling failed: ${errorMessage(error)}`);
      return { behavior: "deny", message: "Mia could not record this call; it was not released." };
    }
    const { call, answer } = recorded;
    return match(answer)
      .with({ kind: "answer" }, ({ decision }) => decision)
      .with({ kind: "hold" }, ({ approvalId }) =>
        this.holdPrompt({ task, call, approvalId, abandoned: req.abandoned }),
      )
      .exhaustive();
  }

  /**
   * Hold the runtime's prompt for a call whose approval request has committed, until the user decides or the
   * runtime abandons it. Held only after the commit, so a request that could not be recorded is never held. A
   * prompt the runtime abandoned before this (a signal already aborted) is abandoned at once. The cap was checked
   * before the request was recorded and nothing ran since, so a refusal here is a bug; its approval is expired as
   * abandoned, so no decision can release a call whose runtime was denied.
   */
  private holdPrompt(input: {
    task: TaskState;
    call: ToolCallState;
    approvalId: string;
    abandoned: AbortSignal;
  }): Promise<PermissionDecision> {
    const { task, call, approvalId, abandoned } = input;
    const held = this.prompts.hold(approvalId, {
      signal: abandoned,
      onAbort: () => this.abandon(task, call),
    });
    return match(held)
      .with({ kind: "held" }, ({ reply }) => reply)
      .with({ kind: "refused" }, ({ refusal }) => {
        this.deps.log(`prompt for approval ${approvalId} could not be held (${refusal})`);
        return Promise.resolve(this.abandon(task, call));
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

  /** Record what the permission rule decided for a bound call, and what that answers the runtime (inside tx). */
  private recordPermission(input: {
    task: TaskState;
    call: ToolCallState;
    rule: PermissionRule;
    evaluationId: string;
  }): PermissionAnswer {
    const { task, call, rule, evaluationId } = input;
    const conversation = this.activeConversation;
    const opts = this.taskOpts(task);
    return match(rule)
      .with({ kind: "deny" }, (denial): PermissionAnswer => {
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
        const { message } = denial;
        return {
          kind: "answer",
          decision: denial.interrupt
            ? { behavior: "deny", message, interrupt: true }
            : { behavior: "deny", message },
        };
      })
      .with({ kind: "dispatch" }, (): PermissionAnswer => {
        this.recordDispatch(task, call, { via: "policy", causedBy: evaluationId });
        this.onCommit(() => {
          call.status = "dispatched";
        });
        return { kind: "answer", decision: { behavior: "allow" } };
      })
      .with({ kind: "ask" }, (): PermissionAnswer => {
        const approvalId = this.deps.newId("appr");
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
        // Durable pending approval bound to (conversation, task, runtime call, revision, tool, digest, epoch), and
        // to the event that asked for it: its id was chosen first, so the event could name it before it existed.
        this.deps.writer.createApproval({
          id: approvalId,
          requestedAt: this.recordedAt,
          toolCallId: call.id,
          executionEpoch: task.epoch,
          requestingEventId: requested.id,
        });
        this.deps.writer.updateToolCall(call.id, {
          updatedAt: this.recordedAt,
          status: "awaiting_approval",
        });
        this.onCommit(() => {
          call.status = "awaiting_approval";
          call.approvalId = approvalId;
          task.pendingApprovals.set(approvalId, call);
        });
        this.recordTaskStatus(task, "awaiting_approval");
        return { kind: "hold", approvalId };
      })
      .exhaustive();
  }

  /**
   * The runtime dropped the held prompt (process gone or turn aborted): the pending approval can never release
   * anything. Returns the runtime's answer; `prompts` calls this at most once per hold, and never after a reply.
   */
  private abandon(task: TaskState, call: ToolCallState): PermissionDecision {
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
    return settle;
  }

  // ---------------------------------------------------------------- turn completion

  private async finishTurn(task: TaskState, result: TurnResult): Promise<void> {
    // Before the reads below yield: a decision or interruption handled while they are awaited must not release
    // a call to, or record an interruption of, a runtime that already exited. An approval then ends blocked.
    task.runtimeEnded = true;
    task.gateOpen = false;
    // Read and store before the transaction: retaining evidence is best-effort, recording that the task finished
    // is not. Read and store before anything else is computed: a command handled while they are awaited (a
    // decision) changes the task, and the records must reflect it.
    const signal = AbortSignal.any([this.stopping.signal, this.deps.evidenceReadDeadline()]);
    const [transcript, hookRead] = await Promise.all([
      this.deps.readEvidence(result.streamLogPath, { signal }),
      this.deps.readEvidence(result.hookEvidencePath, { signal }),
    ]);
    const hookEvidence = hookEvidenceFrom(hookRead);
    const { records: hooks, malformedLines, readError } = hookEvidence;
    const [transcriptRetention, hookRetention] = await Promise.all([
      transcript.status === "absent" ? null : this.store(evidenceCapture(transcript), signal),
      hooks.length === 0
        ? null
        : this.store(
            {
              status: "retained",
              bytes: Buffer.from(hooks.map((hook) => JSON.stringify(hook)).join("\n") + "\n"),
            },
            signal,
          ),
    ]);
    const conversation = this.conversation;
    if (!conversation) return;
    const opts = this.taskOpts(task);
    const calls = [...task.calls.values().flatMap((revisions) => revisions)];
    const actions = classifyActions(calls, task.interrupted);
    const unknown = actions.some((action) => action.status === "unknown");
    const { status, error } = classifyTask({ interrupted: task.interrupted, result, unknown });
    const efforts = effortLevels(hooks);
    try {
      this.tx(() => {
        const { writer } = this.deps;
        for (const action of actions)
          writer.updateToolCall(action.tool_call_id, {
            updatedAt: this.recordedAt,
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
          writer.updateApproval(approval.id, {
            status: "expired",
            consumedAt: this.recordedAt,
            reason: "task ended",
          });
        if (transcriptRetention)
          this.retainEvidence(task, {
            kind: "runtime_transcript",
            name: `turn-${conversation.turnCount}.stream.jsonl`,
            relation: "runtime_transcript",
            originalPath: result.streamLogPath,
            retention: transcriptRetention,
          });
        if (hookRetention)
          this.retainEvidence(task, {
            kind: "effort_evidence",
            name: `turn-${conversation.turnCount}.hooks.jsonl`,
            relation: "task_output",
            originalPath: null,
            retention: hookRetention,
          });
        writer.updateExecution(task.executionId, {
          status: executionStatusFor(task.interrupted, result),
          endedAt: this.recordedAt,
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
        writer.updateTask(task.id, { status, finishedAt: this.recordedAt });
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
    this.retainBestEffort(evidence.name, evidence.retention, (attempt) =>
      this.registerEvidence(task, evidence, attempt),
    );
  }

  /**
   * Register a retention (inside tx) so that retaining it is best-effort and the records committed with it are
   * not. Its bytes are already stored (`store`). The attempt runs in a savepoint: rows that cannot be written
   * leave a failed capture that says why, and if even that cannot be recorded the loss is logged. A savepoint
   * undoes rows only, so register must queue no state change or effect.
   */
  private retainBestEffort(
    name: string,
    retention: Retention,
    register: (retention: Retention) => void,
  ): void {
    const { catalog } = this.deps;
    const first = catalog.savepoint(() => register(retention));
    if (first.ok) return;
    const reason = `not retained: ${errorMessage(first.error)}`;
    const fallback = catalog.savepoint(() => register({ status: "failed", reason }));
    if (!fallback.ok)
      this.deps.log(`${name} lost, ${reason}; not recorded: ${errorMessage(fallback.error)}`);
  }

  private registerEvidence(task: TaskState, evidence: TurnEvidence, retention: Retention): void {
    const { writer, newId } = this.deps;
    const artifactId = newId("art");
    writer.registerArtifact({
      id: artifactId,
      createdAt: this.recordedAt,
      kind: evidence.kind,
      logicalName: evidence.name,
      mimeType: "application/x-ndjson",
      producerExecutionId: task.executionId,
      originalPath: evidence.originalPath,
      ...captureFields(retention),
    });
    writer.linkArtifact({
      id: newId("link"),
      conversationId: this.activeConversation.id,
      artifactId,
      relation: evidence.relation,
      taskId: task.id,
    });
  }

  /**
   * Records a declared tool output whatever its capture status, best-effort, so a failed write cannot undo
   * the tool result and call update recorded with it.
   */
  private retainToolOutput(output: DeclaredOutput, retention: Retention): void {
    this.retainBestEffort(`tool output ${output.declared.path}`, retention, (attempt) =>
      this.registerToolOutput(output, attempt),
    );
  }

  /**
   * Only a retained tool output becomes a task output and gets an artifact_registered event. It runs in a
   * savepoint (retainBestEffort), so it writes rows only: `record`, never `emit` or a commit queue.
   */
  private registerToolOutput(output: DeclaredOutput, retention: Retention): void {
    const { task, call, declared, eventId } = output;
    const { writer, newId } = this.deps;
    const conversationId = this.activeConversation.id;
    const artifactId = newId("art");
    const art = writer.registerArtifact({
      id: artifactId,
      createdAt: this.recordedAt,
      kind: "tool_output",
      logicalName: declared.name ?? declared.path,
      mimeType: declared.mimeType ?? "application/octet-stream",
      producerExecutionId: task.executionId,
      producerEventId: eventId,
      originalPath: declared.path,
      externalLocator: retention.status === "retained" ? null : declared.path,
      ...captureFields(retention),
    });
    writer.linkArtifact({
      id: newId("link"),
      conversationId,
      artifactId,
      relation: "tool_result",
      toolCallId: call.id,
      taskId: task.id,
    });
    if (retention.status === "retained") {
      writer.linkArtifact({
        id: newId("link"),
        conversationId,
        artifactId,
        relation: "task_output",
        taskId: task.id,
      });
      this.record(
        "artifact_registered",
        {
          artifact_id: artifactId,
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
   * When `turnWait` aborts, a turn whose runtime has ended but whose evidence is still being read or stored is
   * recorded without the evidence still pending (recording is then synchronous, so the wait for it is bounded). A task
   * whose runtime is still running then finishes, if ever, into a closed catalog and stays unrecorded.
   */
  async shutdown(turnWait: AbortSignal): Promise<void> {
    this.shuttingDown = true;
    this.starting?.abandon.abort(new Error("the server is shutting down"));
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
    const onAbort = () => {
      this.stopping.abort(new Error("abandoned at shutdown"));
      timedOut.resolve("timed_out");
    };
    if (turnWait.aborted) onAbort();
    else turnWait.addEventListener("abort", onAbort, { once: true });
    const outcome = await Promise.race([
      task.finished.then(() => "finished" as const),
      timedOut.promise,
    ]).finally(() => turnWait.removeEventListener("abort", onAbort));
    if (outcome === "finished") return;
    if (task.runtimeEnded) await task.finished;
    else
      this.deps.log(`shutdown: task ${task.id} did not finish in time; its outcome is unrecorded`);
  }
}
