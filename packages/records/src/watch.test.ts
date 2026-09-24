import { match } from "ts-pattern";
import { describe, expect, it } from "vitest";
import type { EventRow, JournalEventType } from "./schema.ts";
import { fixtureEvent, snapshotFixture } from "./snapshot-fixture.ts";
import { watchEntriesAfter, watchTree, type WatchEntry, type WatchRows } from "./watch.ts";

/** Events of one task (or of none), each numbered by its sequence. */
const eventsOf =
  (taskId: string | null) =>
  (sequence: number, type: JournalEventType, payload: Record<string, unknown> = {}): EventRow =>
    fixtureEvent({
      id: `e${sequence}`,
      conversation_id: "conversation",
      sequence,
      type,
      task_id: taskId,
      payload: JSON.stringify(payload),
    });
const first = eventsOf("first");
const second = eventsOf("second");

/**
 * Two tasks. The first has one approved tool call whose proposal and result are linked only from
 * the call row, and whose approval events are linked from the approval row; the second has a call
 * the policy denied, named only in its payload. The event at 12 belongs to no known task.
 */
const conversationRows = (): WatchRows => {
  const { tables } = snapshotFixture();
  const [task] = tables.tasks;
  const [call] = tables.tool_calls;
  const [approval] = tables.approvals;
  const [execution] = tables.executions;
  if (!task || !call || !approval || !execution) throw new Error("fixture rows missing");
  return {
    conversations: tables.conversations,
    tasks: [
      { ...task, id: "first" },
      { ...task, id: "second" },
    ],
    executions: [
      { ...execution, id: "x1", task_id: "first" },
      { ...execution, id: "x2", task_id: "second" },
    ],
    tool_calls: [
      {
        ...call,
        id: "call-1",
        task_id: "first",
        status: "completed",
        proposal_event_id: "e4",
        result_event_id: "e8",
      },
      { ...call, id: "call-2", task_id: "second", status: "denied", detail: "policy: deny" },
    ],
    approvals: [
      {
        ...approval,
        id: "approval-1",
        tool_call_id: "call-1",
        requesting_event_id: "e5",
        decision_event_id: "e6",
      },
    ],
    events: [
      eventsOf(null)(1, "conversation_started"),
      first(2, "task_submitted", { text: "summarise my inbox" }),
      first(3, "task_started"),
      first(4, "tool_proposed", { runtime_call_id: "r1" }),
      first(5, "approval_requested", { approval_id: "approval-1" }),
      first(6, "approval_resolved", { approval_id: "approval-1" }),
      first(7, "tool_dispatched", { tool_call_id: "call-1" }),
      first(8, "tool_result", { runtime_call_id: "r1" }),
      first(9, "task_finished"),
      second(10, "task_submitted"),
      // Names a call of another task: it stays with its own task.
      second(11, "text_delta", { tool_call_id: "call-1", text: "hi" }),
      eventsOf("no-such-task")(12, "error"),
      second(13, "policy_evaluated", { tool_call_id: "call-2" }),
      second(14, "task_finished"),
    ],
  };
};

const sequences = (events: EventRow[]) => events.map((row) => row.sequence);

/** What a view shows for an entry: its kind, the id it adds, and where it goes. */
const shown = (entry: WatchEntry) => ({
  kind: entry.kind,
  id: match(entry)
    .with({ kind: "task" }, ({ task }) => task.id)
    .with({ kind: "tool_call" }, ({ tool_call }) => tool_call.id)
    .with({ kind: "event" }, ({ event: row }) => row.id)
    .exhaustive(),
  sequence: entry.sequence,
  parent: entry.parent,
});

/** The sequence of the event whose transaction created each row, in `conversationRows`. */
const CREATED_AT: Record<string, number> = { "call-1": 4, "call-2": 13, "approval-1": 5 };
const createdBy = (cutoff: number) => (row: { id: string }) =>
  (CREATED_AT[row.id] ?? Infinity) <= cutoff;

