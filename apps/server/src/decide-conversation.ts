import { match } from "ts-pattern";
import type {
  HookEvidence,
  PermissionDecision,
  RuntimeEvent,
  TurnResult,
} from "@mia/agent-adapter";
import type { Decide, Decision as MachineDecision } from "@mia/kernel";
import {
  canonicalDigest,
  redactValue,
  type ClientDiagnostics,
  type Decision,
  type Effort,
  type TaskStatus,
  type ToolCallPolicy,
} from "@mia/protocol";
import {
  conversationDirectory,
  mcpPayload,
  type ArtifactKind,
  type LinkRelation,
} from "@mia/records";
import { captureFields, type DeclaredArtifact, type Retention } from "./artifact-capture.ts";
import {
  callById,
  callsOf,
  otherPending,
  pendingCall,
  withCall,
  withCallStatuses,
  withPending,
  withRevision,
  withTask,
  withoutPending,
  type CallState,
  type ConversationState,
  type TaskState,
} from "./conversation-state.ts";
import type { EngineEffect, PermissionAnswer } from "./engine-effects.ts";
import type { EngineRecord } from "./engine-records.ts";
import { MCP_BODY_EVENT, type McpBodyRecord } from "./mcp-bodies.ts";
import { provenanceLinks, provenanceRecords, type NamedProvenancePlan } from "./provenance.ts";
import { TransitionDraft, taskLinks, type Origin } from "./transition-draft.ts";
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
  type CallChange,
  type PermissionRule,
} from "./transitions.ts";

/**
 * The conversation machine: what a command or runtime callback does to the conversation, as a pure `decide` over its
 * state (see `ConversationState`). Each transition composes the rules of ./transitions.ts into the records to commit,
 * the effects to perform once they have, and the next state, and every id it may record comes in with its event,
 * drawn at the boundary. It reads nothing else and changes nothing, so the engine commits what it returns and a
 * test checks it directly. It covers every transition of a conversation: its start, task submission, how approvals
 * end (a user's decision, an interruption, and the runtime abandoning a held prompt), the runtime's permission
 * requests, the events the runtime reports, the turn's end, and the client's diagnostics and disconnect.
 *
 * Its state is `ConversationState | null`: one machine per conversation, null until that conversation's start
 * commits. The start is the one transition decided from null, and every other needs a started conversation. The
 * conversation a start closes is the previous machine's, so the start names it by id rather than deciding from it.
 */

/** A user's decision on a pending approval, from `deciderClientId`. */
export interface ApprovalDecisionEvent {
  kind: "approval_decision";
  origin: Origin;
  taskId: string;
  approvalId: string;
  decision: Decision;
  deciderClientId: string;
  /** The approval_resolved event, and the tool_dispatched event of a release. */
  ids: { resolved: string; dispatched: string };
}

/** An interruption of the task, asked for by its client or by shutdown. */
export interface InterruptTaskEvent {
  kind: "interrupt_task";
  origin: Origin;
  taskId: string;
  /**
   * The interruption_requested event, and the approval_resolved event of each approval pending when it was drawn,
   * keyed by approval id.
   */
  ids: { requested: string; resolved: ReadonlyMap<string, string> };
}

/** The runtime dropped the prompt it held for call `callId`. */
export interface PromptAbandonedEvent {
  kind: "prompt_abandoned";
  origin: Origin;
  taskId: string;
  callId: string;
  /** The approval_resolved event of the expiry, if its approval is still pending. */
  ids: { resolved: string };
}

/**
 * The ids a permission request may record, drawn before it is decided: the approval_resolved event of the approval
 * the superseded binding held, the proposal and revision of a new binding, the policy evaluation, the event recording
 * what the rule decided (the configuration error of an unlisted tool, the dispatch, or the approval request), and the
 * approval a request that asks creates.
 */
export interface PermissionIds {
  resolved: string;
  proposal: string;
  call: string;
  evaluation: string;
  outcome: string;
  approval: string;
}

/** The runtime asks whether it may run a tool call; see `permissionRequestTransition`. */
export interface PermissionRequestEvent {
  kind: "permission_request";
  origin: Origin;
  taskId: string;
  /** The runtime call id the runtime gave (null when it gave none), the tool it asks for, and its arguments. */
  request: { runtimeCallId: string | null; toolIdentity: string; input: unknown };
  /**
   * What the profile says for the tool, read at the boundary. Policy is exactly what the profile says: after an
   * interruption the next turn's Mia note tells the model which effects are unknown, and deciding whether a repeat
   * is safe is the model's job, not a reason to re-prompt an allowed tool.
   */
  policy: ToolCallPolicy;
  /** The server already holds as many prompts as it can (see `Holds.full`), read at the boundary. */
  promptsFull: boolean;
  ids: PermissionIds;
}

/** A refused permission request (see `PermissionRejection`), recorded as an error the client is told of. */
export interface PermissionRefusedEvent {
  kind: "permission_refused";
  origin: Origin;
  taskId: string;
  detail: string;
  ids: { event: string };
}

/**
 * The ids a runtime event may record, drawn before it is decided. Every event records `event`; a complete proposal
 * may also resolve the approval of the binding it supersedes (`resolved`) and propose a revision (`call`); a result
 * that binds no call records `unmatched`. A declared output's rows take the ids drawn with its capture, and each MCP
 * body the id drawn with its read.
 */
export interface RuntimeEventIds {
  event: string;
  resolved: string;
  call: string;
  unmatched: string;
}

/**
 * The ids of the rows a declared tool output records: its artifact, its links to the call and (retained) to the
 * task, and (retained) its artifact_registered event.
 */
export interface OutputIds {
  artifact: string;
  resultLink: string;
  outputLink: string;
  registered: string;
}

/**
 * A tool output a tool result declared, what reading and storing it produced (both done at the boundary, before the
 * result is decided, because they can take long), and the ids of the rows recording it.
 */
export interface CapturedOutput {
  ids: OutputIds;
  declared: DeclaredArtifact;
  retention: Retention;
}

type RuntimeEventOf<Type extends RuntimeEvent["type"]> = Extract<RuntimeEvent, { type: Type }>;

/**
 * A runtime event with what the boundary read for it before it was decided. A tool proposal carries the policy the
 * profile gives its tool. A tool result carries its declared output, captured and stored, and its MCP bodies, each
 * null when it read none. Every other event reads nothing.
 */
