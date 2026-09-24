import { match } from "ts-pattern";
import { z } from "zod";
import { parseJson } from "./catalog.ts";
import type {
  ApprovalRow,
  ConversationRow,
  EventRow,
  ExecutionRow,
  SnapshotTables,
  TaskRow,
  ToolCallRow,
} from "./schema.ts";

/**
 * The read model behind `mia debug watch` (issue #6): a conversation's rows as a tree of
 * conversation → task → tool call, with the raw events kept at the level they belong to, and the
 * same tree as a stream of entries ordered by `events.sequence`, so a live view that has shown
 * everything up to sequence N asks only for the entries after N.
 */

/** The rows the read model reads; a `ConversationSnapshot`'s tables satisfy it. */
export type WatchRows = Pick<
  SnapshotTables,
  "conversations" | "tasks" | "executions" | "events" | "tool_calls" | "approvals"
>;

export type WatchConversationParent = { level: "conversation" };
export type WatchTaskParent = { level: "task"; task_id: string };
export type WatchToolCallParent = { level: "tool_call"; task_id: string; tool_call_id: string };
/** The tree node an entry is appended under. */
export type WatchParent = WatchConversationParent | WatchTaskParent | WatchToolCallParent;

/**
 * One addition to the tree. `sequence` is the event sequence that introduced it: a task and a tool
 * call enter with the first event that belongs to them and sort before it.
 *
 * Row fields (statuses, details, approvals, usage) are as of the read, and entries only ever add:
 * the engine changes some of them with no event of their own (a call's status and detail, the
 * approvals a finished task expires), so a view that follows entries must refresh the rows it
 * already shows to stay equal to a fresh read.
 */
export type WatchEntry =
  | {
      kind: "task";
      sequence: number;
      parent: WatchConversationParent;
      task: TaskRow;
      executions: ExecutionRow[];
    }
  | {
      kind: "tool_call";
      sequence: number;
      parent: WatchTaskParent;
      tool_call: ToolCallRow;
      approvals: ApprovalRow[];
    }
  | { kind: "event"; sequence: number; parent: WatchParent; event: EventRow };

export interface WatchToolCall {
  tool_call: ToolCallRow;
  approvals: ApprovalRow[];
  events: EventRow[];
}

export interface WatchTask {
  task: TaskRow;
  executions: ExecutionRow[];
  tool_calls: WatchToolCall[];
  /** The task's events that belong to none of its tool calls. */
  events: EventRow[];
}

export interface WatchTree {
  conversation: ConversationRow;
  /** See `capturedInDebugMode`. */
  captured_in_debug_mode: boolean;
  tasks: WatchTask[];
  /** Events of no known task. */
  events: EventRow[];
}

/**
 * Whether the conversation was captured in debug mode, so a view can mark detail only debug mode records as
 * "not recorded" instead of leaving a silent gap. The engine records one `captured_in_debug_mode` event in the
 * transaction that starts the conversation when debug mode is on, and nothing when it is off, so every read that
 * sees the conversation already sees the flag, and it never changes afterwards.
 */
export const capturedInDebugMode = (rows: Pick<WatchRows, "events">): boolean =>
  rows.events.some((event) => event.type === "captured_in_debug_mode");

/** A stored payload that names the tool call it is about (policy, dispatch and approval events). */
const NamesToolCall = z.object({ tool_call_id: z.string() });
/** A `tool_proposed` payload: the binding it announces. */
const Proposal = z.object({
  runtime_call_id: z.string(),
  tool_identity: z.string(),
  argument_digest: z.string(),
});

const bindingKey = (binding: {
  execution_id: string | null;
  runtime_call_id: string;
  tool_identity: string;
  argument_digest: string;
}) =>
  JSON.stringify([
    binding.execution_id,
    binding.runtime_call_id,
    binding.tool_identity,
    binding.argument_digest,
  ]);

/**
 * Which tool call each event belongs to, taking the first of these that is a call of the event's
 * own (known) task: the call its payload names; the call whose row references it (the proposal and
 * the result, whose payloads carry only the runtime's call id); for a `tool_proposed` event, the
 * only call of its execution with the binding it announces.
 *
 * The last one keeps a call's first event from moving. A later stream line announcing the same
 * binding re-points the call's `proposal_event_id` at itself, and without it the earlier proposal,
 * which may be the call's first event, would drop out of the call and move its entry past a
 * sequence a view already showed. Events recorded before the call exists (`tool_proposal_started`)
 * stay with the task, for the same reason.
 */
const toolCallOfEvents = (
  rows: WatchRows,
  taskIds: ReadonlySet<string>,
): Map<string, ToolCallRow> => {
  const calls = new Map(
    rows.tool_calls.filter((call) => taskIds.has(call.task_id)).map((call) => [call.id, call]),
  );
  const referenced = new Map<string, ToolCallRow>();
  for (const call of calls.values())
    for (const eventId of [call.proposal_event_id, call.dispatch_event_id, call.result_event_id])
      if (eventId) referenced.set(eventId, call);
  const byBinding = Map.groupBy(calls.values(), bindingKey);
  const announced = (event: EventRow, payload: unknown): ToolCallRow | undefined => {
    const proposal = Proposal.safeParse(payload);
    if (event.type !== "tool_proposed" || !proposal.success) return undefined;
    const matches = byBinding.get(
      bindingKey({ ...proposal.data, execution_id: event.execution_id }),
    );
    return matches?.length === 1 ? matches[0] : undefined;
  };
  const owners = new Map<string, ToolCallRow>();
  for (const event of rows.events) {
    const payload = parseJson(event.payload);
    const named = NamesToolCall.safeParse(payload);
    const call = [
      named.success ? calls.get(named.data.tool_call_id) : undefined,
      referenced.get(event.id),
      announced(event, payload),
    ].find((candidate) => candidate?.task_id === event.task_id);
    if (call) owners.set(event.id, call);
  }
  return owners;
};

