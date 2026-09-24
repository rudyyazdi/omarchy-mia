import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { match } from "ts-pattern";
import {
  bodyLogFor,
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
  errorMessage,
  type ApprovalStatus,
  type ClientCommand,
  type ClientDiagnostics,
  type Decision,
  type ErrorCode,
  type ServerEvent,
} from "@mia/protocol";
import {
  type ArtifactKind,
  type Catalog,
  type IdPrefix,
  type NewId,
  type LinkRelation,
  type RecordWriter,
  type StoredObject,
  mcpPayload,
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
  callById,
  callsOf,
  withCallStatuses,
  withTask,
  type CallState,
  type ConversationState,
  type TaskState,
} from "./conversation-state.ts";
import {
  MAX_BODY_LOG_BYTES,
  MCP_BODY_EVENT,
  mcpBodiesFrom,
  unrecordedBodies,
  type BodyReadPoint,
  type McpBody,
  type McpBodyRecord,
} from "./mcp-bodies.ts";
import {
  abandonmentTransition,
  approvalDecisionTransition,
  interruptionTransition,
  permissionRefusedTransition,
  permissionRequestTransition,
  releasedBy,
  runtimeEventTransition,
  type CapturedOutput,
  type ConversationDecision,
  type ConversationTransition,
  type OutputIds,
  type RuntimeEventReads,
} from "./decide-conversation.ts";
import type { EngineEffect, OutgoingEvent, PermissionAnswer } from "./engine-effects.ts";
import { commitRecords, eventSequence, type CommittedChange } from "./engine-records.ts";
import {
  nameProvenance,
  planConversationProvenance,
  provenanceLinks,
  provenanceRecords,
  readConversationFiles,
  storeProvenance,
  type ProvenancePlan,
  type ServerIdentity,
} from "./provenance.ts";
import {
  TransitionDraft,
  taskLinks,
  type BuiltTransition,
  type Origin,
} from "./transition-draft.ts";
import {
  abandonedPromptDenial,
  bindToolResult,
  classifyActions,
  classifyTask,
  executionStatusFor,
  isReleased,
  noteAfterTurn,
  releasedWithoutResult,
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

/** The answer to a task-scoped command naming a task that is not the active one. */
const notActiveTask = (taskId: string): CommandResult =>
  fail("not_found", `task ${taskId} is not the active task`);

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

/** The answer to a permission request of a task that is no longer the active one. */
const NO_ACTIVE_TASK: PermissionDecision = {
  behavior: "deny",
  message: "Mia has no active task for this call.",
};

/** The answer to a permission request whose records did not commit: nothing was requested, held or released. */
const NOT_RECORDED: PermissionDecision = {
  behavior: "deny",
  message: "Mia could not record this call; it was not released.",
};

/** The permission request being committed, and the answer its `answer_permission` effect gave, once performed. */
interface Asking {
  answer: PermissionAnswer | null;
}

/**
 * What a task-scoped command is allowed to act on. `rejected` and `no_active_task` carry the answer
 * to send back, so a caller that has nothing to add returns it unread; `approvalDecision` looks a
 * resolved approval up before falling back to it.
 */
type AddressedTask =
  | { kind: "active"; task: TaskState }
  | { kind: "rejected"; result: CommandResult }
  | { kind: "no_active_task"; result: CommandResult };

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
   * Reads the transcript and the hook evidence at turn end, the agent prompt and architecture document at
   * conversation start, and in debug mode a body log at a tool result or turn end: `readRuntimeFile`, or a test's own.
   */
  readEvidence: RuntimeFileReader;
  /** Captures a tool output a completed call declared: `collectArtifact`, or a test's own. */
  collectArtifact: ArtifactCollector;
  /**
   * Names the conversations, tasks, executions, tool calls, approvals, events, provenance sets and entries, artifacts,
   * artifact links and diagnostics the engine records (see RecordWriter), and every event it sends: `newId`. Injected
   * randomness, so a transition's ids are chosen before its records are written and can refer to each other. A
   * transition draws every id it may record before its transaction opens, as a kernel dispatch will hand a pure
   * `decide` its ids with the event; one whose outcome records fewer leaves the rest unused.
   */
  newId: NewId;
  /**
   * The clock. Each transaction reads it once, and every row it writes carries that time; a heartbeat's diagnostics
   * row, written outside any transaction, reads it too, and so does each event sent, for its `server_time`.
   */
  now: () => Date;
  /**
   * Debug mode, chosen once per server start: each conversation started while it is on records a
   * `captured_in_debug_mode` event, so a viewer can tell detail that was never captured from detail that is absent,
   * and records the MCP request and response bodies of each call to a server that writes a body log. Off records
   * exactly what the engine records without it.
   */
  debugMode: boolean;
  log: (message: string) => void;
}

const RUNTIME_IDENTITY = "claude-code";

/** The ids of the rows that register one artifact and link it to its task. */
interface ArtifactIds {
  artifact: string;
  link: string;
}

/** An artifact a finished turn retains for its task, with the object its bytes were stored as or why they were not. */
interface TurnEvidence {
  ids: ArtifactIds;
  kind: ArtifactKind;
  name: string;
  relation: Extract<LinkRelation, "runtime_transcript" | "task_output">;
  originalPath: string | null;
  retention: Retention;
}

/** The MCP messages turn end records for a released call whose tool result never arrived. */
interface UnresultedBodies {
  call: CallState;
  bodies: McpBodyRecord[];
}

/** What a runtime event read before it is decided: only a tool result reads anything. */
type ResultReads = Pick<RuntimeEventReads, "output" | "bodies">;

const NOTHING_READ: ResultReads = { output: null, bodies: null };

