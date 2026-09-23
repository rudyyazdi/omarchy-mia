import { match } from "ts-pattern";
import type { PermissionDecision, TurnResult } from "@mia/agent-adapter";
import type {
  ApprovalStatus,
  Decision,
  EventPayload,
  TaskStatus,
  ToolCallStatus,
} from "@mia/protocol";
import type { ExecutionStatus, ToolCallPolicy } from "@mia/records";

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

/** A pending approval resolved without a user decision. */
export interface ApprovalChange {
  approvalId: string;
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

/** A permission request reuses the latest revision only if it is still held with the same tool and arguments. */
export const bindsToLatest = (
  latest: { status: ToolCallStatus; toolIdentity: string; digest: string },
  request: { toolIdentity: string; digest: string },
): boolean =>
  isHeld(latest.status) &&
  latest.digest === request.digest &&
  latest.toolIdentity === request.toolIdentity;

/**
 * Changed arguments under the same runtime call id: a held earlier binding, and its pending approval, can
 * never release anything. Null when the earlier binding was already released or refused.
 */
export const supersedeBinding = (
  call: CallFacts & { approvalId: string | null },
): { approval: ApprovalChange | null; call: CallChange } | null => {
  if (!isHeld(call.status)) return null;
  const reason = "arguments changed";
  return {
    approval: call.approvalId
      ? { approvalId: call.approvalId, callId: call.id, status: "invalidated", reason }
      : null,
    call: {
      callId: call.id,
      status: "invalidated",
      detail: "superseded by a new binding revision",
      settle: {
        behavior: "deny",
        message: "Mia invalidated the earlier approval: the arguments changed.",
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
      status: "denied" | "blocked_gate";
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

/** Policy first, then the action gate: a denied tool stays denied whatever the gate. */
export const evaluatePermission = (input: {
  policy: ToolCallPolicy;
  gateOpen: boolean;
  toolIdentity: string;
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
  return input.policy === "allow" ? { kind: "dispatch" } : { kind: "ask" };
};

// ---------------------------------------------------------------- approval

/** Generic over the caller's call type so the decided call comes back as the caller's own. */
export type ApprovalOutcome<Call extends CallFacts = CallFacts> =
  | { kind: "not_owner" }
  | { kind: "not_pending" }
  | {
      kind: "decided";
      approval: "approved" | "rejected";
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
  task: { status: TaskStatus; gateOpen: boolean; epoch: number };
  conversationEpoch: number;
  /** Pending approvals left once this one is resolved. */
  otherPending: number;
}): ApprovalOutcome<Call> => {
  if (input.deciderClientId !== input.ownerClientId) return { kind: "not_owner" };
  const { call, task } = input;
  if (!call || call.status !== "awaiting_approval") return { kind: "not_pending" };
  const approve = input.decision === "approve";
  const release = approve && task.gateOpen && task.epoch === input.conversationEpoch;
  const taskStatus =
    input.otherPending === 0 && task.status === "awaiting_approval" ? "running" : task.status;
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
  conversationEpoch: number;
  pending: readonly { approvalId: string; call: Call }[];
}): InterruptionOutcome<Call> => {
  if (input.taskStatus === "interrupting") return { kind: "already_interrupting" };
  if (input.taskStatus !== "running" && input.taskStatus !== "awaiting_approval")
    return { kind: "invalid", taskStatus: input.taskStatus };
  return {
    kind: "interrupt",
    epoch: input.conversationEpoch + 1,
    task: { status: "interrupting", gateOpen: false, interrupted: true },
    approvals: input.pending.map(({ approvalId, call }) => ({
      approvalId,
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
 * its call is invalidated; either way the call is refused, never released.
 */
export const decideAbandonment = (input: {
  call: CallFacts;
  approvalId: string | null;
  pending: boolean;
}): {
  expire: { approval: ApprovalChange; call: CallChange } | null;
  settle: PermissionDecision;
} => {
  const settle: PermissionDecision = {
    behavior: "deny",
    message: `Mia: the approval prompt for ${input.call.toolIdentity} was abandoned before the user decided. This call was never released and did not run; its outcome is known, not unknown. Do not retry it.`,
  };
  if (!input.approvalId || !input.pending) return { expire: null, settle };
  return {
    expire: {
      approval: {
        approvalId: input.approvalId,
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

/** A result settles a released call; it never revives one already refused, invalidated, or settled. */
export const statusAfterResult = (status: ToolCallStatus, isError: boolean): ToolCallStatus => {
  if (TERMINAL.has(status)) return status;
  return isError ? "failed" : "completed";
};

/** Final status of every call: released-without-result is unknown; anything still held can never run. */
export const classifyActions = (
  calls: readonly CallFacts[],
  interrupted: boolean,
): InterruptionAction[] =>
  calls.map((call) => {
    const status = ((): ToolCallStatus => {
      if (call.status === "dispatched") return "unknown";
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
