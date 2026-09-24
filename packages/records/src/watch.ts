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
 * call enter with their first event and sort before it. Row fields are as of the read; a later
 * change (a status, an approval) arrives as the event that recorded it, not as a second entry.
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
  tasks: WatchTask[];
  /** Events of no known task. */
  events: EventRow[];
}

/** A stored payload that names the tool call it is about (policy, dispatch and approval events). */
const NamesToolCall = z.object({ tool_call_id: z.string() });

/**
 * Which tool call each event belongs to: the call its payload names, or the call or approval row
 * that references the event (the proposal and the result, whose payloads carry only the runtime's
 * call id). An event is attributed only to a call of its own task.
 *
 * A row reference can move: a stream line that announces a call its permission request already
 * created re-points `proposal_event_id` at itself. The earlier proposal then reads as a task event,
 * and a live view keeps it where it first showed it. The call's own entry does not move, because
 * the permission request's `policy_evaluated`, committed with the call, still names it.
 */
const toolCallOfEvents = (rows: WatchRows): Map<string, ToolCallRow> => {
  const calls = new Map(rows.tool_calls.map((call) => [call.id, call]));
  const referenced = new Map<string, ToolCallRow>();
  const reference = (eventId: string | null, call: ToolCallRow | undefined) => {
    if (eventId && call) referenced.set(eventId, call);
  };
  for (const call of rows.tool_calls)
    for (const eventId of [call.proposal_event_id, call.dispatch_event_id, call.result_event_id])
      reference(eventId, call);
  for (const approval of rows.approvals) {
    const call = calls.get(approval.tool_call_id);
    reference(approval.requesting_event_id, call);
    reference(approval.decision_event_id, call);
  }
  const owners = new Map<string, ToolCallRow>();
  for (const event of rows.events) {
    const named = NamesToolCall.safeParse(parseJson(event.payload));
    const call =
      (named.success ? calls.get(named.data.tool_call_id) : undefined) ?? referenced.get(event.id);
    if (call && call.task_id === event.task_id) owners.set(event.id, call);
  }
  return owners;
};

const parentOf = (call: ToolCallRow | undefined, taskId: string | null): WatchParent => {
  if (call) return { level: "tool_call", task_id: call.task_id, tool_call_id: call.id };
  if (taskId !== null) return { level: "task", task_id: taskId };
  return { level: "conversation" };
};

const KIND_ORDER: Record<WatchEntry["kind"], number> = { task: 0, tool_call: 1, event: 2 };

/**
 * Every entry of the conversation, in the order a live view appends them. A task or tool call with
 * no event of its own (the engine always records one in the transaction that creates it) enters
 * with its parent: a task at sequence 0, before every event, a tool call with its task.
 */
const allEntries = (rows: WatchRows): WatchEntry[] => {
  const owners = toolCallOfEvents(rows);
  const firstSequence = new Map<string, number>();
  const noteFirst = (id: string, sequence: number) => {
    const known = firstSequence.get(id);
    if (known === undefined || sequence < known) firstSequence.set(id, sequence);
  };
  const taskIds = new Set(rows.tasks.map((task) => task.id));
  const eventEntries = rows.events.map((event): WatchEntry => {
    const call = owners.get(event.id);
    const taskId = event.task_id !== null && taskIds.has(event.task_id) ? event.task_id : null;
    if (taskId !== null) noteFirst(taskId, event.sequence);
    if (call) noteFirst(call.id, event.sequence);
    return { kind: "event", sequence: event.sequence, parent: parentOf(call, taskId), event };
  });
  const taskEntries = rows.tasks.map((task): WatchEntry => ({
    kind: "task",
    sequence: firstSequence.get(task.id) ?? 0,
    parent: { level: "conversation" },
    task,
    executions: rows.executions.filter((execution) => execution.task_id === task.id),
  }));
  const callEntries = rows.tool_calls
    .filter((call) => taskIds.has(call.task_id))
    .map((call): WatchEntry => ({
      kind: "tool_call",
      sequence: firstSequence.get(call.id) ?? firstSequence.get(call.task_id) ?? 0,
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
 * The entries a view that has shown everything up to `afterSequence` has not seen yet, in the order
 * to append them. An event entry keeps its own sequence, and a task or tool call keeps the sequence
 * of the first event committed with it, so polling with the last sequence sent neither repeats an
 * entry nor skips one.
 */
export const watchEntriesAfter = (rows: WatchRows, afterSequence: number): WatchEntry[] =>
  allEntries(rows).filter((entry) => entry.sequence > afterSequence);

/**
 * The whole conversation as a tree: what a view shows before it starts following new entries. It
 * is the entries appended in order, so it always agrees with `watchEntriesAfter`; a parent's entry
 * sorts before every entry under it, so each lookup below finds its node.
 */
export const watchTree = (rows: WatchRows): WatchTree => {
  const conversation = rows.conversations[0];
  if (!conversation) throw new Error("the rows hold no conversation");
  const tree: WatchTree = { conversation, tasks: [], events: [] };
  const tasks = new Map<string, WatchTask>();
  const calls = new Map<string, WatchToolCall>();
  const appendEvent = (parent: WatchParent, event: EventRow) =>
    match(parent)
      .with({ level: "conversation" }, () => tree.events.push(event))
      .with({ level: "task" }, ({ task_id }) => tasks.get(task_id)?.events.push(event))
      .with({ level: "tool_call" }, ({ tool_call_id }) =>
        calls.get(tool_call_id)?.events.push(event),
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
        tasks.get(parent.task_id)?.tool_calls.push(node);
      })
      .with({ kind: "event" }, ({ parent, event }) => appendEvent(parent, event))
      .exhaustive();
  return tree;
};