export type RuntimeReport =
  | { event: RuntimeEventOf<"tool_proposed">; policy: ToolCallPolicy }
  | {
      event: RuntimeEventOf<"tool_result">;
      output: CapturedOutput | null;
      bodies: readonly McpBodyRecord[] | null;
    }
  | { event: Exclude<RuntimeEvent, { type: "tool_proposed" | "tool_result" }> };

/** One event the runtime running the task's turn reported. */
export interface RuntimeEventReceived {
  kind: "runtime_event";
  origin: Origin;
  taskId: string;
  report: RuntimeReport;
  ids: RuntimeEventIds;
}

/** The ids a task submission records: its task and execution, and its task_submitted and task_started events. */
export interface SubmissionIds {
  task: string;
  execution: string;
  submitted: string;
  started: string;
}

/** The client submits text as the conversation's next task, answering command `commandId`. */
export interface TaskSubmittedEvent {
  kind: "submit_task";
  origin: Origin;
  text: string;
  clientId: string;
  commandId: string;
  /** The model and effort the profile requests for the task's execution, read at the boundary. */
  requested: { model: string; effort: Effort };
  ids: SubmissionIds;
}

/** The ids of the rows that register one artifact and link it to its task. */
export interface ArtifactIds {
  artifact: string;
  link: string;
}

/**
 * The ids a turn's end may record: the transcript's and the hook evidence's artifact and link, and the
 * interruption_outcome, task_finished and error events.
 */
export interface TurnEndIds {
  transcript: ArtifactIds;
  hooks: ArtifactIds;
  outcome: string;
  finished: string;
  error: string;
}

/** The MCP messages turn end records for a released call whose tool result never arrived. */
export interface UnresultedBodies {
  call: Pick<CallState, "id" | "runtimeCallId">;
  bodies: readonly McpBodyRecord[];
}

/**
 * The runtime running the task's turn has ended with `result`, and the boundary has read and stored what the turn
 * left, because reads and stores can take long: the transcript's retention (null when there was none), the hook
 * evidence and its retention (null when it held no records), and in debug mode the MCP bodies of each released call
 * whose result never arrived.
 */
export interface TurnEndedEvent {
  kind: "turn_ended";
  origin: Origin;
  taskId: string;
  result: TurnResult;
  transcript: Retention | null;
  hooks: { evidence: HookEvidence; retention: Retention | null };
  unresultedBodies: readonly UnresultedBodies[];
  /**
   * Every approval of the task the records still hold pending, read at the boundary just before the decision: not only
   * the ones in memory, because an abandonment whose commit failed left memory without its approval and the catalog
   * with a pending row (#165).
   */
  stillPending: readonly string[];
  ids: TurnEndIds;
}

/** A client reports its diagnostics about the conversation, over connection `from.connectionId`. */
export interface DiagnosticsReportedEvent {
  kind: "client_diagnostics";
  origin: Origin;
  from: { clientId: string; connectionId: string };
  diagnostics: ClientDiagnostics;
  /** The client_diagnostics event, and the diagnostics row that names it. */
  ids: { event: string; diagnostics: string };
}

/** The conversation's active connection `connectionId` closed. */
export interface ClientDisconnectedEvent {
  kind: "client_disconnected";
  origin: Origin;
  connectionId: string;
  ids: { event: string };
}

/**
 * The ids a conversation start records: the conversation, the id the runtime's session takes, and its
 * provenance_recorded, conversation_started and (in debug mode) captured_in_debug_mode events. Its provenance rows
 * take the ids named with the stored plan (`NamedProvenancePlan`).
 */
export interface StartIds {
  conversation: string;
  runtimeConversation: string;
  provenanceRecorded: string;
  started: string;
  captured: string;
}

/**
 * A client starts a conversation. The boundary has read the files that shape it and stored and named its provenance
 * before this is decided, because reads and stores can take long, and has checked that nothing forbids the start (a
 * running task, another client, shutdown), which only the previous conversation's state can tell.
 */
export interface ConversationStartEvent {
  kind: "start_conversation";
  /**
   * The client starting the conversation, and the connection it is reached through: the one that asked, or, when that
   * one closed while the start awaited its I/O, whichever its client has adopted since, or none.
   */
  origin: Origin;
  /** The conversation active until now, which the start's commit closes; null for the server's first. */
  closes: string | null;
  provenance: NamedProvenancePlan;
  /**
   * Where the agent prompt the provenance retains is stored (see `agentPromptObject`), or null when the prompt file
   * was missing. Every turn appends those very bytes: the runtime reads the retained object itself, so no second read
   * of the prompt file or copy of it can drift from the record.
   */
  promptFile: string | null;
  /** The catalog's root for conversation directories, under which the conversation's own is named. */
  conversationsRoot: string;
  /** Debug mode, chosen once per server start (see `EngineDeps.debugMode`). */
  debugMode: boolean;
  ids: StartIds;
}

export type ConversationEvent =
  | ConversationStartEvent
  | TaskSubmittedEvent
  | TurnEndedEvent
  | DiagnosticsReportedEvent
  | ClientDisconnectedEvent
  | ApprovalDecisionEvent
  | InterruptTaskEvent
  | PromptAbandonedEvent
  | PermissionRequestEvent
  | PermissionRefusedEvent
  | RuntimeEventReceived;

/** The event names a task that is not the conversation's: a command or callback of a task that has ended. */
type NoTask = { kind: "no_task" };

/** A start of a conversation that has already started: each conversation starts once. */
export type StartRejection = { kind: "already_started" };

/** An event of a conversation whose start has not committed: only a start can come first. */
type NotStarted = { kind: "not_started" };

export type ApprovalDecisionRejection = NoTask | { kind: "not_owner" } | { kind: "not_pending" };

export type InterruptionRejection =
  | NoTask
  | { kind: "already_interrupting" }
  /** The runtime already exited; its turn is being recorded as it ended, so there is nothing left to stop. */
  | { kind: "runtime_ended" }
  | { kind: "invalid"; taskStatus: TaskStatus };

/**
 * `no_call`: the task holds no such call. `not_pending`: the approval was already resolved, so nothing expires. The
 * runtime is denied all the same.
 */
export type AbandonmentRejection = NoTask | { kind: "no_call" } | { kind: "not_pending" };

/**
 * `refused`: the request binds to no new call, because it names no runtime call id or repeats a call already awaiting
 * approval, so nothing is proposed or approved. The runtime gets `answer` whatever else happens, and the boundary
 * records `detail` as a follow-up event (`permissionRefusedTransition`) whose failure leaves the answer as it is.
 */
