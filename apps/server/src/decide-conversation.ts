import { match } from "ts-pattern";
import type { PermissionDecision, RuntimeEvent } from "@mia/agent-adapter";
import type { Decide, Decision as MachineDecision } from "@mia/kernel";
import {
  canonicalDigest,
  redactValue,
  type Decision,
  type TaskStatus,
  type ToolCallPolicy,
} from "@mia/protocol";
import { mcpPayload } from "@mia/records";
import { captureFields, type DeclaredArtifact, type Retention } from "./artifact-capture.ts";
import {
  callById,
  callsOf,
  otherPending,
  pendingCall,
  withCall,
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
import { TransitionDraft, taskLinks, type Origin } from "./transition-draft.ts";
import {
  bindPermissionRequest,
  bindStreamProposal,
  bindToolResult,
  decideAbandonment,
  decideApproval,
  decideInterruption,
  evaluatePermission,
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
 * test checks it directly. So far it covers how approvals end (a user's decision, an interruption, and the runtime
 * abandoning a held prompt), the runtime's permission requests, and the events the runtime reports.
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

/**
 * What the boundary read for a runtime event before it was decided. Only a tool result reads its declared output
 * and its MCP bodies, and only a tool proposal reads the policy the profile gives its tool; null where nothing was
 * read.
 */
export interface RuntimeEventReads {
  output: CapturedOutput | null;
  bodies: readonly McpBodyRecord[] | null;
  policy: ToolCallPolicy | null;
}

/** One event the runtime running the task's turn reported. */
export interface RuntimeEventReceived {
  kind: "runtime_event";
  origin: Origin;
  taskId: string;
  event: RuntimeEvent;
  reads: RuntimeEventReads;
  ids: RuntimeEventIds;
}

export type ConversationEvent =
  | ApprovalDecisionEvent
  | InterruptTaskEvent
  | PromptAbandonedEvent
  | PermissionRequestEvent
  | PermissionRefusedEvent
  | RuntimeEventReceived;

/** The event names a task that is not the conversation's: a command or callback of a task that has ended. */
type NoTask = { kind: "no_task" };

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

export type ConversationRejection =
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
  if (runtimeCallId === null)
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

/** The policy the boundary read for a complete proposal's tool; one missing is a bug there, and fails the transition. */
const readPolicy = (reads: RuntimeEventReads, toolIdentity: string): ToolCallPolicy => {
  if (reads.policy === null) throw new Error(`no policy was read for ${toolIdentity}`);
  return reads.policy;
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
  const { ids, reads } = received;
  const draft = new TransitionDraft({ state, now, origin: received.origin });
  const links = taskLinks(task);
  const opts = { ...links, id: ids.event };
  match(received.event)
    .with({ type: "runtime_started" }, (started) => {
      draft.record("runtime_started", { pid: started.pid, launch: started.launch }, opts);
    })
    .with({ type: "runtime_init" }, ({ init }) => {
      draft.record("runtime_init", init.evidence, opts);
      draft.write({
        kind: "update_execution",
        id: task.executionId,
        fields: { reportedModel: init.model },
      });
      draft.advance({ ...draft.draft, sessionStarted: true });
      draft.advanceTask(task.id, (next) => ({ ...next, reportedModel: init.model }));
    })
    .with({ type: "text_delta" }, (delta) => {
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
    .with({ type: "tool_proposed" }, (proposed) => {
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
        policy: readPolicy(reads, proposed.toolIdentity),
        proposalEventId: ids.event,
      });
      draft.notifyCall(task.id, call.id);
    })
    .with({ type: "assistant_message" }, (message) => {
      draft.record("assistant_message", message.message, opts);
    })
    .with({ type: "tool_result" }, (toolResult) => {
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
      if (status === "completed" && reads.output)
        registerToolOutput(draft, { output: reads.output, task, call, eventId: ids.event });
      for (const body of reads.bodies ?? [])
        draft.record(
          MCP_BODY_EVENT[body.direction],
          mcpPayload({ toolCallId: call.id, runtimeCallId: call.runtimeCallId }, body),
          { ...links, id: body.eventId, causedBy: ids.event },
        );
      draft.advanceTask(task.id, (next) => withCall(next, call.id, { status }));
      draft.notifyCall(task.id, call.id);
    })
    .with({ type: "turn_result" }, ({ summary }) => {
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
    .with({ type: "runtime_stderr" }, (stderr) => {
      draft.record("runtime_stderr", { text: stderr.text }, opts);
    })
    .with({ type: "malformed_event" }, (malformed) => {
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
    .with({ type: "runtime_exit" }, (exit) => {
      draft.record("runtime_exit", { code: exit.code, signal: exit.signal }, opts);
    })
    .exhaustive();
  return draft.accepted();
};

/** Every transition of the conversation, as one kernel machine's `decide`. */
export const decideConversation: Decide<
  ConversationState,
  ConversationEvent,
  ConversationRejection,
  EngineRecord,
  EngineEffect
> = ({ state, event, now }) =>
  match(event)
    .with({ kind: "approval_decision" }, (decision): ConversationDecision =>
      approvalDecisionTransition({ state, event: decision, now }),
    )
    .with({ kind: "interrupt_task" }, (interruption): ConversationDecision =>
      interruptionTransition({ state, event: interruption, now }),
    )
    .with({ kind: "prompt_abandoned" }, (abandoned): ConversationDecision =>
      abandonmentTransition({ state, event: abandoned, now }),
    )
    .with({ kind: "permission_request" }, (request): ConversationDecision =>
      permissionRequestTransition({ state, event: request, now }),
    )
    .with({ kind: "permission_refused" }, (refused): ConversationDecision =>
      permissionRefusedTransition({ state, event: refused, now }),
    )
    .with({ kind: "runtime_event" }, (received): ConversationDecision =>
      runtimeEventTransition({ state, event: received, now }),
    )
    .exhaustive();
