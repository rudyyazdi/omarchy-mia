import { match } from "ts-pattern";
import type { PermissionDecision, TurnResult } from "@mia/agent-adapter";
import type {
  ApprovalStatus,
  Decision,
  EventPayload,
  TaskStatus,
  ToolCallPolicy,
  ToolCallStatus,
} from "@mia/protocol";
import type { ExecutionStatus } from "@mia/records";

/**
 * Task and tool-call rules as pure functions over plain data. Each returns what should change; the engine
 * commits the records, applies the change to its state only after the commit succeeds, and then performs
 * the effects (answering the runtime's held prompt, notifying the client). A rule here never writes,
 * mutates, or calls back.
 */

/** A tool call as the rules see it. */
export interface CallFacts {
  id: string;
  toolIdentity: string;
  status: ToolCallStatus;
}

/**
 * One call's next status, the detail recorded with it, the detail shown with its client notification, and
 * the answer to the runtime's held prompt for it, if one is held.
 */
export interface CallChange {
  callId: string;
  status: ToolCallStatus;
  detail?: string;
  notice?: string;
  settle: PermissionDecision | null;
}

/**
 * A pending approval resolved without a user decision, and the id of the approval_resolved event that records it:
 * drawn before the decision, like every id a transition records, so the rule names the event without creating it.
 */
export interface ApprovalChange {
  approvalId: string;
  eventId: string;
  callId: string;
  status: Exclude<ApprovalStatus, "pending" | "approved" | "rejected">;
  reason: string;
}

export type InterruptionAction = EventPayload<"interruption_outcome">["actions"][number];

const TERMINAL: ReadonlySet<ToolCallStatus> = new Set([
  "denied",
  "blocked_gate",
  "invalidated",
  "completed",
  "failed",
  "cancelled",
  "unknown",
]);

/** A call not yet released or refused: the only kind a new binding revision or an interruption can invalidate. */
const isHeld = (status: ToolCallStatus): boolean =>
  status === "proposed" || status === "awaiting_approval";

/**
 * A task waits on the user only while an approval is pending, so resolving its last one resumes it, whether
 * the user decided, a new binding superseded it, or the runtime abandoned its prompt. Any status other than
 * awaiting_approval (an interruption in progress, a finished task) is left as it is.
 */
export const taskStatusAfterResolving = (
  status: TaskStatus,
  remainingPending: number,
): TaskStatus => (remainingPending === 0 && status === "awaiting_approval" ? "running" : status);

const detailFor = (status: ToolCallStatus): string | undefined =>
  match(status)
    .with("unknown", () => "released; no result observed; effect unknown")
    .with("blocked_gate", () => "not released: action gate closed")
    .with("invalidated", () => "never released: proposal or pending approval invalidated")
    .with(
      "proposed",
      "awaiting_approval",
      "permitted",
      "denied",
      "dispatched",
      "completed",
      "failed",
      "cancelled",
      () => undefined,
    )
    .exhaustive();

// ---------------------------------------------------------------- binding

/** What identifies a revision's binding: the tool and its canonical argument digest. */
interface BindingKey {
  toolIdentity: string;
  digest: string;
}

/** A report is the same call as a revision only if both tool and arguments match. */
const sameBinding = (revision: BindingKey, report: BindingKey): boolean =>
  revision.toolIdentity === report.toolIdentity && revision.digest === report.digest;

/**
 * How a complete stream proposal binds to its runtime call id. Every revision under the id is compared, latest
 * first, not only the latest: the permission request can arrive before its stream line, and a changed request
 * can open a later revision before the earlier one's line arrives. A matching proposal is that revision's
 * announcement whatever its status, so it attaches to it and supersedes nothing. Anything else proposes a new
 * revision.
 */
export type StreamBinding<Call> = { kind: "attach"; call: Call } | { kind: "propose" };

export const bindStreamProposal = <Call extends BindingKey>(
  revisions: readonly Call[],
  report: BindingKey,
): StreamBinding<Call> => {
  const call = revisions.findLast((revision) => sameBinding(revision, report));
  return call ? { kind: "attach", call } : { kind: "propose" };
};