export type PermissionRejection =
  NoTask | { kind: "refused"; detail: string; answer: PermissionDecision };

/**
 * `runtime_ended`: the task's runtime has ended and its turn is being recorded, so the event is dropped. The runtime
 * hands over its exit before the turn ends, so only an event left pending when a stuck runtime was abandoned gets
 * here, and the turn is recorded without it.
 */
export type RuntimeEventRejection = NoTask | { kind: "runtime_ended" };

/** `busy`: the conversation already runs a task, with the approvals it holds pending, in request order. */
export type SubmissionRejection = {
  kind: "busy";
  taskId: string;
  status: TaskStatus;
  pendingApprovals: readonly string[];
};

export type ConversationRejection =
  | StartRejection
  | NotStarted
  | SubmissionRejection
  | NoTask
  | ApprovalDecisionRejection
  | InterruptionRejection
  | AbandonmentRejection
  | PermissionRejection
  | RuntimeEventRejection;

/** What one transition decides: a refusal, which commits nothing, or the next state with its records and effects. */
export type ConversationDecision<Rejection = ConversationRejection> = MachineDecision<
  ConversationState,
  Rejection,
  EngineRecord,
  EngineEffect
>;

/** One kind of event's transition, with the rejections only that kind can have. */
export type ConversationTransition<Event, Rejection> = (input: {
  state: ConversationState;
  event: Event;
  now: Date;
}) => ConversationDecision<Rejection>;

const rejected = <Rejection>(rejection: Rejection): { kind: "rejected"; rejection: Rejection } => ({
  kind: "rejected",
  rejection,
});

/** A user's decision is recorded before any release; the held call changes and is answered only after the commit. */
export const approvalDecisionTransition: ConversationTransition<
  ApprovalDecisionEvent,
  ApprovalDecisionRejection
> = ({ state, event, now }) => {
  const { task } = state;
  if (task?.id !== event.taskId) return rejected({ kind: "no_task" });
  const { approvalId, ids } = event;
  const pending = pendingCall(task, approvalId);
  const outcome = decideApproval({
    decision: event.decision,
    ownerClientId: task.clientId,
    deciderClientId: event.deciderClientId,
    call: pending,
    task: {
      status: task.status,
      gateOpen: task.gateOpen,
      epoch: task.epoch,
      otherPending: otherPending(task, pending ? approvalId : null),
    },
    conversationEpoch: state.epoch,
  });
  return match(outcome)
    .with({ kind: "not_owner" }, () => rejected<ApprovalDecisionRejection>({ kind: "not_owner" }))
    .with({ kind: "not_pending" }, () =>
      rejected<ApprovalDecisionRejection>({ kind: "not_pending" }),
    )
    .with({ kind: "decided" }, (decided) => {
      const { call, change } = decided;
      const draft = new TransitionDraft({ state, now, origin: event.origin });
      draft.emit(
        draft.approvalResolved(task, { approvalId, callId: call.id, status: decided.approval }),
        {
          ...taskLinks(task),
          id: ids.resolved,
        },
      );
      draft.write({
        kind: "update_approval",
        id: approvalId,
        fields: {
          status: decided.approval,
          consumedAt: draft.at,
          decisionEventId: ids.resolved,
          decisionClientId: event.deciderClientId,
        },
      });
      if (decided.release)
        draft.recordDispatch(task, call, {
          id: ids.dispatched,
          via: "approval",
          causedBy: ids.resolved,
        });
      else draft.recordCallChange(change);
      draft.recordTaskStatus(task, decided.taskStatus);
      draft.advanceTask(task.id, (next) => withoutPending(next, approvalId));
      draft.commitCallChange(task, change, { notify: true });
      return draft.accepted();
    })
    .exhaustive();
};

/** Whether the decision on `approvalId` released its call, in the state that decision left. */
export const releasedBy = (state: ConversationState, approvalId: string): boolean =>
  (state.task ? callsOf(state.task) : []).some(
    (call) => call.approvalId === approvalId && call.status === "dispatched",
  );

/** The id drawn for `key`; one missing is a bug at the boundary that drew them, and fails the transition. */
const drawn = (ids: ReadonlyMap<string, string>, key: string): string => {
  const id = ids.get(key);
  if (id === undefined) throw new Error(`no id was drawn for ${key}`);
  return id;
};

/**
 * Atomically: close the gate, advance the epoch, invalidate the pending approvals, and record the order in the
 * interruption_requested event; the runtime is interrupted once that has committed.
 */
export const interruptionTransition: ConversationTransition<
  InterruptTaskEvent,
  InterruptionRejection
> = ({ state, event, now }) => {
  const { task } = state;
  if (task?.id !== event.taskId) return rejected({ kind: "no_task" });
  const { ids } = event;
  const outcome = decideInterruption({
    taskStatus: task.status,
    runtimeEnded: task.runtimeEnded,
    conversationEpoch: state.epoch,
    pending: [...task.pendingApprovals.keys()].flatMap((approvalId) => {
      const call = pendingCall(task, approvalId);
      return call ? [{ approvalId, call, resolvedEventId: drawn(ids.resolved, approvalId) }] : [];
    }),
  });
  return match(outcome)
    .with({ kind: "already_interrupting" }, () =>
      rejected<InterruptionRejection>({ kind: "already_interrupting" }),
    )
    .with({ kind: "runtime_ended" }, () =>
      rejected<InterruptionRejection>({ kind: "runtime_ended" }),
    )
    .with({ kind: "invalid" }, ({ taskStatus }) =>
      rejected<InterruptionRejection>({ kind: "invalid", taskStatus }),
    )
    .with({ kind: "interrupt" }, (interruption) => {
      const draft = new TransitionDraft({ state, now, origin: event.origin });
      draft.emit(
        {
          type: "interruption_requested",
          payload: {
            conversation_id: state.id,
            task_id: task.id,
            execution_epoch: interruption.epoch,
          },
        },
        { ...taskLinks(task), id: ids.requested },
      );
      for (const change of interruption.approvals)
        draft.recordApprovalChange(task, change, { decisionEventId: ids.requested });
      draft.write({
        kind: "update_task",
        id: task.id,
        fields: { status: interruption.task.status },
      });
      draft.advance({ ...draft.draft, epoch: interruption.epoch });
      draft.advanceTask(task.id, (next) => ({
        ...next,
        ...interruption.task,
        pendingApprovals: new Map(),
      }));
      for (const { change } of interruption.calls) {
        draft.recordCallChange(change);
        draft.commitCallChange(task, change, { notify: true });
      }
      draft.effect({ kind: "interrupt_runtime", taskId: task.id });
      return draft.accepted();
    })
    .exhaustive();
};

