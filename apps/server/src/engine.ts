import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { match } from "ts-pattern";
import {
  bodyLogFor,
  policyFor,
  hookEvidenceFrom,
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
import { type Catalog, type NewId, type RecordWriter, type StoredObject } from "@mia/records";
import {
  extractDeclaredArtifact,
  type Capture,
  type DeclaredArtifact,
  type Retention,
} from "./artifact-capture.ts";
import type { ArtifactCollector } from "./artifact-collector.ts";
import {
  callById,
  callsOf,
  type CallState,
  type ConversationState,
  type TaskState,
} from "./conversation-state.ts";
import {
  MAX_BODY_LOG_BYTES,
  mcpBodiesFrom,
  unrecordedBodies,
  type BodyReadPoint,
  type McpBody,
  type McpBodyRecord,
} from "./mcp-bodies.ts";
import {
  abandonmentTransition,
  abandonmentUnrecordedTransition,
  approvalDecisionTransition,
  conversationStart,
  diagnosticsTransition,
  disconnectTransition,
  interruptionTransition,
  permissionRefusedTransition,
  permissionRequestTransition,
  releasedBy,
  runtimeEventTransition,
  runtimeExitTransition,
  taskClearedTransition,
  taskSubmissionTransition,
  turnEndTransition,
  turnUnrecordedTransition,
  type CapturedOutput,
  type ConversationDecision,
  type ConversationStartEvent,
  type ConversationTransition,
  type OutputIds,
  type PromptAbandonedEvent,
  type RuntimeReport,
  type UnresultedBodies,
} from "./decide-conversation.ts";
import type { EngineEffect, OutgoingEvent, PermissionAnswer, TurnStart } from "./engine-effects.ts";
import { commitRecords, eventSequence, type CommittedChange } from "./engine-records.ts";
import {
  agentPromptObject,
  nameProvenance,
  planConversationProvenance,
  readConversationFiles,
  storeProvenance,
  type ProvenancePlan,
  type ServerIdentity,
} from "./provenance.ts";
import type { BuiltTransition, Origin } from "./transition-draft.ts";
import {
  abandonedPromptDenial,
  bindToolResult,
  isReleased,
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

/**
 * The answer to a permission request that was recorded but never answered, which a committed request's transition
 * rules out; nothing is held or released for it.
 */
const UNANSWERED: PermissionDecision = {
  behavior: "deny",
  message: "Mia could not answer this call; it was not released.",
};

/** The permission request being committed, and the answer its `answer_permission` effect gave, once performed. */
interface Asking {
  answer: PermissionAnswer | null;
}

/** The task submission being committed, and the turn its `start_turn` effect gave, once performed. */
interface Submitting {
  turn: TurnStart | null;
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
   * randomness, so a transition's ids are chosen before its records are written and can refer to each other. The
   * engine draws every id a transition may record before deciding it and hands them in with its event, since the
   * pure transitions have no way to draw one; one whose outcome records fewer leaves the rest unused.
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

/**
 * Conversation/task coordinator plus approval and interruption controller. One conversation, one task,
 * one active client. The rules live in ./transitions.ts, and ./decide-conversation.ts composes them into pure
 * transitions for every change to a conversation, its start and the few memory-only changes included; the engine
 * commits what they decide, replaces its state with the next one only after the commit, then performs the effects
 * (see `commit`).
 */
export class Engine {
  activeConnectionId: string | null = null;
  activeClientId: string | null = null;
  /**
   * The active conversation's state, replaced whole by the next state a transition decided once its records commit
   * (see ConversationState), and never mutated; only `commit` replaces it. A memory-only transition commits no records.
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
   * The runtime's permission prompts waiting for the user's decision, keyed by approval id. Each is answered once:
   * by an `answer_prompt` effect after a commit, by its abandonment, or once its turn has ended (startTurn).
   */
  private readonly prompts = new Holds<PermissionDecision>(MAX_HELD_PROMPTS);
  /**
   * The permission request `handlePermission` is committing, or null outside that commit. The request's
   * `answer_permission` effect writes its answer here; the commit is synchronous, so at most one is ever set.
   */
  private asking: Asking | null = null;
  /**
   * The task submission `submitText` is committing, or null outside that commit. The submission's `start_turn` effect
   * writes its turn here, and `submitText` starts it once the commit has returned; at most one is ever set.
   */
  private submitting: Submitting | null = null;

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

  /** The client and connection a transition decided now records its events under. */
  private get origin(): Origin {
    return { clientId: this.activeClientId, connectionId: this.activeConnectionId };
  }

  /** The conversation every guarded command and runtime callback operates on; callers check for one first. */
  private get activeConversation(): ConversationState {
    if (!this.current) throw new Error("engine has no active conversation");
    return this.current;
  }

  // ---------------------------------------------------------------- event plumbing

  /**
   * Decide one transition of the active conversation with the pure machine (see ./decide-conversation.ts), reading
   * the clock once for it, as a kernel dispatch hands its `decide` one `now`, so the transition rows of one commit
   * (see `EngineDeps.now`) agree on when it happened; an accepted decision is committed with `commit`.
   */
  private decide<Event, Rejection>(
    transition: ConversationTransition<Event, Rejection>,
    event: Event,
  ): ConversationDecision<Rejection> {
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
   * Decide and commit a memory-only transition (see `memoryOnly` in ./decide-conversation.ts): it records nothing, so a
   * catalog that cannot commit does not refuse it. A rejection (the task or call it names is gone, or nothing is
   * pending) changes nothing. It reads the clock once, as every decision does, though no memory-only transition uses it.
   */
  private commitMemoryOnly<Event, Rejection>(
    transition: ConversationTransition<Event, Rejection>,
    event: Event,
  ): void {
    const decision = this.decide(transition, event);
    if (decision.kind === "accepted") this.commit(decision);
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
        this.deliver(
          { type: "tool_call", payload },
          { id: this.deps.newId("evt"), sequence: null },
        ),
      )
      .with({ kind: "answer_prompt" }, ({ approvalId, decision }) =>
        this.prompts.reply(approvalId, decision),
      )
      .with({ kind: "answer_permission" }, ({ answer }) => {
        if (!this.asking) throw new Error("no permission request is being committed");
        if (this.asking.answer) throw new Error("a permission request is answered once");
        this.asking.answer = answer;
      })
      .with({ kind: "start_turn" }, ({ turn }) => {
        if (!this.submitting) throw new Error("no task submission is being committed");
        if (this.submitting.turn) throw new Error("a task submission starts one turn");
        this.submitting.turn = turn;
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
    const provenance = nameProvenance(plan, this.deps.newId);
    const prompt = agentPromptObject(provenance);
    const event: ConversationStartEvent = {
      kind: "start_conversation",
      // Disconnected, the active connection is none or one of this client's (refuseStart), so it stays.
      origin: {
        clientId: ctx.clientId,
        connectionId: connected ? ctx.connectionId : this.activeConnectionId,
      },
      closes: this.current?.id ?? null,
      provenance,
      promptFile: prompt === null ? null : this.deps.writer.objects.pathFor(prompt.digest),
      conversationsRoot: this.deps.catalog.paths.conversations,
      debugMode: this.deps.debugMode,
      ids: {
        conversation: this.deps.newId("conv"),
        runtimeConversation: randomUUID(),
        provenanceRecorded: this.deps.newId("evt"),
        started: this.deps.newId("evt"),
        captured: this.deps.newId("evt"),
      },
    };
    const previous = { connection: this.activeConnectionId, client: this.activeClientId };
    try {
      // Built from no state: the conversation starting has none until its start commits, and the one it closes is
      // named by id (see ./decide-conversation.ts).
      const decision = conversationStart({ event, now: this.deps.now() });
      // Unlike the conversation, which moves with the commit, the active connection and client are set before it,
      // because the start's effects deliver conversation_started to the connection active when they run; the catch
      // below restores them if the commit throws.
      this.activeConnectionId = event.origin.connectionId;
      this.activeClientId = event.origin.clientId;
      this.commit(decision);
      return {
        ok: true,
        result: {
          conversation_id: decision.next.id,
          provenance_set_id: decision.next.provenanceSetId,
        },
      };
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
    const decision = this.decide(taskSubmissionTransition, {
      kind: "submit_task",
      origin: this.origin,
      text: payload.text,
      clientId: ctx.clientId,
      commandId: ctx.commandId,
      requested: {
        model: this.deps.profile.runtime.model,
        effort: this.deps.profile.runtime.effort,
      },
      ids: {
        task: this.deps.newId("task"),
        execution: this.deps.newId("exec"),
        submitted: this.deps.newId("evt"),
        started: this.deps.newId("evt"),
      },
    });
    if (decision.kind === "rejected") {
      const { taskId, status, pendingApprovals } = decision.rejection;
      const hint =
        pendingApprovals.length > 0
          ? `approve or reject ${pendingApprovals.join(", ")}, or interrupt it`
          : "wait for it to finish or interrupt it";
      return fail("busy", `task ${taskId} is ${status}; ${hint}`);
    }
    // Restored, not cleared, so a commit nested inside this one's effects could not take the outer submission's slot.
    const previous = this.submitting;
    const submitting: Submitting = { turn: null };
    this.submitting = submitting;
    try {
      this.commit(decision);
    } catch (error) {
      return fail("record_failure", `could not record task: ${errorMessage(error)}`);
    } finally {
      this.submitting = previous;
    }
    // Unreachable: a committed submission's transition always queues its turn, and taking it cannot fail.
    if (!submitting.turn) throw new Error("a task submission committed without its turn");
    return this.startTurn(decision.next, submitting.turn);
  }

  /**
   * Start the runtime on the turn of the task a submission has committed, with the prompt the submission composed,
   * from the conversation as that commit left it. An adapter that throws here fails the command; the task it recorded
   * stays the active one, with no runtime to end it.
   */
  private startTurn(conversation: ConversationState, turn: TurnStart): CommandResult {
    const { taskId, prompt } = turn;
    const task = conversation.task;
    // Unreachable: the submission that queued this turn made its task the conversation's.
    if (task?.id !== taskId) throw new Error(`task ${taskId} is not the conversation's task`);
    const finished: PromiseWithResolvers<void> = Promise.withResolvers();
    const handle = this.deps.adapter.submitTurn({
      text: prompt,
      runtimeConversationId: conversation.runtimeConversationId,
      firstTurn: !conversation.sessionStarted,
      // The launch creates this directory and the conversation directory above it, owner-only, on the first turn.
      runtimeDir: resolve(conversation.directory, "runtime"),
      turnIndex: conversation.turnCount,
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
        try {
          const ended = this.taskOf(taskId);
          for (const call of ended ? callsOf(ended) : []) this.answerPrompt(call, TURN_ENDED);
          // The task's end was recorded (or failed to be) by finishTurn.
          if (ended) this.commitMemoryOnly(taskClearedTransition, { kind: "task_cleared", taskId });
        } catch (error) {
          // Not expected, as nothing here touches the catalog; caught so the turn still settles below, and so this
          // chain, which nothing awaits, cannot reject.
          this.deps.log(`could not clear task ${taskId}: ${errorMessage(error)}`);
        }
        if (this.running?.taskId === taskId) this.running = null;
        finished.resolve();
      });
    return {
      ok: true,
      result: { task_id: taskId, execution_id: task.executionId, execution_epoch: task.epoch },
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
      ids: { resolved: this.deps.newId("evt"), dispatched: this.deps.newId("evt") },
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
    const requested = this.deps.newId("evt");
    const decision = this.decide(interruptionTransition, {
      kind: "interrupt_task",
      origin: this.origin,
      taskId: task.id,
      ids: {
        requested,
        resolved: new Map(
          task.pendingApprovals.keys().map((approvalId) => [approvalId, this.deps.newId("evt")]),
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

  /**
   * Records a client's diagnostics snapshot. One about the active conversation is that conversation's transition
   * (`diagnosticsTransition`); one about no conversation, or another, records its row alone, as a heartbeat does.
   */
  diagnosticSnapshot(
    ctx: CommandContext,
    payload: { conversation_id: string | null; diagnostics: ClientDiagnostics },
  ): CommandResult {
    const about = Boolean(
      payload.conversation_id && this.conversation?.id === payload.conversation_id,
    );
    const ids = { event: this.deps.newId("evt"), diagnostics: this.deps.newId("diag") };
    try {
      if (about) {
        const decision = this.decide(diagnosticsTransition, {
          kind: "client_diagnostics",
          origin: this.origin,
          from: { clientId: ctx.clientId, connectionId: ctx.connectionId },
          diagnostics: payload.diagnostics,
          ids,
        });
        // Never rejected: a report about the conversation is always recorded.
        if (decision.kind === "accepted") this.commit(decision);
      } else
        this.deps.writer.recordDiagnostics({
          id: ids.diagnostics,
          receivedAt: this.deps.now().toISOString(),
          conversationId: null,
          clientId: ctx.clientId,
          clientConnectionId: ctx.connectionId,
          taskId: this.task?.id ?? null,
          eventId: null,
          capturedAt: payload.diagnostics.captured_at,
          state: payload.diagnostics,
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
        const decision = this.decide(disconnectTransition, {
          kind: "client_disconnected",
          origin: this.origin,
          connectionId,
          ids: { event: this.deps.newId("evt") },
        });
        // Never rejected: a disconnect of the conversation's connection is always recorded.
        if (decision.kind === "accepted") this.commit(decision);
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
    if (event.type === "tool_proposed") {
      this.recordRuntimeEvent(taskId, {
        event,
        policy: policyFor(this.deps.profile.runtime, event.toolIdentity),
      });
      return;
    }
    if (event.type !== "tool_result") {
      this.recordRuntimeEvent(taskId, { event });
      return;
    }
    const declared = event.isError ? null : extractDeclaredArtifact(event.content);
    const task = this.taskOf(taskId);
    const bodyLog = task ? this.bodyLogOf(task, event.runtimeCallId) : null;
    if (!declared && bodyLog === null) {
      this.recordRuntimeEvent(taskId, { event, output: null, bodies: null });
      return;
    }
    const [output, bodies] = await Promise.all([
      declared ? this.captureOutput(declared) : null,
      bodyLog === null ? null : this.readMcpBodies(bodyLog, event.runtimeCallId),
    ]);
    this.recordRuntimeEvent(taskId, { event, output, bodies });
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
      artifact: this.deps.newId("art"),
      resultLink: this.deps.newId("link"),
      outputLink: this.deps.newId("link"),
      registered: this.deps.newId("evt"),
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
    return bodies.map((body) => ({ ...body, eventId: this.deps.newId("evt") }));
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
   * Records one runtime event of task `taskId`, with what the boundary read for it, against the task as it is now
   * (see `runtimeEventTransition`). An event decided after the task's runtime ended is dropped with a log line: the
   * turn was recorded without it. It never throws: an event that cannot be recorded is logged.
   */
  private recordRuntimeEvent(taskId: string, report: RuntimeReport): void {
    const { event } = report;
    try {
      const decision = this.decide(runtimeEventTransition, {
        kind: "runtime_event",
        origin: this.origin,
        taskId,
        report,
        ids: {
          event: this.deps.newId("evt"),
          resolved: this.deps.newId("evt"),
          call: this.deps.newId("call"),
          unmatched: this.deps.newId("evt"),
        },
      });
      if (decision.kind === "rejected") {
        const output = "output" in report ? report.output : null;
        const captured = output ? ` (output ${output.declared.path} captured)` : "";
        this.deps.log(
          `${event.type}${captured} for task ${taskId} handled after its runtime ended; not recorded`,
        );
        return;
      }
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
    let answer: PermissionAnswer;
    try {
      answer = this.decidePermission(taskId, req);
    } catch (error) {
      // Nothing was requested, so nothing is held: the runtime is denied at once.
      this.deps.log(`permission handling failed: ${errorMessage(error)}`);
      return NOT_RECORDED;
    }
    return match(answer)
      .with({ kind: "answer" }, ({ decision }) => decision)
      .with({ kind: "hold" }, ({ approvalId, callId }) =>
        this.holdPrompt({ taskId, callId, approvalId, abandoned: req.abandoned }),
      )
      .exhaustive();
  }

  /**
   * Decide and commit one permission request, returning what answers the runtime: the answer its committed transition
   * gave through `answer_permission` (taken through `asking`), or the one a rejection carries. It throws when the
   * transition fails or its records do not commit.
   */
  private decidePermission(taskId: string, req: PermissionRequest): PermissionAnswer {
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
        resolved: this.deps.newId("evt"),
        proposal: this.deps.newId("evt"),
        call: this.deps.newId("call"),
        evaluation: this.deps.newId("evt"),
        outcome: this.deps.newId("evt"),
        approval: this.deps.newId("appr"),
      },
    });
    if (decision.kind === "rejected")
      return match(decision.rejection)
        .with({ kind: "no_task" }, (): PermissionAnswer => ({
          kind: "answer",
          decision: NO_ACTIVE_TASK,
        }))
        .with({ kind: "refused" }, ({ detail, answer }): PermissionAnswer => {
          this.recordRefusal(taskId, detail);
          return { kind: "answer", decision: answer };
        })
        .exhaustive();
    // Restored, not cleared, so a commit nested inside this one's effects could not take the outer request's slot.
    const previous = this.asking;
    const asking: Asking = { answer: null };
    this.asking = asking;
    try {
      this.commit(decision);
    } finally {
      this.asking = previous;
    }
    if (asking.answer) return asking.answer;
    // Unreachable: a committed request's transition always queues its answer, and taking it cannot fail. The request
    // was recorded, so this denial does not claim otherwise.
    this.deps.log(`permission request for ${req.toolName} was recorded but not answered`);
    return { kind: "answer", decision: UNANSWERED };
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
    try {
      const decision = this.decide(permissionRefusedTransition, {
        kind: "permission_refused",
        origin: this.origin,
        taskId,
        detail,
        ids: { event: this.deps.newId("evt") },
      });
      // Rejected, the task ended; unreachable, as the refusal was decided against it just before.
      if (decision.kind === "accepted") this.commit(decision);
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
    // Unreachable while the turn's end answers every prompt still held before its task is cleared (startTurn).
    if (!task || !call) return TURN_ENDED;
    const abandoned: PromptAbandonedEvent = {
      kind: "prompt_abandoned",
      origin: this.origin,
      taskId,
      callId,
      ids: { resolved: this.deps.newId("evt") },
    };
    const decision = this.decide(abandonmentTransition, abandoned);
    // Rejected, the approval was no longer pending (or the call is gone), so there is nothing to expire.
    if (decision.kind === "accepted") {
      try {
        this.commit(decision);
      } catch (error) {
        this.deps.log(`could not record abandoned approval: ${String(error)}`);
        // The runtime is denied below whatever the records say, so memory takes the expiry anyway (#165). Nothing
        // has run since the failed commit, so it is decided from the state the expiry was decided from.
        this.commitMemoryOnly(abandonmentUnrecordedTransition, {
          ...abandoned,
          kind: "abandonment_unrecorded",
        });
      }
    }
    return abandonedPromptDenial(call.toolIdentity);
  }

  // ---------------------------------------------------------------- turn completion

  private async finishTurn(taskId: string, result: TurnResult): Promise<void> {
    const ended = this.taskOf(taskId);
    // Unreachable: only the turn's end clears its task, once this has returned (startTurn).
    if (!ended) {
      this.deps.log(`turn of task ${taskId} ended after its task was cleared; not recorded`);
      return;
    }
    // Before the reads below yield (see `runtimeExitTransition`).
    this.commitMemoryOnly(runtimeExitTransition, { kind: "runtime_exited", taskId });
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
    const hooks = hookEvidence.records;
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
    if (!task) {
      this.deps.log(`turn of task ${taskId} ended after its task was cleared; not recorded`);
      return;
    }
    const ids = {
      transcript: { artifact: this.deps.newId("art"), link: this.deps.newId("link") },
      hooks: { artifact: this.deps.newId("art"), link: this.deps.newId("link") },
      outcome: this.deps.newId("evt"),
      finished: this.deps.newId("evt"),
      error: this.deps.newId("evt"),
    };
    let recorded = false;
    try {
      // Every approval the records still hold pending (see `TurnEndedEvent.stillPending`). Read just before the
      // decision, with nothing awaited in between, so no approval can be requested or resolved after the read and
      // before the commit; inside the try, so a failed read is handled as a failed commit.
      const stillPending = this.deps.catalog.all<{ id: string }>(
        "SELECT a.id FROM approvals a JOIN tool_calls t ON t.id = a.tool_call_id WHERE t.task_id = ? AND a.status = 'pending'",
        task.id,
      );
      const decision = this.decide(turnEndTransition, {
        kind: "turn_ended",
        origin: this.origin,
        taskId,
        result,
        transcript: transcriptRetention,
        hooks: { evidence: hookEvidence, retention: hookRetention },
        unresultedBodies,
        stillPending: stillPending.map(({ id }) => id),
        ids,
      });
      // Rejected, the task was cleared; unreachable, as it was read just above with nothing awaited since.
      if (decision.kind === "accepted") {
        this.commit(decision);
        recorded = true;
      }
    } catch (recordError) {
      this.deps.log(`finishTurn record failure: ${String(recordError)}`);
    }
    // A committed end left the note; one that was not still leaves it, as the next turn's only account of this one.
    if (!recorded)
      this.commitMemoryOnly(turnUnrecordedTransition, { kind: "turn_unrecorded", taskId });
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