/** What a turn-end read gives to retain: the bytes read, or why they could not be. */
const evidenceCapture = (content: Exclude<RuntimeFileRead, { status: "absent" }>): Capture =>
  match(content)
    .with({ status: "read" }, ({ bytes }): Capture => ({ status: "retained", bytes }))
    .with({ status: "unreadable" }, ({ reason }): Capture => ({
      status: "failed",
      reason: `unreadable: ${reason}`,
    }))
    .exhaustive();

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

/**
 * The runtime running the active task's turn: resources the engine owns, not state (see ConversationState). Set once
 * the adapter has started the turn, and cleared with the task once its end is recorded.
 */
interface ActiveTurn {
  taskId: string;
  handle: TurnHandle;
  /** Settles once the turn's end has been recorded (or failed to be) and the task cleared. */
  finished: Promise<void>;
}

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

/**
 * Conversation/task coordinator plus approval and interruption controller. One conversation, one task,
 * one active client. The rules live in ./transitions.ts, and ./decide-conversation.ts composes them into pure
 * transitions for how an approval ends, the runtime's permission requests and the events it reports; the engine
 * commits what they decide, replaces its state with the next one only after the commit, then performs the effects
 * (see `commit`). The transitions not yet in that machine it builds itself, through the same draft (see `tx`).
 */
export class Engine {
  activeConnectionId: string | null = null;
  activeClientId: string | null = null;
  /**
   * The active conversation's state, replaced whole by the next state a transaction built once its records commit
   * (see ConversationState), and never mutated. The few memory-only changes, which record nothing, replace it too.
   */
  private current: ConversationState | null = null;
  /** The runtime running the active task's turn, if one has started (see ActiveTurn). */
  private running: ActiveTurn | null = null;
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
  /**
   * The transition the engine is building (see `tx`), or null outside one. Its time is read once, as a kernel
   * dispatch hands its `decide` one `now`, so the transition rows of one commit (see `EngineDeps.now`) agree on when
   * it happened.
   */
  private open: TransitionDraft | null = null;
  /**
   * The runtime's permission prompts waiting for the user's decision, keyed by approval id. Each is answered once:
   * by an `answer_prompt` effect after a commit, by its abandonment, or once its turn has ended (submitText).
   */
  private readonly prompts = new Holds<PermissionDecision>(MAX_HELD_PROMPTS);
  /**
   * The permission request `handlePermission` is committing, or null outside that commit. The request's
   * `answer_permission` effect writes its answer here; the commit is synchronous, so at most one is ever set.
   */
  private asking: Asking | null = null;

  constructor(private readonly deps: EngineDeps) {}

  /** The active conversation's state as it is now (see `current`); null before the first start. */
  get conversation(): ConversationState | null {
    return this.current;
  }

  /** The runtime running the active task's turn, if any. */
  get turn(): ActiveTurn | null {
    return this.running;
  }

  /** The active task, if there is one. */
  private get task(): TaskState | null {
    return this.current?.task ?? null;
  }

  /** The active task if it is still the one `taskId` names: a callback of a task that has ended gets null. */
  private taskOf(taskId: string): TaskState | null {
    const task = this.task;
    return task?.id === taskId ? task : null;
  }

  /** The transition in progress (inside tx). */
  private get transition(): TransitionDraft {
    if (this.open === null) throw new Error("engine records only inside a transaction");
    return this.open;
  }

  /** The client and connection a transition decided now records its events under. */
  private get origin(): Origin {
    return { clientId: this.activeClientId, connectionId: this.activeConnectionId };
  }

  /**
   * Draws a fresh id (see `EngineDeps.newId`). Only outside a transaction: a transition draws every id it records
   * before its transaction opens and hands them in, as a kernel dispatch will hand a pure `decide` its ids with the
   * event, so a draw inside one is a bug and throws, which fails that commit.
   */
  private newId(prefix: IdPrefix): string {
    if (this.open !== null)
      throw new Error("ids are drawn before a transaction opens, never inside one");
    return this.deps.newId(prefix);
  }

  /** The conversation every guarded command and runtime callback operates on; callers check for one first. */
  private get activeConversation(): ConversationState {
    if (!this.current) throw new Error("engine has no active conversation");
    return this.current;
  }

  // ---------------------------------------------------------------- event plumbing

  /**
   * Run one transition the engine builds itself: `build` queues its records without touching the catalog and moves
   * the draft state (see `TransitionDraft`), then `commit` commits what it built. A build that throws commits
   * nothing, keeps the state it started from and performs no queued effect.
   */
  private tx<T>(build: () => T): T {
    // A transition inside another would commit the outer one's half-built records.
    if (this.open !== null) throw new Error("transitions do not nest");
    const draft = new TransitionDraft({
      state: this.current,
      now: this.deps.now(),
      origin: this.origin,
    });
    this.open = draft;
    let result: T;
    try {
      result = build();
    } finally {
      this.open = null;
    }
    this.commit(draft.built());
    return result;
  }

  /**
   * Decide one transition of the active conversation with the pure machine (see ./decide-conversation.ts), reading
   * the clock once for it; an accepted decision is committed with `commit`.
   */
  private decide<Event, Rejection>(
    transition: ConversationTransition<Event, Rejection>,
    event: Event,
  ): ConversationDecision<Rejection> {
    if (this.open !== null) throw new Error("transitions do not nest");
    return transition({ state: this.activeConversation, event, now: this.deps.now() });
  }

  /**
   * Commit what one transition built: `commitRecords` writes its records in one catalog transaction. A commit that
   * throws keeps the state it started from and performs no effect, so nothing is released or delivered. After a
   * commit the next state becomes the state, then each effect runs on its own: one that throws is logged as a
   * delivery failure, never reported as a persistence failure, and the records, the state, and the remaining effects
   * stand.
   */
  private commit(built: BuiltTransition): void {
    if (this.open !== null) throw new Error("transitions do not nest");
    const changes = commitRecords(this.deps.writer, built.records);
    this.current = built.next;
    for (const effect of built.effects) {
      try {
        this.perform(effect, changes);
      } catch (error) {
        this.deps.log(`delivery failed after commit; records stand: ${errorMessage(error)}`);
      }
    }
  }