/**
 * The runtime dropped a held prompt: a still-pending approval expires and its call is invalidated, so no later
 * decision can release it, and the call is remembered as abandoned for the next turn's note. The runtime has
 * already been denied (`abandonedPromptDenial`), so nothing is answered here.
 */
export const abandonmentTransition: ConversationTransition<
  PromptAbandonedEvent,
  AbandonmentRejection
> = ({ state, event, now }) => {
  const { task } = state;
  if (task?.id !== event.taskId) return rejected({ kind: "no_task" });
  const { callId } = event;
  const call = callById(task, callId);
  if (!call) return rejected({ kind: "no_call" });
  const { approvalId } = call;
  const expire = decideAbandonment({
    call,
    approvalId,
    pending: approvalId !== null && task.pendingApprovals.has(approvalId),
    task: { status: task.status, otherPending: otherPending(task, approvalId) },
    resolvedEventId: event.ids.resolved,
  });
  if (!expire) return rejected({ kind: "not_pending" });
  const draft = new TransitionDraft({ state, now, origin: event.origin });
  draft.recordApprovalChange(task, expire.approval);
  draft.recordCallChange(expire.call);
  draft.write({ kind: "update_task", id: task.id, fields: { status: expire.taskStatus } });
  draft.advance(
    withTask(draft.draft, task.id, (next) => {
      const invalidated = withoutPending(
        withCall(next, callId, { status: expire.call.status }),
        expire.approval.approvalId,
      );
      return { ...invalidated, status: expire.taskStatus, abandoned: [...next.abandoned, callId] };
    }),
  );
  return draft.accepted();
};

/** A new binding revision to propose, with the ids drawn for it. */
interface NewCall {
  id: string;
  runtimeCallId: string;
  toolIdentity: string;
  digest: string;
  args: unknown;
  policy: ToolCallPolicy;
  proposalEventId: string | null;
}