/**
 * How a permission request binds to its runtime call id. It reuses the latest revision while that is still
 * only proposed with the same tool and arguments (the stream announced the call before the runtime asked).
 * A request identical to a revision already awaiting approval is a duplicate: it is refused without a second
 * approval, so a call never has two pending approvals and the first request stays held until the user
 * decides. Anything else (no revision yet, a changed tool or arguments, or a revision already released or
 * refused) proposes a new revision. Denying assumes the runtime still honours the first prompt: a runtime that
 * gives up on a prompt aborts it, which abandons the held call, so its retry proposes afresh instead.
 */
export type PermissionBinding<Latest> =
  | { kind: "reuse"; call: Latest }
  | { kind: "propose" }
  | { kind: "duplicate"; detail: string; settle: PermissionDecision };

export const bindPermissionRequest = <Latest extends BindingKey & { status: ToolCallStatus }>(
  latest: Latest | undefined,
  request: BindingKey,
): PermissionBinding<Latest> => {
  if (!latest || !isHeld(latest.status) || !sameBinding(latest, request))
    return { kind: "propose" };
  if (latest.status === "proposed") return { kind: "reuse", call: latest };
  return {
    kind: "duplicate",
    detail: "repeats a request already awaiting approval",
    settle: {
      behavior: "deny",
      message: `Mia denied this duplicate request for ${request.toolIdentity}: the same call is already awaiting the user's approval, and that request stays held.`,
    },
  };
};

/** A task as the rules that may resolve one of its approvals see it. */
export interface PendingTask {
  status: TaskStatus;
  /** Pending approvals left besides the one being resolved, if any. */
  otherPending: number;
}

/**
 * A changed tool or arguments under the same runtime call id: a held earlier binding, and its pending
 * approval, can never release anything. Null when the earlier binding was already released or refused.
 * The task status that results: invalidating the task's last pending approval resumes it, and a new
 * revision that asks again sets it back to awaiting_approval later in the same transaction.
 */
export const supersedeBinding = (input: {
  call: CallFacts & BindingKey & { approvalId: string | null };
  next: BindingKey;
  task: PendingTask;
  /** The approval_resolved event that records the invalidated approval, if the call holds one. */
  resolvedEventId: string;
}): { approval: ApprovalChange | null; call: CallChange; taskStatus: TaskStatus } | null => {
  const { call, next, task } = input;
  if (!isHeld(call.status)) return null;
  const changed = call.toolIdentity === next.toolIdentity ? "arguments" : "tool";
  const reason = `${changed} changed`;
  return {
    taskStatus: taskStatusAfterResolving(task.status, task.otherPending),
    approval: call.approvalId
      ? {
          approvalId: call.approvalId,
          eventId: input.resolvedEventId,
          callId: call.id,
          status: "invalidated",
          reason,
        }
      : null,
    call: {
      callId: call.id,
      status: "invalidated",
      detail: "superseded by a new binding revision",
      settle: {
        behavior: "deny",
        message: `Mia invalidated the earlier approval: the ${changed} changed.`,
      },
    },
  };
};

// ---------------------------------------------------------------- permission

export type PermissionRule =
  | { kind: "dispatch" }
  | { kind: "ask" }
  | {
      kind: "deny";
      status: Extract<ToolCallStatus, "denied" | "blocked_gate">;
      detail: string;
      message: string;
      /** Tell the runtime to stop the turn, not just skip the call. */
      interrupt: boolean;
      /** The profile does not list the tool: reported to the client as a configuration error. */
      unlisted: boolean;
    };

type Denial = Extract<PermissionRule, { kind: "deny" }>;

const deny = (
  fields: Omit<Denial, "kind" | "status" | "interrupt" | "unlisted"> & Partial<Denial>,
): Denial => ({
  kind: "deny",
  status: "denied",
  interrupt: false,
  unlisted: false,
  ...fields,
});

/**
 * Policy first, then the action gate: a denied tool stays denied whatever the gate. A call that would ask is
 * denied at once while the held prompts are at their cap, before any approval is recorded, so no approval is
 * ever requested that Mia cannot hold for the user's decision.
 */