  /**
   * Perform one effect of a committed transition, once its next state has replaced the engine's (see `commit`). It
   * reads the connection, the held prompts and the active turn as they are now, not as they were when the effect
   * was queued.
   */
  private perform(effect: EngineEffect, changes: readonly CommittedChange[]): void {
    match(effect)
      .with({ kind: "deliver_event" }, ({ eventId, event }) =>
        this.deliver(event, { id: eventId, sequence: eventSequence(changes, eventId) }),
      )
      .with({ kind: "notify_tool_call" }, ({ payload }) =>
        this.deliver({ type: "tool_call", payload }, { id: this.newId("evt"), sequence: null }),
      )
      .with({ kind: "answer_prompt" }, ({ approvalId, decision }) =>
        this.prompts.reply(approvalId, decision),
      )
      .with({ kind: "answer_permission" }, ({ answer }) => {
        if (!this.asking) throw new Error("no permission request is being committed");
        this.asking.answer = answer;
      })
      .with({ kind: "interrupt_runtime" }, ({ taskId }) => {
        const turn = this.running;
        if (turn?.taskId !== taskId) return;
        turn.handle
          .interrupt()
          .catch((error: unknown) => this.deps.log(`interrupt failed: ${String(error)}`));
      })
      .exhaustive();
  }