/** Record a new binding revision of `task`, the latest of its runtime call id in the draft. */
const proposeCall = (draft: TransitionDraft, task: TaskState, input: NewCall): CallState => {
  const { id, runtimeCallId, toolIdentity, digest, policy, proposalEventId } = input;
  const revision = (task.calls.get(runtimeCallId)?.at(-1)?.revision ?? 0) + 1;
  const redactedArguments = redactValue(input.args);
  draft.write({
    kind: "create_tool_call",
    input: {
      id,
      createdAt: draft.at,
      conversationId: draft.draft.id,
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
    },
  });
  const call: CallState = {
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
  draft.advanceTask(task.id, (next) => withRevision(next, call));
  return call;
};

/**
 * Invalidate a held earlier binding of `task` and any pending approval it carries, recorded by the approval_resolved
 * event `resolvedEventId` names. An earlier binding already released or refused is left as it is.
 */
const supersede = (
  draft: TransitionDraft,
  task: TaskState,
  input: {
    last: CallState;
    next: { toolIdentity: string; digest: string };
    resolvedEventId: string;
  },
): void => {
  const { last, next, resolvedEventId } = input;
  const superseded = supersedeBinding({
    call: last,
    next,
    task: { status: task.status, otherPending: otherPending(task, last.approvalId) },
    resolvedEventId,
  });
  if (!superseded) return;
  const { approval, call, taskStatus } = superseded;
  if (approval) {
    draft.recordApprovalChange(task, approval);
    draft.advanceTask(task.id, (pending) => withoutPending(pending, approval.approvalId));
  }
  draft.recordCallChange(call);
  draft.commitCallChange(task, call);
  draft.recordTaskStatus(task, taskStatus);
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
 * Record what the permission rule decided for a bound call, and move the draft to the status the call takes: what
 * that answers the runtime.
 */
const recordPermission = (
  draft: TransitionDraft,
  input: {
    task: TaskState;
    call: CallState;
    rule: PermissionRule;
    ids: Pick<PermissionIds, "evaluation" | "outcome" | "approval">;
  },
): PermissionAnswer => {
  const { task, call, rule, ids } = input;
  const opts = { ...taskLinks(task), id: ids.outcome };
  return match(rule)
    .with({ kind: "deny" }, (denial): PermissionAnswer => {
      if (denial.unlisted)
        draft.emit(
          {
            type: "error",
            payload: {
              code: "configuration_error",
              message: `tool ${call.toolIdentity} is not listed in toolPolicy; call denied`,
              conversation_id: draft.draft.id,
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
      draft.recordCallChange(change);
      draft.commitCallChange(task, change);
      const { message } = denial;
      return {
        kind: "answer",
        decision: denial.interrupt
          ? { behavior: "deny", message, interrupt: true }
          : { behavior: "deny", message },
      };
    })
    .with({ kind: "dispatch" }, (): PermissionAnswer => {
      draft.recordDispatch(task, call, {
        id: ids.outcome,
        via: "policy",
        causedBy: ids.evaluation,
      });
      draft.advanceTask(task.id, (next) => withCall(next, call.id, { status: "dispatched" }));
      return { kind: "answer", decision: { behavior: "allow" } };
    })
    .with({ kind: "ask" }, (): PermissionAnswer => {
      const approvalId = ids.approval;
      draft.emit(
        {
          type: "approval_requested",
          payload: {
            conversation_id: draft.draft.id,
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
      draft.write(
        {
          kind: "create_approval",
          input: {
            id: approvalId,
            requestedAt: draft.at,
            toolCallId: call.id,
            executionEpoch: task.epoch,
            requestingEventId: ids.outcome,
          },
        },
        {
          kind: "update_tool_call",
          id: call.id,
          fields: { updatedAt: draft.at, status: "awaiting_approval" },
        },
      );
      draft.advanceTask(task.id, (next) =>
        withPending(
          withCall(next, call.id, { status: "awaiting_approval", approvalId }),
          approvalId,
          call.id,
        ),
      );
      draft.recordTaskStatus(task, "awaiting_approval");
      return { kind: "hold", approvalId, callId: call.id };
    })
    .exhaustive();
};

/**
 * The runtime asks whether it may run a tool call. The request binds to its runtime call id: it reuses a revision
 * the stream only proposed, or supersedes a changed one and proposes a new revision. Then the permission rule
 * (policy, the action gate, the held prompts' cap) decides, and its evaluation and outcome are recorded. The
 * runtime's answer is the one `answer_permission` effect, queued last: a denial or a release at once, or a hold
 * under the approval requested, which the boundary places only once the request has committed.
 */
export const permissionRequestTransition: ConversationTransition<
  PermissionRequestEvent,
  PermissionRejection
> = ({ state, event, now }) => {
  const { task } = state;
  if (task?.id !== event.taskId) return rejected({ kind: "no_task" });
  const { request, policy, ids } = event;
  const { runtimeCallId, toolIdentity } = request;
  // An empty id binds to nothing either: the bridge accepts one.
  if (!runtimeCallId)
    return rejected({
      kind: "refused",
      detail: `permission request for ${toolIdentity} carried no runtime call id; rejected`,
      answer: {
        behavior: "deny",
        message: "Mia cannot bind this call to a runtime call id; rejected.",
      },
    });
  const digest = canonicalDigest(request.input);
  const last = task.calls.get(runtimeCallId)?.at(-1);
  const binding = bindPermissionRequest(last, { toolIdentity, digest });
  if (binding.kind === "duplicate")
    return rejected({
      kind: "refused",
      detail: `permission request for ${toolIdentity} (${runtimeCallId}) ${binding.detail}; denied`,
      answer: binding.settle,
    });
  const rule = evaluatePermission({
    policy,
    gateOpen: task.gateOpen,
    toolIdentity,
    promptsFull: event.promptsFull,
  });
  const draft = new TransitionDraft({ state, now, origin: event.origin });
  const opts = taskLinks(task);
  const proposeBinding = (): CallState => {
    if (last)
      supersede(draft, task, {
        last,
        next: { toolIdentity, digest },
        resolvedEventId: ids.resolved,
      });
    draft.record(
      "tool_proposed",
      {
        runtime_call_id: runtimeCallId,
        tool_identity: toolIdentity,
        redacted_arguments: redactValue(request.input),
        argument_digest: digest,
        source: "permission_request",
      },
      { ...opts, id: ids.proposal },
    );
    return proposeCall(draft, task, {
      id: ids.call,
      runtimeCallId,
      toolIdentity,
      digest,
      args: request.input,
      policy,
      proposalEventId: ids.proposal,
    });
  };
  const bound = binding.kind === "reuse" ? binding.call : proposeBinding();
  draft.record(
    "policy_evaluated",
    {
      tool_call_id: bound.id,
      tool_identity: bound.toolIdentity,
      policy,
      gate_open: task.gateOpen,
      execution_epoch: task.epoch,
      binding_revision: bound.revision,
    },
    { ...opts, id: ids.evaluation },
  );
  const answer = recordPermission(draft, { task, call: bound, rule, ids });
  draft.notifyCall(task.id, bound.id);
  draft.effect({ kind: "answer_permission", answer });
  return draft.accepted();
};

/** Tell the client of a refused permission request: a runtime failure, recorded under the task. */
export const permissionRefusedTransition: ConversationTransition<
  PermissionRefusedEvent,
  NoTask
> = ({ state, event, now }) => {
  const { task } = state;
  if (task?.id !== event.taskId) return rejected({ kind: "no_task" });
  const draft = new TransitionDraft({ state, now, origin: event.origin });
  draft.emit(
    {
      type: "error",
      payload: {
        code: "runtime_failure",
        message: event.detail,
        conversation_id: state.id,
        task_id: task.id,
      },
    },
    { ...taskLinks(task), id: event.ids.event },
  );
  return draft.accepted();
};

/**
 * Record a declared tool output whatever its capture status, with the tool result `eventId` that declared it.
 * Retention was decided at the boundary, so these rows only record that outcome. Only a retained tool output
 * becomes a task output and gets an artifact_registered event.
 */
const registerToolOutput = (
  draft: TransitionDraft,
  input: { output: CapturedOutput; task: TaskState; call: CallState; eventId: string },
): void => {
  const { output, task, call, eventId } = input;
  const { ids, declared, retention } = output;
  const conversationId = draft.draft.id;
  const artifactId = ids.artifact;
  draft.write(
    {
      kind: "register_artifact",
      input: {
        id: artifactId,
        createdAt: draft.at,
        kind: "tool_output",
        logicalName: declared.name ?? declared.path,
        mimeType: declared.mimeType ?? "application/octet-stream",
        producerExecutionId: task.executionId,
        producerEventId: eventId,
        originalPath: declared.path,
        externalLocator: retention.status === "retained" ? null : declared.path,
        ...captureFields(retention),
      },
    },
    {
      kind: "link_artifact",
      input: {
        id: ids.resultLink,
        conversationId,
        artifactId,
        relation: "tool_result",
        toolCallId: call.id,
        taskId: task.id,
      },
    },
  );
  if (retention.status === "retained") {
    const { stored } = retention;
    draft.write({
      kind: "link_artifact",
      input: {
        id: ids.outputLink,
        conversationId,
        artifactId,
        relation: "task_output",
        taskId: task.id,
      },
    });
    draft.record(
      "artifact_registered",
      {
        artifact_id: artifactId,
        tool_call_id: call.id,
        digest: stored.digest,
        size: stored.byteCount,
        original_path: declared.path,
      },
      { id: ids.registered, taskId: task.id, executionId: task.executionId, causedBy: eventId },
    );
  }
};

/**
 * Record one event the runtime reported, against the task as it is now. Most are evidence only. An init names the
 * reported model and marks the session started; a complete proposal attaches to the revision it announces or
 * supersedes the held one and proposes a new revision; a tool result completes or fails the call it binds to, with
 * its declared output and MCP bodies as the boundary read them.
 */
export const runtimeEventTransition: ConversationTransition<
  RuntimeEventReceived,
  RuntimeEventRejection
> = ({ state, event: received, now }) => {
  const { task } = state;
  if (task?.id !== received.taskId) return rejected({ kind: "no_task" });
  if (task.runtimeEnded) return rejected({ kind: "runtime_ended" });
  const { ids } = received;
  const draft = new TransitionDraft({ state, now, origin: received.origin });
  const links = taskLinks(task);
  const opts = { ...links, id: ids.event };
  match(received.report)
    .with({ event: { type: "runtime_started" } }, ({ event: started }) => {
      draft.record("runtime_started", { pid: started.pid, launch: started.launch }, opts);
    })
    .with({ event: { type: "runtime_init" } }, ({ event: { init } }) => {
      draft.record("runtime_init", init.evidence, opts);
      draft.write({
        kind: "update_execution",
        id: task.executionId,
        fields: { reportedModel: init.model },
      });
      draft.advance({ ...draft.draft, sessionStarted: true });
      draft.advanceTask(task.id, (next) => ({ ...next, reportedModel: init.model }));
    })
    .with({ event: { type: "text_delta" } }, ({ event: delta }) => {
      draft.emit(
        {
          type: "text_delta",
          payload: {
            conversation_id: state.id,
            task_id: task.id,
            execution_id: task.executionId,
            text: delta.text,
          },
        },
        opts,
      );
    })
    .with({ event: { type: "tool_proposed" } }, ({ event: proposed, policy }) => {
      if (!proposed.complete) {
        draft.record(
          "tool_proposal_started",
          { runtime_call_id: proposed.runtimeCallId, tool_identity: proposed.toolIdentity },
          opts,
        );
        return;
      }
      const digest = canonicalDigest(proposed.arguments);
      draft.record(
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
        draft.write({
          kind: "update_tool_call",
          id: binding.call.id,
          fields: { updatedAt: draft.at, proposalEventId: ids.event },
        });
        return;
      }
      const last = revisions.at(-1);
      if (last)
        supersede(draft, task, {
          last,
          next: { toolIdentity: proposed.toolIdentity, digest },
          resolvedEventId: ids.resolved,
        });
      const call = proposeCall(draft, task, {
        id: ids.call,
        runtimeCallId: proposed.runtimeCallId,
        toolIdentity: proposed.toolIdentity,
        digest,
        args: proposed.arguments,
        policy,
        proposalEventId: ids.event,
      });
      draft.notifyCall(task.id, call.id);
    })
    .with({ event: { type: "assistant_message" } }, ({ event: message }) => {
      draft.record("assistant_message", message.message, opts);
    })
    .with({ event: { type: "tool_result" } }, ({ event: toolResult, output, bodies }) => {
      draft.record(
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
        draft.record(
          "tool_result_unmatched",
          { runtime_call_id: toolResult.runtimeCallId },
          { ...links, id: ids.unmatched },
        );
        return;
      }
      const { call } = binding;
      const status = statusAfterResult(call.status, toolResult.isError);
      draft.write({
        kind: "update_tool_call",
        id: call.id,
        fields: { updatedAt: draft.at, status, resultEventId: ids.event },
      });
      if (status === "completed" && output)
        registerToolOutput(draft, { output, task, call, eventId: ids.event });
      for (const body of bodies ?? [])
        draft.record(
          MCP_BODY_EVENT[body.direction],
          mcpPayload({ toolCallId: call.id, runtimeCallId: call.runtimeCallId }, body),
          { ...links, id: body.eventId, causedBy: ids.event },
        );
      draft.advanceTask(task.id, (next) => withCall(next, call.id, { status }));
      draft.notifyCall(task.id, call.id);
    })
    .with({ event: { type: "turn_result" } }, ({ event: { summary } }) => {
      draft.record("runtime_result", summary.evidence, opts);
      draft.write({
        kind: "update_execution",
        id: task.executionId,
        fields: {
          usage: {
            usage: summary.usage,
            totalCostUsd: summary.totalCostUsd,
            durationMs: summary.durationMs,
            durationApiMs: summary.durationApiMs,
            numTurns: summary.numTurns,
          },
        },
      });
    })
    .with({ event: { type: "runtime_stderr" } }, ({ event: stderr }) => {
      draft.record("runtime_stderr", { text: stderr.text }, opts);
    })
    .with({ event: { type: "malformed_event" } }, ({ event: malformed }) => {
      draft.emit(
        {
          type: "error",
          payload: {
            code: "runtime_failure",
            message: `malformed runtime event: ${malformed.error}`,
            conversation_id: state.id,
            task_id: task.id,
          },
        },
        opts,
      );
    })
    .with({ event: { type: "runtime_exit" } }, ({ event: exit }) => {
      draft.record("runtime_exit", { code: exit.code, signal: exit.signal }, opts);
    })
    .exhaustive();
  return draft.accepted();
};

/** The runtime every execution runs in. */
const RUNTIME_IDENTITY = "claude-code";

/**
 * The client submits text as the conversation's next task, which only a conversation with no task accepts. The task
 * and its execution are recorded under the next epoch, and its runtime prompt carries the note the last turn left,
 * which the task takes over. The turn starts once that has committed (`start_turn`, queued last).
 */
export const taskSubmissionTransition: ConversationTransition<
  TaskSubmittedEvent,
  SubmissionRejection
> = ({ state, event, now }) => {
  const { task } = state;
  if (task)
    return rejected({
      kind: "busy",
      taskId: task.id,
      status: task.status,
      pendingApprovals: [...task.pendingApprovals.keys()],
    });
  const { text, ids } = event;
  const epoch = state.epoch + 1;
  const note = state.pendingNote;
  const prompt = note ? `${note}\n\n${text}` : text;
  const draft = new TransitionDraft({ state, now, origin: event.origin });
  draft.write(
    {
      kind: "create_task",
      input: {
        id: ids.task,
        createdAt: draft.at,
        conversationId: state.id,
        text,
        clientId: event.clientId,
      },
    },
    {
      kind: "create_execution",
      input: {
        id: ids.execution,
        startedAt: draft.at,
        taskId: ids.task,
        conversationId: state.id,
        runtimeIdentity: RUNTIME_IDENTITY,
        runtimeConversationId: state.runtimeConversationId,
        requestedModel: event.requested.model,
        requestedEffort: event.requested.effort,
        provenanceSetId: state.provenanceSetId,
        executionEpoch: epoch,
      },
    },
  );
  const links = { taskId: ids.task, executionId: ids.execution };
  draft.record(
    "task_submitted",
    { text, runtime_prompt: prompt, mia_note: note, command_id: event.commandId },
    { ...links, id: ids.submitted },
  );
  draft.emit(
    {
      type: "task_started",
      payload: {
        conversation_id: state.id,
        task_id: ids.task,
        execution_id: ids.execution,
        execution_epoch: epoch,
        text,
      },
    },
    { ...links, id: ids.started },
  );
  draft.advance({
    ...state,
    epoch,
    turnCount: state.turnCount + 1,
    pendingNote: null,
    task: {
      id: ids.task,
      executionId: ids.execution,
      epoch,
      status: "running",
      gateOpen: true,
      interrupted: false,
      runtimeEnded: false,
      calls: new Map(),
      pendingApprovals: new Map(),
      abandoned: [],
      clientId: event.clientId,
      reportedModel: null,
    },
  });
  draft.effect({ kind: "start_turn", turn: { taskId: ids.task, prompt } });
  return draft.accepted();
};

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
const effortLevels = (hooks: readonly Record<string, unknown>[]): string[] => {
  const levels = hooks.map(effortLevelOf);
  return [...new Set(levels.filter((level): level is string => typeof level === "string"))];
};

/** An artifact a finished turn retains for its task, with the object its bytes were stored as or why they were not. */
interface TurnEvidence {
  ids: ArtifactIds;
  kind: ArtifactKind;
  name: string;
  relation: Extract<LinkRelation, "runtime_transcript" | "task_output">;
  originalPath: string | null;
  retention: Retention;
}

/**
 * Register one piece of a finished turn's evidence, linked to its task. Retention was decided before the turn's end
 * was (the boundary stored the bytes), so these rows only record that outcome and commit or fail with the turn's end.
 */
const registerEvidence = (
  draft: TransitionDraft,
  input: { task: TaskState; evidence: TurnEvidence },
): void => {
  const { task, evidence } = input;
  const artifactId = evidence.ids.artifact;
  draft.write(
    {
      kind: "register_artifact",
      input: {
        id: artifactId,
        createdAt: draft.at,
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
        conversationId: draft.draft.id,
        artifactId,
        relation: evidence.relation,
        taskId: task.id,
      },
    },
  );
};

/**
 * The note a task's turn leaves for the next one, from the task as its end finds it (see `noteAfterTurn`). The
 * boundary sets it whether or not the turn's end commits, because it is how the next turn learns what may have
 * happened; it is memory only until that turn records it with its task_submitted.
 */
export const turnNote = (task: TaskState): string | null =>
  noteAfterTurn({
    interrupted: task.interrupted,
    actions: classifyActions(callsOf(task), task.interrupted),
    abandoned: task.abandoned.flatMap((callId) => callById(task, callId) ?? []),
  });

/**
 * The runtime's turn has ended: every call takes its final status (a released call whose result never arrived is
 * unknown, a held one can never run), the approvals the records still hold pending expire, the evidence the boundary
 * stored is registered, and the execution and task end, with the outcome of an interruption and the error of a
 * failure. The task leaves the state only once the boundary has answered its held prompts (`TURN_ENDED`).
 */
export const turnEndTransition: ConversationTransition<TurnEndedEvent, NoTask> = ({
  state,
  event,
  now,
}) => {
  const { task } = state;
  if (task?.id !== event.taskId) return rejected({ kind: "no_task" });
  const { result, hooks, ids } = event;
  const draft = new TransitionDraft({ state, now, origin: event.origin });
  const opts = taskLinks(task);
  const actions = classifyActions(callsOf(task), task.interrupted);
  const unknown = actions.some((action) => action.status === "unknown");
  const { status, error } = classifyTask({ interrupted: task.interrupted, result, unknown });
  const efforts = effortLevels(hooks.evidence.records);
  for (const action of actions)
    draft.write({
      kind: "update_tool_call",
      id: action.tool_call_id,
      fields: { updatedAt: draft.at, status: action.status, detail: action.detail },
    });
  for (const { call, bodies } of event.unresultedBodies)
    for (const body of bodies)
      draft.record(
        MCP_BODY_EVENT[body.direction],
        mcpPayload({ toolCallId: call.id, runtimeCallId: call.runtimeCallId }, body),
        { ...opts, id: body.eventId },
      );
  for (const approvalId of event.stillPending)
    draft.write({
      kind: "update_approval",
      id: approvalId,
      fields: { status: "expired", consumedAt: draft.at, reason: "task ended" },
    });
  if (event.transcript)
    registerEvidence(draft, {
      task,
      evidence: {
        ids: ids.transcript,
        kind: "runtime_transcript",
        name: `turn-${state.turnCount}.stream.jsonl`,
        relation: "runtime_transcript",
        originalPath: result.streamLogPath,
        retention: event.transcript,
      },
    });
  if (hooks.retention)
    registerEvidence(draft, {
      task,
      evidence: {
        ids: ids.hooks,
        kind: "effort_evidence",
        name: `turn-${state.turnCount}.hooks.jsonl`,
        relation: "task_output",
        originalPath: null,
        retention: hooks.retention,
      },
    });
  draft.write({
    kind: "update_execution",
    id: task.executionId,
    fields: {
      status: executionStatusFor(task.interrupted, result),
      endedAt: draft.at,
      reportedModel: task.reportedModel,
      reportedEffort: efforts.length === 1 ? (efforts[0] ?? null) : null,
      effortEvidence: {
        source: "PreToolUse hook",
        values: efforts,
        samples: hooks.evidence.records.length,
        malformed_lines: hooks.evidence.malformedLines,
        read_error: hooks.evidence.readError,
        note: effortNote(hooks.evidence),
      },
    },
  });
  if (task.interrupted)
    draft.emit(
      {
        type: "interruption_outcome",
        payload: {
          conversation_id: state.id,
          task_id: task.id,
          task_status: status,
          actions,
          runtime_cancellation: result.runtimeCancellation,
        },
      },
      { ...opts, id: ids.outcome },
    );
  draft.write({
    kind: "update_task",
    id: task.id,
    fields: { status, finishedAt: draft.at },
  });
  draft.emit(
    {
      type: "task_finished",
      payload: {
        conversation_id: state.id,
        task_id: task.id,
        status,
        ...(error ? { error } : {}),
        usage: result.summary?.usage ?? undefined,
      },
    },
    { ...opts, id: ids.finished },
  );
  if (error)
    draft.emit(
      {
        type: "error",
        payload: {
          code: "runtime_failure",
          message: error,
          conversation_id: state.id,
          task_id: task.id,
        },
      },
      { ...opts, id: ids.error },
    );
  const finalStatus = new Map(actions.map((action) => [action.tool_call_id, action.status]));
  draft.advanceTask(task.id, (next) => ({
    ...withCallStatuses(next, finalStatus),
    pendingApprovals: new Map(),
    status,
  }));
  return draft.accepted();
};

/**
 * A client's diagnostics about the conversation: the client_diagnostics event, under the task if there is one, and the
 * diagnostics row that names it, committed together. A report about no conversation, or another one, is not this
 * machine's to decide; the boundary records its row alone.
 */
export const diagnosticsTransition: ConversationTransition<DiagnosticsReportedEvent, never> = ({
  state,
  event,
  now,
}) => {
  const { from, diagnostics, ids } = event;
  const taskId = state.task?.id ?? null;
  const draft = new TransitionDraft({ state, now, origin: event.origin });
  draft.record(
    "client_diagnostics",
    {
      client_id: from.clientId,
      captured_at: diagnostics.captured_at,
      connection_state: diagnostics.connection_state,
    },
    { id: ids.event, taskId },
  );
  draft.write({
    kind: "record_diagnostics",
    input: {
      id: ids.diagnostics,
      receivedAt: draft.at,
      conversationId: state.id,
      clientId: from.clientId,
      clientConnectionId: from.connectionId,
      taskId,
      eventId: ids.event,
      capturedAt: diagnostics.captured_at,
      state: diagnostics,
    },
  });
  return draft.accepted();
};

/**
 * The active connection closed. Disconnection is not consent: pending approvals stay pending, and the event lists
 * them, in request order, under the task if there is one.
 */
export const disconnectTransition: ConversationTransition<ClientDisconnectedEvent, never> = ({
  state,
  event,
  now,
}) => {
  const draft = new TransitionDraft({ state, now, origin: event.origin });
  draft.record(
    "client_disconnected",
    {
      connection_id: event.connectionId,
      pending_approvals: [...(state.task?.pendingApprovals.keys() ?? [])],
    },
    { id: event.ids.event, taskId: state.task?.id ?? null },
  );
  return draft.accepted();
};

/**
 * Start the conversation: its provenance rows, the conversation that names them and its links to them, the close of
 * the conversation it replaces, then its provenance_recorded and conversation_started events, and in debug mode
 * captured_in_debug_mode, all in one commit. It decides from no conversation (null); one already started refuses it.
 */
export const conversationStartTransition = (input: {
  state: ConversationState | null;
  event: ConversationStartEvent;
  now: Date;
}): ConversationDecision<StartRejection> => {
  const { state, event, now } = input;
  if (state !== null) return rejected({ kind: "already_started" });
  const { ids, provenance: plan } = event;
  const draft = new TransitionDraft({ state: null, now, origin: event.origin });
  const startedAt = draft.at;
  const { records: provenanceRows, summary: provenance } = provenanceRecords(plan, startedAt);
  const conversationId = ids.conversation;
  draft.write(...provenanceRows, {
    kind: "create_conversation",
    input: {
      id: conversationId,
      startedAt,
      provenanceSetId: provenance.provenance_set_id,
      runtimeConversationId: ids.runtimeConversation,
    },
  });
  draft.write(...provenanceLinks({ conversationId, plan }));
  if (event.closes !== null)
    draft.write({ kind: "update_conversation", id: event.closes, fields: { status: "closed" } });
  draft.advance({
    id: conversationId,
    runtimeConversationId: ids.runtimeConversation,
    provenanceSetId: provenance.provenance_set_id,
    directory: conversationDirectory({
      root: event.conversationsRoot,
      id: conversationId,
      startedAt,
    }),
    promptFile: event.promptFile,
    turnCount: 0,
    sessionStarted: false,
    epoch: 0,
    pendingNote: null,
    task: null,
  });
  draft.record("provenance_recorded", provenance, { id: ids.provenanceRecorded });
  draft.emit(
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
  if (event.debugMode) draft.record("captured_in_debug_mode", {}, { id: ids.captured });
  return draft.accepted();
};

/** Decide with `transition` over a started conversation; before its start commits, nothing but a start is decided. */
const whenStarted = (
  state: ConversationState | null,
  transition: (started: ConversationState) => ConversationDecision,
): ConversationDecision => (state === null ? rejected({ kind: "not_started" }) : transition(state));

/** Every transition of one conversation, as its kernel machine's `decide`, from before its start (null). */
export const decideConversation: Decide<
  ConversationState | null,
  ConversationEvent,
  ConversationRejection,
  EngineRecord,
  EngineEffect
> = ({ state, event, now }) =>
  match(event)
    .with({ kind: "start_conversation" }, (start): ConversationDecision =>
      conversationStartTransition({ state, event: start, now }),
    )
    .with({ kind: "submit_task" }, (submitted) =>
      whenStarted(state, (started) =>
        taskSubmissionTransition({ state: started, event: submitted, now }),
      ),
    )
    .with({ kind: "turn_ended" }, (ended) =>
      whenStarted(state, (started) => turnEndTransition({ state: started, event: ended, now })),
    )
    .with({ kind: "client_diagnostics" }, (reported) =>
      whenStarted(state, (started) =>
        diagnosticsTransition({ state: started, event: reported, now }),
      ),
    )
    .with({ kind: "client_disconnected" }, (disconnected) =>
      whenStarted(state, (started) =>
        disconnectTransition({ state: started, event: disconnected, now }),
      ),
    )
    .with({ kind: "approval_decision" }, (decision) =>
      whenStarted(state, (started) =>
        approvalDecisionTransition({ state: started, event: decision, now }),
      ),
    )
    .with({ kind: "interrupt_task" }, (interruption) =>
      whenStarted(state, (started) =>
        interruptionTransition({ state: started, event: interruption, now }),
      ),
    )
    .with({ kind: "prompt_abandoned" }, (abandoned) =>
      whenStarted(state, (started) =>
        abandonmentTransition({ state: started, event: abandoned, now }),
      ),
    )
    .with({ kind: "permission_request" }, (request) =>
      whenStarted(state, (started) =>
        permissionRequestTransition({ state: started, event: request, now }),
      ),
    )
    .with({ kind: "permission_refused" }, (refused) =>
      whenStarted(state, (started) =>
        permissionRefusedTransition({ state: started, event: refused, now }),
      ),
    )
    .with({ kind: "runtime_event" }, (received) =>
      whenStarted(state, (started) =>
        runtimeEventTransition({ state: started, event: received, now }),
      ),
    )
    .exhaustive();
