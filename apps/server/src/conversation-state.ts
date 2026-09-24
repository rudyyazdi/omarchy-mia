import type { TaskStatus, ToolCallPolicy, ToolCallStatus } from "@mia/protocol";

/**
 * What the engine holds in memory about the active conversation, as one immutable value: the conversation, its
 * task, the task's call revisions and pending approvals, and the epoch. Memory follows the records, so a
 * transition builds the next value beside its records and the conversation's kernel machine replaces the whole
 * value only once they commit; nothing here is ever mutated, so a failed commit leaves the value it started from
 * standing, and a callback that outlives a transition reads the value as it is now by id, never a stale copy it
 * kept. The runtime a task's turn runs in (its handle, the promise of its end) is a resource, not state, and lives
 * with the engine.
 */
export interface ConversationState {
  readonly id: string;
  readonly runtimeConversationId: string;
  readonly provenanceSetId: string;
  readonly directory: string;
  /**
   * The retained agent prompt object every turn of this conversation appends; null when the prompt file was missing
   * at start, so provenance recorded it unavailable and no turn appends one.
   */
  readonly promptFile: string | null;
  readonly turnCount: number;
  /**
   * A runtime has started this conversation's session, so the next turn resumes it instead of creating it. Set
   * when a turn's runtime_init commits, not from the turn count: a turn whose runtime never spawned (a failed
   * launch, or an interruption before spawn) leaves no session to resume. Keyed off the init event rather than
   * the spawn, so a runtime that exits before its init (rejecting its arguments or settings) leaves the session
   * to be created again; one that exits after init but before it persists the session still sets it. Only a
   * committed init sets it, as memory follows the records: if that commit fails, the next turn tries to create a
   * session that exists and fails, and the turn after resumes once its init commits.
   */
  readonly sessionStarted: boolean;
  readonly epoch: number;
  /** Mia-authored note carried into the next runtime turn after an interruption or unknown outcome. */
  readonly pendingNote: string | null;
  /** The one task the conversation runs, from its submission until its turn has ended and been recorded. */
  readonly task: TaskState | null;
}

export interface TaskState {
  readonly id: string;
  readonly executionId: string;
  readonly epoch: number;
  readonly status: TaskStatus;
  readonly gateOpen: boolean;
  readonly interrupted: boolean;
  /**
   * The runtime's turn has ended and finishTurn is recording it. Memory only: the task stays running in the
   * records until finishTurn commits, but nothing can be released to or interrupted in a runtime that is gone.
   */
  readonly runtimeEnded: boolean;
  /** Every binding revision under each runtime call id, oldest first, in the order the ids were first seen. */
  readonly calls: ReadonlyMap<string, readonly CallState[]>;
  /**
   * The id of the call each pending approval holds, keyed by approval id in the order the approvals were requested;
   * that order is the order a disconnect lists them in and an interruption resolves them in.
   */
  readonly pendingApprovals: ReadonlyMap<string, string>;
  /** The ids of the calls whose held approval prompt the runtime dropped before a decision; never released. */
  readonly abandoned: readonly string[];
  readonly clientId: string;
  readonly reportedModel: string | null;
}

export interface CallState {
  readonly id: string;
  readonly runtimeCallId: string;
  readonly revision: number;
  readonly toolIdentity: string;
  readonly digest: string;
  readonly redactedArguments: unknown;
  readonly policy: ToolCallPolicy;
  readonly status: ToolCallStatus;
  readonly approvalId: string | null;
}

/** Every revision of every call of the task, in the order `calls` holds them. */
export const callsOf = (task: TaskState): CallState[] => [
  ...task.calls.values().flatMap((revisions) => revisions),
];

/** The revision `callId` names, if the task has it. */
export const callById = (task: TaskState, callId: string): CallState | undefined =>
  callsOf(task).find((call) => call.id === callId);

/** The call a pending approval holds, or undefined when `approvalId` is not pending for this task. */
export const pendingCall = (task: TaskState, approvalId: string): CallState | undefined => {
  const callId = task.pendingApprovals.get(approvalId);
  return callId === undefined ? undefined : callById(task, callId);
};

/** Pending approvals the task has besides `approvalId`: what is left once that one is resolved. */
export const otherPending = (task: TaskState, approvalId: string | null): number =>
  task.pendingApprovals.size -
  (approvalId !== null && task.pendingApprovals.has(approvalId) ? 1 : 0);

/**
 * The state with its task replaced by `update` of it. The task must be the one `taskId` names: a transition only
 * changes the task it was decided for, so any other is a bug, and throwing fails its commit rather than let memory
 * drift from the records.
 */
export const withTask = (
  state: ConversationState,
  taskId: string,
  update: (task: TaskState) => TaskState,
): ConversationState => {
  if (state.task?.id !== taskId) throw new Error(`task ${taskId} is not the conversation's task`);
  return { ...state, task: update(state.task) };
};

/** The task with every revision replaced by `update` of it, keeping their order. */
const mapCalls = (task: TaskState, update: (call: CallState) => CallState): TaskState => ({
  ...task,
  calls: new Map(
    task.calls
      .entries()
      .map(([runtimeCallId, revisions]): [string, CallState[]] => [
        runtimeCallId,
        revisions.map(update),
      ]),
  ),
});

/** The task with the revision `callId` names changed by `fields`; a revision the task lacks is a bug, and throws. */
export const withCall = (
  task: TaskState,
  callId: string,
  fields: Partial<Pick<CallState, "status" | "approvalId">>,
): TaskState => {
  if (!callById(task, callId)) throw new Error(`call ${callId} is not a call of task ${task.id}`);
  return mapCalls(task, (call) => (call.id === callId ? { ...call, ...fields } : call));
};

/** The task with every revision given the status `statusOf` names for it, or keeping its own. */
export const withCallStatuses = (
  task: TaskState,
  statusOf: ReadonlyMap<string, ToolCallStatus>,
): TaskState =>
  mapCalls(task, (call) => ({ ...call, status: statusOf.get(call.id) ?? call.status }));

/** The task with `call` added as the latest revision under its runtime call id. */
export const withRevision = (task: TaskState, call: CallState): TaskState => {
  const calls = new Map(task.calls);
  calls.set(call.runtimeCallId, [...(task.calls.get(call.runtimeCallId) ?? []), call]);
  return { ...task, calls };
};

/** The task with approval `approvalId` pending on the call `callId` names, after every approval already pending. */
export const withPending = (task: TaskState, approvalId: string, callId: string): TaskState => {
  const pendingApprovals = new Map(task.pendingApprovals);
  pendingApprovals.set(approvalId, callId);
  return { ...task, pendingApprovals };
};

/** The task without approval `approvalId` among its pending ones. */
export const withoutPending = (task: TaskState, approvalId: string): TaskState => {
  const pendingApprovals = new Map(task.pendingApprovals);
  pendingApprovals.delete(approvalId);
  return { ...task, pendingApprovals };
};