export const evaluatePermission = (input: {
  policy: ToolCallPolicy;
  gateOpen: boolean;
  toolIdentity: string;
  /** As many prompts as the server holds at once are already waiting for a decision. */
  promptsFull: boolean;
}): PermissionRule => {
  if (input.policy === "unlisted")
    return deny({
      unlisted: true,
      detail: "tool not listed in toolPolicy",
      message: `Mia denied ${input.toolIdentity}: it is not part of the configured policy.`,
    });
  if (input.policy === "deny")
    return deny({
      detail: "denied by policy",
      message: `Mia denied ${input.toolIdentity}: policy forbids it.`,
    });
  if (!input.gateOpen)
    return deny({
      status: "blocked_gate",
      interrupt: true,
      detail: "action gate closed by interruption",
      message: "Mia blocked this call: the task is being interrupted.",
    });
  if (input.policy === "allow") return { kind: "dispatch" };
  if (input.promptsFull)
    return deny({
      detail: "not asked: too many approval prompts already waiting",
      message: `Mia denied ${input.toolIdentity} without asking: too many approval prompts are already waiting for the user. Ask again once they are decided.`,
    });
  return { kind: "ask" };
};

// ---------------------------------------------------------------- approval

/** Generic over the caller's call type so the decided call comes back as the caller's own. */
export type ApprovalOutcome<Call extends CallFacts = CallFacts> =
  | { kind: "not_owner" }
  | { kind: "not_pending" }
  | {
      kind: "decided";
      approval: Extract<ApprovalStatus, "approved" | "rejected">;
      /** Released only when approved while the gate is open in the task's own epoch. */
      release: boolean;
      call: Call;
      change: CallChange;
      taskStatus: TaskStatus;
    };

export const decideApproval = <Call extends CallFacts>(input: {
  decision: Decision;
  ownerClientId: string;
  deciderClientId: string;
  /** The call the approval holds, if it is still pending for this task. */
  call: Call | undefined;
  task: PendingTask & { gateOpen: boolean; epoch: number };
  conversationEpoch: number;
}): ApprovalOutcome<Call> => {
  if (input.deciderClientId !== input.ownerClientId) return { kind: "not_owner" };
  const { call, task } = input;
  if (!call || call.status !== "awaiting_approval") return { kind: "not_pending" };
  const approve = input.decision === "approve";
  const release = approve && task.gateOpen && task.epoch === input.conversationEpoch;
  const taskStatus = taskStatusAfterResolving(task.status, task.otherPending);
  const change = ((): Omit<CallChange, "callId"> => {
    if (release) return { status: "dispatched", settle: { behavior: "allow" } };
    if (approve)
      return {
        status: "blocked_gate",
        detail: "approved after the action gate closed; not released",
        notice: "approved after gate closed",
        settle: {
          behavior: "deny",
          message: "Mia blocked this call: the task was interrupted before it could be released.",
        },
      };
    return {
      status: "denied",
      detail: "rejected by user",
      notice: "rejected",
      settle: { behavior: "deny", message: "The user rejected this call. Do not retry it." },
    };
  })();
  return {
    kind: "decided",
    approval: approve ? "approved" : "rejected",
    release,
    call,
    change: { callId: call.id, ...change },
    taskStatus,
  };
};

// ---------------------------------------------------------------- interruption

export type InterruptionOutcome<Call extends CallFacts = CallFacts> =
  | { kind: "already_interrupting" }
  /** The runtime already exited; its turn is being recorded as it ended, so there is nothing left to stop. */
  | { kind: "runtime_ended" }
  | { kind: "invalid"; taskStatus: TaskStatus }
  | {
      kind: "interrupt";
      /** The conversation epoch the interruption advances to; approvals bound to an older epoch never release. */
      epoch: number;
      task: { status: "interrupting"; gateOpen: false; interrupted: true };
      approvals: ApprovalChange[];
      calls: { call: Call; change: CallChange }[];
    };