  private deliver(event: OutgoingEvent, envelope: { id: string; sequence: number | null }): void {
    const connectionId = this.activeConnectionId;
    if (!connectionId || !this.delivery) return;
    this.delivery(connectionId, {
      protocol_version: PROTOCOL_VERSION,
      message_id: envelope.id,
      conversation_id: this.current?.id ?? null,
      sequence: envelope.sequence,
      server_time: this.deps.now().toISOString(),
      ...event,
    });
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
    const ids = {
      provenance: nameProvenance(plan, (prefix) => this.newId(prefix)),
      conversation: this.newId("conv"),
      runtimeConversation: randomUUID(),
      provenanceRecorded: this.newId("evt"),
      started: this.newId("evt"),
      debugMode: this.newId("evt"),
    };
    const previous = {
      conversation: this.current,
      connection: this.activeConnectionId,
      client: this.activeClientId,
    };
    try {
      // Unlike the conversation, which moves with the draft, this sets the active connection and client before the
      // transition opens, because its events are recorded under them (`origin`); the catch below restores them if the
      // build or commit throws. Disconnected, the active connection is none or one of this client's (refuseStart), so
      // it stays.
      if (connected) this.activeConnectionId = ctx.connectionId;
      this.activeClientId = ctx.clientId;
      return this.tx(() => {
        const startedAt = this.transition.at;
        const { records: provenanceRows, summary: provenance } = provenanceRecords(
          ids.provenance,
          startedAt,
        );
        const runtimeConversationId = ids.runtimeConversation;
        const conversationId = ids.conversation;
        this.transition.write(...provenanceRows, {
          kind: "create_conversation",
          input: {
            id: conversationId,
            startedAt,
            provenanceSetId: provenance.provenance_set_id,
            runtimeConversationId,
          },
        });
        this.transition.write(...provenanceLinks({ conversationId, plan: ids.provenance }));
        if (previous.conversation)
          this.transition.write({
            kind: "update_conversation",
            id: previous.conversation.id,
            fields: { status: "closed" },
          });
        // Every turn of this conversation appends the prompt bytes recorded in provenance: the runtime reads the
        // retained object itself, so no second read of the prompt file or copy of it can drift from the record.
        const promptFile =
          provenance.agent_prompt_digest === null
            ? null
            : writer.objects.pathFor(provenance.agent_prompt_digest);
        this.transition.advance({
          id: conversationId,
          runtimeConversationId,
          provenanceSetId: provenance.provenance_set_id,
          directory: writer.conversationDirectory({ id: conversationId, startedAt }),
          promptFile,
          turnCount: 0,
          sessionStarted: false,
          epoch: 0,
          pendingNote: null,
          task: null,
        });
        this.transition.record("provenance_recorded", provenance, { id: ids.provenanceRecorded });
        this.transition.emit(
          {
            type: "conversation_started",
            payload: {
              conversation_id: conversationId,
              started_at: startedAt,
              provenance_set_id: provenance.provenance_set_id,
            },
          },
          { id: ids.started },
        );
        // After conversation_started, so that event keeps the sequence it has with debug mode off.
        if (this.deps.debugMode)
          this.transition.record("captured_in_debug_mode", {}, { id: ids.debugMode });
        return {
          ok: true,
          result: {
            conversation_id: conversationId,
            provenance_set_id: provenance.provenance_set_id,
          },
        };
      });
    } catch (error) {
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
    const { profile } = this.deps;
    const epoch = conversation.epoch + 1;
    const turnIndex = conversation.turnCount + 1;
    const note = conversation.pendingNote;
    const runtimePrompt = note ? `${note}\n\n${payload.text}` : payload.text;
    const taskId = this.newId("task");
    const executionId = this.newId("exec");
    const ids = { submitted: this.newId("evt"), started: this.newId("evt") };
    try {
      this.tx(() => {
        this.transition.write(
          {
            kind: "create_task",
            input: {
              id: taskId,
              createdAt: this.transition.at,
              conversationId: conversation.id,
              text: payload.text,
              clientId: ctx.clientId,
            },
          },
          {
            kind: "create_execution",
            input: {
              id: executionId,
              startedAt: this.transition.at,
              taskId,
              conversationId: conversation.id,
              runtimeIdentity: RUNTIME_IDENTITY,
              runtimeConversationId: conversation.runtimeConversationId,
              requestedModel: profile.runtime.model,
              requestedEffort: profile.runtime.effort,
              provenanceSetId: conversation.provenanceSetId,
              executionEpoch: epoch,
            },
          },
        );
        const opts = { taskId, executionId };
        this.transition.record(
          "task_submitted",
          {
            text: payload.text,
            runtime_prompt: runtimePrompt,
            mia_note: note,
            command_id: ctx.commandId,
          },
          { ...opts, id: ids.submitted },
        );
        this.transition.emit(
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
          { ...opts, id: ids.started },
        );
        this.transition.advance({
          ...this.transition.draft,
          epoch,
          turnCount: turnIndex,
          pendingNote: null,
          task: {
            id: taskId,
            executionId,
            epoch,
            status: "running",
            gateOpen: true,
            interrupted: false,
            runtimeEnded: false,
            calls: new Map(),
            pendingApprovals: new Map(),
            abandoned: [],
            clientId: ctx.clientId,
            reportedModel: null,
          },
        });
      });
    } catch (error) {
      return fail("record_failure", `could not record task: ${errorMessage(error)}`);
    }
    const finished: PromiseWithResolvers<void> = Promise.withResolvers();
    const handle = this.deps.adapter.submitTurn({
      text: runtimePrompt,
      runtimeConversationId: conversation.runtimeConversationId,
      firstTurn: !conversation.sessionStarted,
      // The launch creates this directory and the conversation directory above it, owner-only, on the first turn.
      runtimeDir: resolve(conversation.directory, "runtime"),
      turnIndex,
      agentPromptFile: conversation.promptFile,
      permissionHandler: (req) => this.handlePermission(taskId, req),
      onEvent: (event) => this.onRuntimeEvent(taskId, event),
    });
    this.running = { taskId, handle, finished: finished.promise };
    void handle.result
      .then((result) => this.finishTurn(taskId, result))
      .catch((error) =>
        this.deps.log(
          `finishTurn failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        ),
      )
      .finally(() => {
        // However finishTurn ended, even by throwing: the runtime has ended, so a prompt it never abandoned is
        // answered with a denial rather than left holding a place under MAX_HELD_PROMPTS. One already answered is
        // skipped.
        const task = this.taskOf(taskId);
        for (const call of task ? callsOf(task) : []) this.answerPrompt(call, TURN_ENDED);
        // Memory only, like the turn's end it follows: the task's end was recorded (or failed to be) by finishTurn.
        if (task && this.current) this.current = { ...this.current, task: null };
        if (this.running?.taskId === taskId) this.running = null;
        finished.resolve();
      });
    return {
      ok: true,
      result: { task_id: taskId, execution_id: executionId, execution_epoch: epoch },
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
    const approvalId = payload.approval_id;
    const decision = this.decide(approvalDecisionTransition, {
      kind: "approval_decision",
      origin: this.origin,
      taskId: task.id,
      approvalId,
      decision: payload.decision,
      deciderClientId: ctx.clientId,
      ids: { resolved: this.newId("evt"), dispatched: this.newId("evt") },
    });
    if (decision.kind === "rejected")
      return match(decision.rejection)
        .with({ kind: "no_task" }, () => notActiveTask(payload.task_id))
        .with({ kind: "not_owner" }, () =>
          fail("unauthenticated", "decision must come from the client that owns the task"),
        )
        .with({ kind: "not_pending" }, () => this.notPending(task, approvalId))
        .exhaustive();
    try {
      this.commit(decision);
    } catch (error) {
      // Record failure: the call stays held and pending; nothing is released.
      return fail(
        "record_failure",
        `decision not recorded; call remains held: ${errorMessage(error)}`,
      );
    }
    return {
      ok: true,
      result: {
        approval_id: approvalId,
        released: releasedBy(decision.next, approvalId),
        decision: payload.decision,
      },
    };
  }

  /** Why a decision on `approvalId`, which `task` no longer holds pending, was refused, as the records say. */
  private notPending(task: TaskState, approvalId: string): CommandResult {
    const known = this.deps.catalog.get<{ status: ApprovalStatus }>(
      "SELECT a.status FROM approvals a JOIN tool_calls t ON t.id = a.tool_call_id WHERE a.id = ? AND t.task_id = ?",
      approvalId,
      task.id,
    );
    // A row still pending here is no longer held in memory, for example because its abandonment could not
    // be recorded: Mia never released its call and no decision can now.
    if (known?.status === "pending")
      return fail(
        "invalid_state",
        `approval ${approvalId} can no longer be decided; its call was not released`,
      );
    if (known)
      return fail(
        "invalid_state",
        `approval ${approvalId} is ${known.status}, not pending; a decision cannot be reused`,
      );
    return fail("not_found", `approval ${approvalId} does not exist for this task`);
  }

  interruptTask(
    ctx: CommandContext,
    payload: { conversation_id: string; task_id: string },
  ): CommandResult {
    const addressed = this.addressTask(ctx, payload);
    if (addressed.kind !== "active") return addressed.result;
    return this.interrupt(addressed.task);
  }

  /**
   * Interrupt the active task through the recorded path, whoever asked: a client or shutdown. Atomically, the gate
   * closes, the epoch advances, pending approvals are invalidated and the order is recorded (see
   * `interruptionTransition`).
   */
  private interrupt(task: TaskState): CommandResult {
    const requested = this.newId("evt");
    const decision = this.decide(interruptionTransition, {
      kind: "interrupt_task",
      origin: this.origin,
      taskId: task.id,
      ids: {
        requested,
        resolved: new Map(
          task.pendingApprovals.keys().map((approvalId) => [approvalId, this.newId("evt")]),
        ),
      },
    });
    if (decision.kind === "rejected")
      return match(decision.rejection)
        .with({ kind: "no_task" }, () => notActiveTask(task.id))
        .with({ kind: "already_interrupting" }, (): CommandResult => ({
          ok: true,
          result: { already_interrupting: true },
        }))
        .with({ kind: "runtime_ended" }, (): CommandResult => ({
          ok: true,
          result: { runtime_ended: true },
        }))
        .with({ kind: "invalid" }, ({ taskStatus }) =>
          fail("invalid_state", `task is ${taskStatus}`),
        )
        .exhaustive();
    try {
      this.commit(decision);
    } catch (error) {
      return fail("record_failure", `interruption not recorded: ${errorMessage(error)}`);
    }
    return { ok: true, result: { execution_epoch: decision.next.epoch } };
  }

  diagnosticSnapshot(
    ctx: CommandContext,
    payload: { conversation_id: string | null; diagnostics: ClientDiagnostics },
  ): CommandResult {
    const conversationId =
      payload.conversation_id && this.conversation?.id === payload.conversation_id
        ? payload.conversation_id
        : null;
    const ids = { event: this.newId("evt"), diagnostics: this.newId("diag") };
    try {
      this.tx(() => {
        if (conversationId)
          this.transition.record(
            "client_diagnostics",
            {
              client_id: ctx.clientId,
              captured_at: payload.diagnostics.captured_at,
              connection_state: payload.diagnostics.connection_state,
            },
            { id: ids.event, taskId: this.task?.id ?? null },
          );
        this.transition.write({
          kind: "record_diagnostics",
          input: {
            id: ids.diagnostics,
            receivedAt: this.transition.at,
            conversationId,
            clientId: ctx.clientId,
            clientConnectionId: ctx.connectionId,
            taskId: this.task?.id ?? null,
            eventId: conversationId ? ids.event : null,
            capturedAt: payload.diagnostics.captured_at,
            state: payload.diagnostics,
          },
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
        id: this.newId("diag"),
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
      const id = this.newId("evt");
      try {
        this.tx(() =>
          this.transition.record(
            "client_disconnected",
            {
              connection_id: connectionId,
              pending_approvals: [...(this.task?.pendingApprovals.keys() ?? [])],
            },
            { id, taskId: this.task?.id ?? null },
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
        result: notActiveTask(payload.task_id),
      };
    return { kind: "active", task };
  }

  /**
   * Answer the prompt held for `call`'s approval, if one is still held. None is when the call never asked, or its
   * prompt was already answered: abandoned by the runtime, or denied once its turn ended. The
   * runtime then already has a denial, and this answer is dropped.
   */
  private answerPrompt(call: CallState, decision: PermissionDecision): void {
    if (call.approvalId !== null) this.prompts.reply(call.approvalId, decision);
  }

  // ---------------------------------------------------------------- runtime events

  /**
   * Handles one runtime event; it never rejects. A tool result that declares an output file is captured and
   * stored first, and in debug mode a released call's result first reads its server's body log (see
   * `readMcpBodies`); both happen outside the transaction, because the reads and the write can take long. Every
   * other event is recorded before this returns. A released call whose result never arrives has its body log read
   * at turn end instead (`readUnresultedBodies`).
   * A failed result never completes its call, so the file it declares is not read.
   * The adapter hands over the next stdout event only once this settles, so events still commit in the order the
   * runtime wrote them. The turn ends before the reads and the store only when the adapter stops reading a runtime
   * whose interruption did not end it; the result is then dropped with a log line, because the turn has already
   * been recorded without it.
   */
  private async onRuntimeEvent(taskId: string, event: RuntimeEvent): Promise<void> {
    if (event.type !== "tool_result") {
      this.recordRuntimeEvent(taskId, event, NOTHING_READ);
      return;
    }
    const declared = event.isError ? null : extractDeclaredArtifact(event.content);
    const task = this.taskOf(taskId);
    const bodyLog = task ? this.bodyLogOf(task, event.runtimeCallId) : null;
    if (!declared && bodyLog === null) {
      this.recordRuntimeEvent(taskId, event, NOTHING_READ);
      return;
    }
    const [output, bodies] = await Promise.all([
      declared ? this.captureOutput(declared) : null,
      bodyLog === null ? null : this.readMcpBodies(bodyLog, event.runtimeCallId),
    ]);
    this.recordRuntimeEvent(taskId, event, { output, bodies });
  }

  /** Captures and stores a tool output a result declared, with the ids of the rows that will record it. */
  private async captureOutput(declared: DeclaredArtifact): Promise<CapturedOutput> {
    const capture = await this.deps
      .collectArtifact(declared, this.deps.profile.runtime.outputDirectories)
      .catch((error: unknown): Capture => ({
        status: "failed",
        reason: `declared file unreadable: ${errorMessage(error)}`,
      }));
    const retention = await this.store(capture, this.stopping.signal);
    const ids: OutputIds = {
      artifact: this.newId("art"),
      resultLink: this.newId("link"),
      outputLink: this.newId("link"),
      registered: this.newId("evt"),
    };
    return { ids, declared, retention };
  }

  /**
   * The body log a tool result reads, or null when it reads none: only in debug mode, only for a call Mia
   * released (a refused call's error result never reached a server), and only when that call's server writes a
   * body log, which only the controlled MCP fixture does (issue #6). Debug mode off never reads one, so it records
   * exactly what it records without body logs.
   */
  private bodyLogOf(task: TaskState, runtimeCallId: string): string | null {
    if (!this.deps.debugMode) return null;
    const binding = bindToolResult(task.calls.get(runtimeCallId) ?? []);
    if (binding.kind === "unmatched" || !isReleased(binding.call.status)) return null;
    return bodyLogFor(this.deps.profile.runtime, binding.call.toolIdentity);
  }

  /** Reads what a call's body log holds for it, before the transaction that records it (see `readBodyLog`). */
  private async readMcpBodies(path: string, runtimeCallId: string): Promise<McpBodyRecord[]> {
    return this.bodiesFrom(await this.readBodyLog(path), runtimeCallId, "tool_result");
  }

  /**
   * In debug mode, what turn end records for each released call whose tool result never arrived (its turn
   * interrupted, or its runtime gone mid-call; see `releasedWithoutResult`) and whose server writes a body log: the
   * bodies that log holds for it, read before the transaction as its result would have read them. Each log is
   * read once, however many such calls it serves. The read is a snapshot: the server may still be handling a call
   * the runtime gave up on, so a line missing from it is recorded as not written yet (`BodyReadPoint`).
   */
  private async readUnresultedBodies(task: TaskState): Promise<UnresultedBodies[]> {
    if (!this.deps.debugMode) return [];
    const calls = releasedWithoutResult(task.calls.values()).flatMap((call) => {
      const path = bodyLogFor(this.deps.profile.runtime, call.toolIdentity);
      return path === null ? [] : [{ call, path }];
    });
    const byLog = await Promise.all(
      Map.groupBy(calls, ({ path }) => path)
        .entries()
        .map(async ([path, group]) => {
          const read = await this.readBodyLog(path);
          return group.map(({ call }) => ({
            call,
            bodies: this.bodiesFrom(read, call.runtimeCallId, "turn_end"),
          }));
        }),
    );
    return byLog.flat();
  }

  /**
   * Reads a body log, bounded like a turn-end evidence read (`readEvidence`, capped at `MAX_BODY_LOG_BYTES`,
   * abandoned at its deadline or shutdown). It never rejects: a log that cannot be read is recorded as the reason
   * its bodies are missing.
   */
  private readBodyLog(path: string): Promise<RuntimeFileRead> {
    const signal = AbortSignal.any([this.stopping.signal, this.deps.evidenceReadDeadline()]);
    return this.deps.readEvidence(path, { signal, maxBytes: MAX_BODY_LOG_BYTES });
  }

  /** The bodies a body log `read` holds for one call, each with the id of the event that will record it. */
  private bodiesFrom(
    read: RuntimeFileRead,
    runtimeCallId: string,
    readAt: BodyReadPoint,
  ): McpBodyRecord[] {
    // Parsing and redacting can throw (a body nested past the stack), and this must not reject the result's event.
    const bodies = ((): McpBody[] => {
      try {
        return mcpBodiesFrom(read, runtimeCallId, readAt);
      } catch (error) {
        return unrecordedBodies(`the body log could not be parsed: ${errorMessage(error)}`);
      }
    })();
    return bodies.map((body) => ({ ...body, eventId: this.newId("evt") }));
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
   * Records one runtime event of task `taskId`, with the tool output its result declared already captured, against
   * the task as it is now (see `runtimeEventTransition`). An event decided after the task's runtime ended is dropped
   * with a log line: the turn was recorded without it.
   */
  private recordRuntimeEvent(taskId: string, event: RuntimeEvent, read: ResultReads): void {
    const decision = this.decide(runtimeEventTransition, {
      kind: "runtime_event",
      origin: this.origin,
      taskId,
      event,
      reads: {
        ...read,
        policy:
          event.type === "tool_proposed"
            ? policyFor(this.deps.profile.runtime, event.toolIdentity)
            : null,
      },
      ids: {
        event: this.newId("evt"),
        resolved: this.newId("evt"),
        call: this.newId("call"),
        unmatched: this.newId("evt"),
      },
    });
    if (decision.kind === "rejected") {
      const captured = read.output ? ` (output ${read.output.declared.path} captured)` : "";
      this.deps.log(
        `${event.type}${captured} for task ${taskId} handled after its runtime ended; not recorded`,
      );
      return;
    }
    try {
      this.commit(decision);
    } catch (error) {
      this.deps.log(`failed to record ${event.type}: ${errorMessage(error)}`);
    }
  }

  // ---------------------------------------------------------------- approval controller

  /**
   * Answers one permission request of task `taskId` (see `permissionRequestTransition`). A refused request is answered
   * whether or not its refusal can be recorded; any other is answered only once its records commit, and denied at once
   * when they do not, so nothing is held or released for a request that was never recorded.
   */
  private async handlePermission(
    taskId: string,
    req: PermissionRequest,
  ): Promise<PermissionDecision> {
    const decision = this.decide(permissionRequestTransition, {
      kind: "permission_request",
      origin: this.origin,
      taskId,
      request: {
        runtimeCallId: req.toolUseId ?? null,
        toolIdentity: req.toolName,
        input: req.input,
      },
      policy: policyFor(this.deps.profile.runtime, req.toolName),
      promptsFull: this.prompts.full,
      ids: {
        resolved: this.newId("evt"),
        proposal: this.newId("evt"),
        call: this.newId("call"),
        evaluation: this.newId("evt"),
        outcome: this.newId("evt"),
        approval: this.newId("appr"),
      },
    });
    if (decision.kind === "rejected")
      return match(decision.rejection)
        .with({ kind: "no_task" }, (): PermissionDecision => NO_ACTIVE_TASK)
        .with({ kind: "refused" }, ({ detail, answer }) => {
          this.recordRefusal(taskId, detail);
          return answer;
        })
        .exhaustive();
    const asking: Asking = { answer: null };
    this.asking = asking;
    try {
      this.commit(decision);
    } catch (error) {
      // Nothing was requested, so nothing is held: the runtime is denied at once.
      this.deps.log(`permission handling failed: ${errorMessage(error)}`);
      return NOT_RECORDED;
    } finally {
      this.asking = null;
    }
    const { answer } = asking;
    // Unreachable: a committed request's transition always queues its answer, and performing it cannot throw.
    if (!answer) {
      this.deps.log(`permission request for ${req.toolName} was recorded but not answered`);
      return NOT_RECORDED;
    }
    return match(answer)
      .with({ kind: "answer" }, ({ decision: answered }) => answered)
      .with({ kind: "hold" }, ({ approvalId, callId }) =>
        this.holdPrompt({ taskId, callId, approvalId, abandoned: req.abandoned }),
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
    taskId: string;
    callId: string;
    approvalId: string;
    abandoned: AbortSignal;
  }): Promise<PermissionDecision> {
    const { taskId, callId, approvalId, abandoned } = input;
    const held = this.prompts.hold(approvalId, {
      signal: abandoned,
      onAbort: () => this.abandon(taskId, callId),
    });
    return match(held)
      .with({ kind: "held" }, ({ reply }) => reply)
      .with({ kind: "refused" }, ({ refusal }) => {
        this.deps.log(`prompt for approval ${approvalId} could not be held (${refusal})`);
        return Promise.resolve(this.abandon(taskId, callId));
      })
      .exhaustive();
  }

  /**
   * Record a refused permission request as an error the client is told of: a follow-up to the refusal, which already
   * holds the runtime's answer, so a record that fails only logs.
   */
  private recordRefusal(taskId: string, detail: string): void {
    const decision = this.decide(permissionRefusedTransition, {
      kind: "permission_refused",
      origin: this.origin,
      taskId,
      detail,
      ids: { event: this.newId("evt") },
    });
    // Rejected, the task ended; unreachable, as the refusal was decided against it just before.
    if (decision.kind === "rejected") return;
    try {
      this.commit(decision);
    } catch (error) {
      this.deps.log(`could not record a refused permission request: ${errorMessage(error)}`);
    }
  }

  /**
   * The runtime dropped the held prompt (process gone or turn aborted): the pending approval can never release
   * anything. Returns the runtime's answer; `prompts` calls this at most once per hold, and never after a reply.
   */
  private abandon(taskId: string, callId: string): PermissionDecision {
    const task = this.taskOf(taskId);
    const call = task ? callById(task, callId) : undefined;
    // Unreachable while the turn's end answers every prompt still held before its task is cleared (submitText).
    if (!task || !call) return TURN_ENDED;
    const decision = this.decide(abandonmentTransition, {
      kind: "prompt_abandoned",
      origin: this.origin,
      taskId,
      callId,
      ids: { resolved: this.newId("evt") },
    });
    // Rejected, the approval was no longer pending (or the call is gone), so there is nothing to expire.
    if (decision.kind === "accepted") {
      try {
        this.commit(decision);
      } catch (error) {
        this.deps.log(`could not record abandoned approval: ${String(error)}`);
        // The runtime is denied below whatever the records say, so memory takes the expiry anyway: a later
        // decision finds nothing pending and cannot release the call. The catalog keeps the approval pending
        // until finishTurn records the call's final status and expires every approval still pending. Unlike the
        // other memory-only changes, this one departs from what the records say (#165). The failed commit ran
        // synchronously after the decision, so its next state is still the current one with the expiry applied.
        this.current = decision.next;
      }
    }
    return abandonedPromptDenial(call.toolIdentity);
  }

  // ---------------------------------------------------------------- turn completion

  private async finishTurn(taskId: string, result: TurnResult): Promise<void> {
    const ended = this.taskOf(taskId);
    const current = this.current;
    // Unreachable: only the turn's end clears its task, once this has returned (submitText).
    if (!ended || !current) {
      this.deps.log(`turn of task ${taskId} ended after its task was cleared; not recorded`);
      return;
    }
    // Before the reads below yield: a decision or interruption handled while they are awaited must not release
    // a call to, or record an interruption of, a runtime that already exited. An approval then ends blocked.
    // Memory only: nothing records the runtime's end until the transaction below.
    this.current = withTask(current, taskId, (task) => ({
      ...task,
      runtimeEnded: true,
      gateOpen: false,
    }));
    // Read and store before the transaction: retaining evidence is best-effort, so a read or store that fails
    // becomes a failed capture that says why, and the transaction only records that outcome. Its rows then commit
    // or fail with the turn's end, like every other record of it. Read and store before anything else is
    // computed: a command handled while they are awaited (a decision) changes the task, and the records must
    // reflect it.
    // The calls whose bodies are read are chosen now, and nothing handled while the reads are awaited changes which
    // they are: with the runtime ended, no call can be released, and a tool result arriving now is dropped.
    const signal = AbortSignal.any([this.stopping.signal, this.deps.evidenceReadDeadline()]);
    const [transcript, hookRead, unresultedBodies] = await Promise.all([
      this.deps.readEvidence(result.streamLogPath, { signal }),
      this.deps.readEvidence(result.hookEvidencePath, { signal }),
      this.readUnresultedBodies(ended),
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
    // The task as the commands handled while the reads were awaited left it.
    const task = this.taskOf(taskId);
    const conversation = this.current;
    if (!task || !conversation) {
      this.deps.log(`turn of task ${taskId} ended after its task was cleared; not recorded`);
      return;
    }
    const opts = taskLinks(task);
    const calls = callsOf(task);
    const actions = classifyActions(calls, task.interrupted);
    const unknown = actions.some((action) => action.status === "unknown");
    const { status, error } = classifyTask({ interrupted: task.interrupted, result, unknown });
    const efforts = effortLevels(hooks);
    const ids = {
      transcript: { artifact: this.newId("art"), link: this.newId("link") },
      hooks: { artifact: this.newId("art"), link: this.newId("link") },
      outcome: this.newId("evt"),
      finished: this.newId("evt"),
      error: this.newId("evt"),
    };
    try {
      // Every approval the records still hold pending, not only the ones in memory: an abandonment whose commit
      // failed left memory without its approval and the catalog with a pending row. Read just before the
      // transaction, with nothing awaited in between, so no approval can be requested or resolved after the read
      // and before the commit; inside the try, so a failed read is handled as a failed commit.
      const stillPending = this.deps.catalog.all<{ id: string }>(
        "SELECT a.id FROM approvals a JOIN tool_calls t ON t.id = a.tool_call_id WHERE t.task_id = ? AND a.status = 'pending'",
        task.id,
      );
      this.tx(() => {
        for (const action of actions)
          this.transition.write({
            kind: "update_tool_call",
            id: action.tool_call_id,
            fields: { updatedAt: this.transition.at, status: action.status, detail: action.detail },
          });
        for (const { call, bodies } of unresultedBodies)
          for (const body of bodies)
            this.transition.record(
              MCP_BODY_EVENT[body.direction],
              mcpPayload({ toolCallId: call.id, runtimeCallId: call.runtimeCallId }, body),
              { ...opts, id: body.eventId },
            );
        for (const approval of stillPending)
          this.transition.write({
            kind: "update_approval",
            id: approval.id,
            fields: { status: "expired", consumedAt: this.transition.at, reason: "task ended" },
          });
        if (transcriptRetention)
          this.registerEvidence(task, {
            ids: ids.transcript,
            kind: "runtime_transcript",
            name: `turn-${conversation.turnCount}.stream.jsonl`,
            relation: "runtime_transcript",
            originalPath: result.streamLogPath,
            retention: transcriptRetention,
          });
        if (hookRetention)
          this.registerEvidence(task, {
            ids: ids.hooks,
            kind: "effort_evidence",
            name: `turn-${conversation.turnCount}.hooks.jsonl`,
            relation: "task_output",
            originalPath: null,
            retention: hookRetention,
          });
        this.transition.write({
          kind: "update_execution",
          id: task.executionId,
          fields: {
            status: executionStatusFor(task.interrupted, result),
            endedAt: this.transition.at,
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
          },
        });
        if (task.interrupted)
          this.transition.emit(
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
            { ...opts, id: ids.outcome },
          );
        this.transition.write({
          kind: "update_task",
          id: task.id,
          fields: { status, finishedAt: this.transition.at },
        });
        this.transition.emit(
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
          { ...opts, id: ids.finished },
        );
        if (error)
          this.transition.emit(
            {
              type: "error",
              payload: {
                code: "runtime_failure",
                message: error,
                conversation_id: conversation.id,
                task_id: task.id,
              },
            },
            { ...opts, id: ids.error },
          );
        const finalStatus = new Map(actions.map((action) => [action.tool_call_id, action.status]));
        this.transition.advanceTask(task.id, (next) => ({
          ...withCallStatuses(next, finalStatus),
          pendingApprovals: new Map(),
          status,
        }));
      });
    } catch (recordError) {
      this.deps.log(`finishTurn record failure: ${String(recordError)}`);
    }
    // Set even when the records failed: the note is how the next turn learns what may have happened.
    const note = noteAfterTurn({
      interrupted: task.interrupted,
      actions,
      abandoned: task.abandoned.flatMap((callId) => callById(task, callId) ?? []),
    });
    // Memory only: the next turn records the note it carries, with its task_submitted.
    if (note && this.current) this.current = { ...this.current, pendingNote: note };
  }

  /**
   * Registers one piece of a finished turn's evidence, linked to its task (inside tx). Retention was decided before
   * the transaction opened (`store`), so these rows only record that outcome and commit or fail with the turn's end.
   */
  private registerEvidence(task: TaskState, evidence: TurnEvidence): void {
    const artifactId = evidence.ids.artifact;
    this.transition.write(
      {
        kind: "register_artifact",
        input: {
          id: artifactId,
          createdAt: this.transition.at,
          kind: evidence.kind,
          logicalName: evidence.name,
          mimeType: "application/x-ndjson",
          producerExecutionId: task.executionId,
          originalPath: evidence.originalPath,
          ...captureFields(evidence.retention),
        },
      },
      {
        kind: "link_artifact",
        input: {
          id: evidence.ids.link,
          conversationId: this.activeConversation.id,
          artifactId,
          relation: evidence.relation,
          taskId: task.id,
        },
      },
    );
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
    const turn = this.running;
    if (!interruption.ok) {
      this.deps.log(`shutdown: ${interruption.message}; killing the runtime anyway`);
      turn?.handle
        .interrupt()
        .catch((error: unknown) => this.deps.log(`interrupt failed: ${errorMessage(error)}`));
    }
    // A task whose turn never started (the adapter threw as it submitted it) has no runtime to wait for.
    if (turn?.taskId !== task.id) return;
    const timedOut = Promise.withResolvers<"timed_out">();
    const onAbort = () => {
      this.stopping.abort(new Error("abandoned at shutdown"));
      timedOut.resolve("timed_out");
    };
    if (turnWait.aborted) onAbort();
    else turnWait.addEventListener("abort", onAbort, { once: true });
    const outcome = await Promise.race([
      turn.finished.then(() => "finished" as const),
      timedOut.promise,
    ]).finally(() => turnWait.removeEventListener("abort", onAbort));
    if (outcome === "finished") return;
    // A task already cleared has finished too.
    if (this.taskOf(task.id)?.runtimeEnded ?? true) await turn.finished;
    else
      this.deps.log(`shutdown: task ${task.id} did not finish in time; its outcome is unrecorded`);
  }
}