describe("watchTree", () => {
  it("nests each event under the task and tool call it belongs to", () => {
    const tree = watchTree(conversationRows());
    expect(tree.conversation.id).toBe("conversation");
    expect(sequences(tree.events)).toEqual([1, 12]);
    expect(
      tree.tasks.map((task) => ({
        id: task.task.id,
        executions: task.executions.map((execution) => execution.id),
        events: sequences(task.events),
        calls: task.tool_calls.map((call) => ({
          id: call.tool_call.id,
          approvals: call.approvals.map((approval) => approval.id),
          events: sequences(call.events),
        })),
      })),
    ).toEqual([
      {
        id: "first",
        executions: ["x1"],
        events: [2, 3, 9],
        calls: [{ id: "call-1", approvals: ["approval-1"], events: [4, 5, 6, 7, 8] }],
      },
      {
        id: "second",
        executions: ["x2"],
        events: [10, 11, 14],
        calls: [{ id: "call-2", approvals: [], events: [13] }],
      },
    ]);
  });

  it("keeps a task and a tool call that have no events of their own", () => {
    const rows = conversationRows();
    rows.events = rows.events.filter((row) => row.task_id !== "second");
    const secondTask = watchTree(rows).tasks.find((task) => task.task.id === "second");
    expect(secondTask?.tool_calls.map((call) => call.tool_call.id)).toEqual(["call-2"]);
    expect(secondTask?.events).toEqual([]);
  });

  it("refuses rows without their conversation", () => {
    expect(() => watchTree({ ...conversationRows(), conversations: [] })).toThrow(
      "the rows hold no conversation",
    );
  });
});

describe("watchEntriesAfter", () => {
  it("adds a task and a tool call just before their first event", () => {
    expect(watchEntriesAfter(conversationRows(), 0).map(shown).slice(0, 6)).toEqual([
      { kind: "event", id: "e1", sequence: 1, parent: { level: "conversation" } },
      { kind: "task", id: "first", sequence: 2, parent: { level: "conversation" } },
      { kind: "event", id: "e2", sequence: 2, parent: { level: "task", task_id: "first" } },
      { kind: "event", id: "e3", sequence: 3, parent: { level: "task", task_id: "first" } },
      { kind: "tool_call", id: "call-1", sequence: 4, parent: { level: "task", task_id: "first" } },
      {
        kind: "event",
        id: "e4",
        sequence: 4,
        parent: { level: "tool_call", task_id: "first", tool_call_id: "call-1" },
      },
    ]);
  });

  it.each([0, 1, 3, 4, 8, 13, 14])(
    "after sequence %i returns every later event once and no earlier one",
    (after) => {
      const entries = watchEntriesAfter(conversationRows(), after);
      const events = entries.flatMap((entry) => (entry.kind === "event" ? [entry.event] : []));
      expect(sequences(events)).toEqual(
        sequences(conversationRows().events).filter((sequence) => sequence > after),
      );
      expect(entries.every((entry) => entry.sequence > after)).toBe(true);
    },
  );

  it.each([1, 3, 4, 6, 9, 11, 13])(
    "a view that read at sequence %i and then follows sees what a fresh read shows",
    (cutoff) => {
      // The rows a read at the cutoff saw: its events and the rows those events brought with them.
      const later = conversationRows();
      const earlier: WatchRows = {
        ...later,
        events: later.events.filter((row) => row.sequence <= cutoff),
        tasks: later.tasks.filter((task) =>
          later.events.some((row) => row.task_id === task.id && row.sequence <= cutoff),
        ),
        tool_calls: later.tool_calls.filter(createdBy(cutoff)),
        approvals: later.approvals.filter(createdBy(cutoff)),
      };
      const followed = [...watchEntriesAfter(earlier, 0), ...watchEntriesAfter(later, cutoff)].map(
        shown,
      );
      expect(followed).toEqual(watchEntriesAfter(later, 0).map(shown));
    },
  );

  it("places a parent before every entry under it", () => {
    const seen = new Set<string>(["conversation"]);
    for (const entry of watchEntriesAfter(conversationRows(), 0)) {
      const parent = match(entry.parent)
        .with({ level: "conversation" }, () => "conversation")
        .with({ level: "task" }, ({ task_id }) => task_id)
        .with({ level: "tool_call" }, ({ tool_call_id }) => tool_call_id)
        .exhaustive();
      expect(seen).toContain(parent);
      seen.add(shown(entry).id);
    }
  });
});