/** Close the gate, advance the epoch, and invalidate every pending approval without releasing its call. */
export const decideInterruption = <Call extends CallFacts>(input: {
  taskStatus: TaskStatus;
  /** The runtime's turn has ended, though the task is not yet recorded finished. */
  runtimeEnded: boolean;
  conversationEpoch: number;
  /** Each pending approval, with the approval_resolved event that records its invalidation. */
  pending: readonly { approvalId: string; call: Call; resolvedEventId: string }[];
}): InterruptionOutcome<Call> => {
  if (input.taskStatus === "interrupting") return { kind: "already_interrupting" };
  if (input.runtimeEnded) return { kind: "runtime_ended" };
  if (input.taskStatus !== "running" && input.taskStatus !== "awaiting_approval")
    return { kind: "invalid", taskStatus: input.taskStatus };
  return {
    kind: "interrupt",
    epoch: input.conversationEpoch + 1,
    task: { status: "interrupting", gateOpen: false, interrupted: true },
    approvals: input.pending.map(({ approvalId, call, resolvedEventId }) => ({
      approvalId,
      eventId: resolvedEventId,
      callId: call.id,
      status: "invalidated",
      reason: "interrupted",
    })),
    calls: input.pending.map(({ call }) => ({
      call,
      change: {
        callId: call.id,
        status: "invalidated",
        detail: "pending approval invalidated by interruption",
        notice: "interrupted",
        settle: {
          behavior: "deny",
          message: "Mia blocked this call: the user interrupted the task.",
          interrupt: true,
        },
      },
    })),
  };
};

// ---------------------------------------------------------------- abandonment

/**
 * The runtime dropped a held prompt (process gone or turn aborted). A still-pending approval expires and
 * its call is invalidated, which resumes the task if it was the last one pending; either way the call is
 * refused, never released.
 */
export const decideAbandonment = (input: {
  call: CallFacts;
  approvalId: string | null;
  pending: boolean;
  task: PendingTask;
  /** The approval_resolved event that records the expiry, if the approval is still pending. */
  resolvedEventId: string;
}): {
  expire: { approval: ApprovalChange; call: CallChange; taskStatus: TaskStatus } | null;
  settle: PermissionDecision;
} => {
  const settle: PermissionDecision = {
    behavior: "deny",
    message: `Mia: the approval prompt for ${input.call.toolIdentity} was abandoned before the user decided. This call was never released and did not run; its outcome is known, not unknown. Do not retry it.`,
  };
  if (!input.approvalId || !input.pending) return { expire: null, settle };
  return {
    expire: {
      taskStatus: taskStatusAfterResolving(input.task.status, input.task.otherPending),
      approval: {
        approvalId: input.approvalId,
        eventId: input.resolvedEventId,
        callId: input.call.id,
        status: "expired",
        reason: "runtime abandoned the prompt",
      },
      call: {
        callId: input.call.id,
        status: "invalidated",
        detail: "runtime abandoned the held call",
        settle: null,
      },
    },
    settle,
  };
};

// ---------------------------------------------------------------- results and completion

/** Released to the runtime: the only kind of call that can have run. */
export const isReleased = (status: ToolCallStatus): boolean =>
  status === "permitted" || status === "dispatched";

/** Refused before release: Mia answered its prompt, if any, without letting it run. */
const isRefused = (status: ToolCallStatus): boolean =>
  status === "denied" || status === "blocked_gate" || status === "invalidated";

/**
 * Which revision under a runtime call id a tool result binds to. The runtime can only have run a revision Mia
 * released, so the latest released one takes the result, even when a later revision (a stream line with another
 * binding) is still held. With none released, the latest refused revision takes it and keeps its status: that
 * is the runtime's error result for a refused prompt. A held revision never takes a result, so it is never
 * recorded as having run, and a settled one keeps the result it already has; with nothing else, the result is
 * unmatched.
 */
export type ResultBinding<Call> = { kind: "bind"; call: Call } | { kind: "unmatched" };

export const bindToolResult = <Call extends { status: ToolCallStatus }>(
  revisions: readonly Call[],
): ResultBinding<Call> => {
  const call =
    revisions.findLast((revision) => isReleased(revision.status)) ??
    revisions.findLast((revision) => isRefused(revision.status));
  return call ? { kind: "bind", call } : { kind: "unmatched" };
};

/** The statuses only a tool result gives a call (`statusAfterResult`). */
const TOOK_RESULT: ReadonlySet<ToolCallStatus> = new Set(["completed", "failed"]);