const parentOf = (call: ToolCallRow | undefined, taskId: string | null): WatchParent => {
  if (call) return { level: "tool_call", task_id: call.task_id, tool_call_id: call.id };
  if (taskId !== null) return { level: "task", task_id: taskId };
  return { level: "conversation" };
};

const KIND_ORDER: Record<WatchEntry["kind"], number> = { task: 0, tool_call: 1, event: 2 };

/** Records the lowest sequence seen per id. */
const firstSequences = () => {
  const first = new Map<string, number>();
  return {
    note: (id: string, sequence: number) => {
      const known = first.get(id);
      if (known === undefined || sequence < known) first.set(id, sequence);
    },
    get: (id: string) => first.get(id),
  };
};

/**
 * Every entry of the conversation, in the order a live view appends them. A task or tool call with
 * no event of its own (the engine always records one in the transaction that creates it) enters
 * with its parent: a task at sequence 0, before every event, a tool call with its task.
 */
const allEntries = (rows: WatchRows): WatchEntry[] => {
  const taskIds = new Set(rows.tasks.map((task) => task.id));
  const owners = toolCallOfEvents(rows, taskIds);
  const taskFirst = firstSequences();
  const callFirst = firstSequences();
  const eventEntries = rows.events.map((event): WatchEntry => {
    const call = owners.get(event.id);
    const taskId = event.task_id !== null && taskIds.has(event.task_id) ? event.task_id : null;
    if (taskId !== null) taskFirst.note(taskId, event.sequence);
    if (call) callFirst.note(call.id, event.sequence);
    return { kind: "event", sequence: event.sequence, parent: parentOf(call, taskId), event };
  });
  const taskEntries = rows.tasks.map((task): WatchEntry => ({
    kind: "task",
    sequence: taskFirst.get(task.id) ?? 0,
    parent: { level: "conversation" },
    task,
    executions: rows.executions.filter((execution) => execution.task_id === task.id),
  }));
  const callEntries = rows.tool_calls
    .filter((call) => taskIds.has(call.task_id))
    .map((call): WatchEntry => ({
      kind: "tool_call",
      sequence: callFirst.get(call.id) ?? taskFirst.get(call.task_id) ?? 0,
      parent: { level: "task", task_id: call.task_id },
      tool_call: call,
      approvals: rows.approvals.filter((approval) => approval.tool_call_id === call.id),
    }));
  // Array.prototype.sort is stable, so rows keep their catalog order within one sequence and kind.
  return [...taskEntries, ...callEntries, ...eventEntries].sort(
    (left, right) =>
      left.sequence - right.sequence || KIND_ORDER[left.kind] - KIND_ORDER[right.kind],
  );
};

/**
 * The entries a view that has shown every entry up to `afterSequence` has not seen yet, in the
 * order to append them; -1 asks for all of them (a task with no event enters at 0).
 *
 * An event keeps its own sequence, and a task or tool call the sequence of the first event that
 * belongs to it, which the engine commits with it, so polling with the last sequence shown neither
 * repeats an entry nor skips one. Several entries share a sequence (a task, its first event), so a
 * view marks a sequence shown only once it has all of that sequence's entries.
 *
 * It reads the conversation's whole history, since a node's first event can be anywhere in it:
 * a poll costs a snapshot of the conversation, which a single-user debug view can afford.
 */
export const watchEntriesAfter = (rows: WatchRows, afterSequence: number): WatchEntry[] =>
  allEntries(rows).filter((entry) => entry.sequence > afterSequence);

/**
 * The whole conversation as a tree: what a view shows before it starts following new entries. It
 * is the entries appended in order, so it always agrees with `watchEntriesAfter(rows, -1)`; a
 * parent's entry sorts before every entry under it, so each lookup below finds its node.
 */
/** A node an entry is appended under; a missing one is a broken ordering, never a dropped entry. */
const nodeOf = <Node>(nodes: ReadonlyMap<string, Node>, id: string): Node => {
  const node = nodes.get(id);
  if (!node) throw new Error(`watch entry for ${id} came before its parent's entry`);
  return node;
};

export const watchTree = (rows: WatchRows): WatchTree => {
  const conversation = rows.conversations[0];
  if (!conversation) throw new Error("the rows hold no conversation");
  const tree: WatchTree = {
    conversation,
    captured_in_debug_mode: capturedInDebugMode(rows),
    tasks: [],
    events: [],
  };
  const tasks = new Map<string, WatchTask>();
  const calls = new Map<string, WatchToolCall>();
  const appendEvent = (parent: WatchParent, event: EventRow) =>
    match(parent)
      .with({ level: "conversation" }, () => tree.events.push(event))
      .with({ level: "task" }, ({ task_id }) => nodeOf(tasks, task_id).events.push(event))
      .with({ level: "tool_call" }, ({ tool_call_id }) =>
        nodeOf(calls, tool_call_id).events.push(event),
      )
      .exhaustive();
  for (const entry of allEntries(rows))
    match(entry)
      .with({ kind: "task" }, ({ task, executions }) => {
        const node: WatchTask = { task, executions, tool_calls: [], events: [] };
        tasks.set(task.id, node);
        tree.tasks.push(node);
      })
      .with({ kind: "tool_call" }, ({ parent, tool_call, approvals }) => {
        const node: WatchToolCall = { tool_call, approvals, events: [] };
        calls.set(tool_call.id, node);
        nodeOf(tasks, parent.task_id).tool_calls.push(node);
      })
      .with({ kind: "event" }, ({ parent, event }) => appendEvent(parent, event))
      .exhaustive();
  return tree;
};
