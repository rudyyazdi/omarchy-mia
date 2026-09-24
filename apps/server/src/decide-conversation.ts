import { match } from "ts-pattern";
import type { Decide, Decision as MachineDecision } from "@mia/kernel";
import type { Decision, TaskStatus } from "@mia/protocol";
import {
  callById,
  callsOf,
  otherPending,
  pendingCall,
  withCall,
  withTask,
  withoutPending,
  type ConversationState,
} from "./conversation-state.ts";
import type { EngineEffect } from "./engine-effects.ts";
import type { EngineRecord } from "./engine-records.ts";
import { TransitionDraft, taskLinks, type Origin } from "./transition-draft.ts";
import { decideAbandonment, decideApproval, decideInterruption } from "./transitions.ts";

/**
 * The conversation machine: what a command or runtime callback does to the conversation, as a pure `decide` over its
 * state (see `ConversationState`). Each transition composes the rules of ./transitions.ts into the records to commit,
 * the effects to perform once they have, and the next state, and every id it may record comes in with its event,
 * drawn at the boundary. It reads nothing else and changes nothing, so the engine commits what it returns and a
 * test checks it directly. So far it covers how approvals end: a user's decision, an interruption, and the runtime
 * abandoning a held prompt.
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

export type ConversationEvent = ApprovalDecisionEvent | InterruptTaskEvent | PromptAbandonedEvent;

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

export type ConversationRejection =
  ApprovalDecisionRejection | InterruptionRejection | AbandonmentRejection;

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
    .exhaustive();