/**
 * The released calls whose tool result never arrived, at most one per runtime call id: for an id none of whose
 * revisions took a result, the latest released revision, the one its result would have bound to
 * (`bindToolResult`). In debug mode turn end reads these calls' MCP bodies, as their results would have. An id one
 * revision of which took a result gets none, even with another revision released: that result already read the
 * id's lines, and reading them again would record them twice.
 */
export const releasedWithoutResult = <Call extends { status: ToolCallStatus }>(
  revisionsById: Iterable<readonly Call[]>,
): Call[] =>
  Iterator.from(revisionsById)
    .flatMap((revisions) => {
      if (revisions.some((revision) => TOOK_RESULT.has(revision.status))) return [];
      const call = revisions.findLast((revision) => isReleased(revision.status));
      return call ? [call] : [];
    })
    .toArray();

/**
 * A result settles a released call; it never revives one already refused, invalidated, or settled, and never
 * completes one still held, which Mia never released.
 */
export const statusAfterResult = (status: ToolCallStatus, isError: boolean): ToolCallStatus => {
  if (TERMINAL.has(status) || isHeld(status)) return status;
  return isError ? "failed" : "completed";
};

/** Final status of every call: released-without-result is unknown; anything still held can never run. */
export const classifyActions = (
  calls: readonly CallFacts[],
  interrupted: boolean,
): InterruptionAction[] =>
  calls.map((call) => {
    const status = ((): ToolCallStatus => {
      if (isReleased(call.status)) return "unknown";
      if (isHeld(call.status)) return interrupted ? "blocked_gate" : "invalidated";
      return call.status;
    })();
    return {
      tool_call_id: call.id,
      tool_identity: call.toolIdentity,
      status,
      detail: detailFor(status),
    };
  });

/** Task status is separate from action outcomes: an interrupted or completed task with an unknown action is outcome_unknown. */
export const classifyTask = (input: {
  interrupted: boolean;
  result: Pick<TurnResult, "status" | "error">;
  unknown: boolean;
}): { status: TaskStatus; error?: string } => {
  const { interrupted, result, unknown } = input;
  if (interrupted) return { status: unknown ? "outcome_unknown" : "interrupted" };
  if (result.status === "completed") return { status: unknown ? "outcome_unknown" : "completed" };
  return {
    status: unknown ? "outcome_unknown" : "failed",
    error: result.error ?? "runtime failed",
  };
};

export const executionStatusFor = (
  interrupted: boolean,
  result: Pick<TurnResult, "status">,
): ExecutionStatus => {
  if (result.status === "completed") return "completed";
  return interrupted ? "killed" : "failed";
};

/**
 * The Mia-authored note carried into the next turn, or null when the turn needs none. The runtime's own
 * memory of a killed turn is incomplete (capability record L1); Mia's records are authoritative.
 */
export const noteAfterTurn = (input: {
  interrupted: boolean;
  actions: readonly InterruptionAction[];
  abandoned: readonly { toolIdentity: string; redactedArguments: unknown }[];
}): string | null => {
  const { interrupted, actions, abandoned } = input;
  if (interrupted || actions.some((action) => action.status === "unknown")) {
    const lines = actions
      .filter((action) => action.status !== "denied")
      .map(
        (action) =>
          `- ${action.tool_identity}: ${action.status}${action.detail ? ` (${action.detail})` : ""}`,
      );
    return `[Mia note, not from the user] Your previous turn was ${interrupted ? "interrupted by the user" : "ended by a runtime failure"}. Mia's records of tool calls in that turn:\n${lines.join("\n") || "- no tool calls"}\nAn "unknown" action may or may not have taken effect; do not repeat any of those actions unless the user asks again, and if they do, weigh whether a repeat could double an effect before calling.`;
  }
  if (abandoned.length === 0) return null;
  const lines = abandoned.map(
    (call) => `- ${call.toolIdentity} ${JSON.stringify(call.redactedArguments)}`,
  );
  return `[Mia note, not from the user] In your previous turn the runtime abandoned the approval prompt for these calls before the user decided:\n${lines.join("\n")}\nMia never released them: they did not run and their outcome is known (nothing happened), not unknown. If you reported otherwise, correct it. Do not retry them unless the user asks again.`;
};
