import { match } from "ts-pattern";
import { describe, expect, it } from "vitest";
import type {
  ApprovalRow,
  EventRow,
  ExecutionRow,
  JournalEventType,
  TaskRow,
  ToolCallRow,
} from "./schema.ts";
import { fixtureEvent, snapshotFixture } from "./snapshot-fixture.ts";
import {
  capturedInDebugMode,
  watchEntriesAfter,
  watchTree,
  type WatchEntry,
  type WatchRows,
} from "./watch.ts";

const EXECUTION_OF: Record<string, string> = { first: "x1", second: "x2" };

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
      execution_id: (taskId && EXECUTION_OF[taskId]) ?? null,
      payload: JSON.stringify(payload),
    });
const first = eventsOf("first");
const second = eventsOf("second");

/** What one engine transaction committed: its events and the rows it created or changed. */
interface Commit {
  events: EventRow[];
  tasks?: TaskRow[];
  executions?: ExecutionRow[];
  tool_calls?: ToolCallRow[];
  approvals?: ApprovalRow[];
}

const fixtureRows = () => {
  const { tables } = snapshotFixture();
  const [task] = tables.tasks;
  const [call] = tables.tool_calls;
  const [approval] = tables.approvals;
  const [execution] = tables.executions;
  if (!task || !call || !approval || !execution) throw new Error("fixture rows missing");
  return { conversations: tables.conversations, task, call, approval, execution };
};

const REQUEST = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read" } };
const READ = { runtime_call_id: "r1", tool_identity: "gmail.search", argument_digest: "d1" };
const WRITE = { runtime_call_id: "r2", tool_identity: "fs.write", argument_digest: "d2" };

/**
 * A conversation as the engine commits it. The first task's call is created by its permission
 * request, then a stream line announcing the same binding re-points its proposal. The second
 * task's call is created by a stream line, announced again, and denied by policy with a detail no
 * event carries. The event at 19 belongs to no known task.
 */
const commits = (): Commit[] => {
  const { task, call, approval, execution } = fixtureRows();
  const call1 = {
    ...call,
    id: "call-1",
    task_id: "first",
    execution_id: "x1",
    ...READ,
    status: "awaiting_approval",
    detail: null,
    proposal_event_id: "e4",
  } satisfies ToolCallRow;
  const approval1 = {
    ...approval,
    id: "approval-1",
    tool_call_id: "call-1",
    status: "pending",
    requesting_event_id: "e6",
  } satisfies ApprovalRow;
  const call2 = {
    ...call1,
    id: "call-2",
    task_id: "second",
    execution_id: "x2",
    ...WRITE,
    status: "proposed",
    proposal_event_id: "e17",
  } satisfies ToolCallRow;
  return [
    { events: [eventsOf(null)(1, "conversation_started")] },
    {
      events: [
        first(2, "task_submitted", { text: "summarise my inbox" }),
        first(3, "task_started"),
      ],
      tasks: [{ ...task, id: "first", status: "running" }],
      executions: [{ ...execution, id: "x1", task_id: "first" }],
    },
    {
      events: [
        first(4, "tool_proposed", { ...READ, source: "permission_request" }),
        first(5, "policy_evaluated", { tool_call_id: "call-1" }),
        first(6, "approval_requested", { tool_call_id: "call-1", approval_id: "approval-1" }),
      ],
      tool_calls: [call1],
      approvals: [approval1],
    },
    {
      events: [first(7, "tool_proposed", READ)],
      tool_calls: [{ ...call1, proposal_event_id: "e7" }],
    },
    {
      events: [
        first(8, "approval_resolved", { tool_call_id: "call-1", approval_id: "approval-1" }),
        first(9, "tool_dispatched", { tool_call_id: "call-1" }),
      ],
      tool_calls: [
        { ...call1, proposal_event_id: "e7", status: "dispatched", dispatch_event_id: "e9" },
      ],
      approvals: [{ ...approval1, status: "approved", decision_event_id: "e8" }],
    },
    {
      // Debug mode records the call's MCP messages with its result: here a body, and a reason for the missing one.
      events: [
        first(10, "tool_result", { runtime_call_id: "r1" }),
        first(11, "mcp_request", { tool_call_id: "call-1", runtime_call_id: "r1", body: REQUEST }),
        first(12, "mcp_response", {
          tool_call_id: "call-1",
          runtime_call_id: "r1",
          unrecorded: "the body log has no response for this call",
        }),
      ],
      tool_calls: [
        {
          ...call1,
          proposal_event_id: "e7",
          status: "completed",
          dispatch_event_id: "e9",
          result_event_id: "e10",
        },
      ],
    },
    {
      events: [first(13, "task_finished")],
      tasks: [{ ...task, id: "first", status: "completed" }],
    },
    {
      events: [second(14, "task_submitted"), second(15, "task_started")],
      tasks: [{ ...task, id: "second", status: "running" }],
      executions: [{ ...execution, id: "x2", task_id: "second" }],
    },
    { events: [second(16, "tool_proposal_started", { runtime_call_id: "r2" })] },
    { events: [second(17, "tool_proposed", WRITE)], tool_calls: [call2] },
    {
      events: [second(18, "tool_proposed", WRITE)],
      tool_calls: [{ ...call2, proposal_event_id: "e18" }],
    },
    {
      events: [
        second(19, "policy_evaluated", { tool_call_id: "call-2" }),
        second(20, "error", { message: "tool fs.write is not listed" }),
      ],
      tool_calls: [
        { ...call2, proposal_event_id: "e18", status: "denied", detail: "policy: deny" },
      ],
    },
    { events: [eventsOf("no-such-task")(21, "error")] },
    {
      events: [second(22, "task_finished")],
      tasks: [{ ...task, id: "second", status: "completed" }],
    },
  ];
};

/** Replace rows by id, keeping the order each was first created in. */
const upsert = <Row extends { id: string }>(rows: Row[], changes: Row[] = []): Row[] => {
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const row of changes) byId.set(row.id, row);
  return [...byId.values()];
};

/** The rows a read sees once every transaction up to `cutoff` has committed. */
const rowsAt = (cutoff: number): WatchRows =>
  commits()
    .filter((commit) => commit.events.every((row) => row.sequence <= cutoff))
    .reduce<WatchRows>(
      (rows, commit) => ({
        ...rows,
        events: [...rows.events, ...commit.events],
        tasks: upsert(rows.tasks, commit.tasks),
        executions: upsert(rows.executions, commit.executions),
        tool_calls: upsert(rows.tool_calls, commit.tool_calls),
        approvals: upsert(rows.approvals, commit.approvals),
      }),
      {
        conversations: fixtureRows().conversations,
        events: [],
        tasks: [],
        executions: [],
        tool_calls: [],
        approvals: [],
      },
    );

const LAST = 22;
const finalRows = () => rowsAt(LAST);

const sequences = (events: EventRow[]) => events.map((row) => row.sequence);

/** What a view shows for an entry: its kind, the id it adds, and where it goes. */
const shown = (entry: WatchEntry) => ({
  kind: entry.kind,
  id: match(entry)
    .with({ kind: "task" }, ({ task }) => task.id)
    .with({ kind: "tool_call" }, ({ tool_call }) => tool_call.id)
    .with({ kind: "mcp" }, ({ mcp }) => mcp.event.id)
    .with({ kind: "event" }, ({ event: row }) => row.id)
    .exhaustive(),
  sequence: entry.sequence,
  parent: entry.parent,
});

const treeShape = (rows: WatchRows) => {
  const tree = watchTree(rows);
  return {
    events: sequences(tree.events),
    tasks: tree.tasks.map((task) => ({
      id: task.task.id,
      executions: task.executions.map((execution) => execution.id),
      events: sequences(task.events),
      calls: task.tool_calls.map((call) => ({
        id: call.tool_call.id,
        approvals: call.approvals.map((approval) => approval.id),
        mcp: call.mcp.map((message) => [message.type, message.event.sequence, message.content]),
        events: sequences(call.events),
      })),
    })),
  };
};

describe("watchTree", () => {
  it("nests each event under the task and tool call it belongs to", () => {
    expect(watchTree(finalRows()).conversation.id).toBe("conversation");
    expect(treeShape(finalRows())).toEqual({
      events: [1, 21],
      tasks: [
        {
          id: "first",
          executions: ["x1"],
          events: [2, 3, 13],
          calls: [
            {
              id: "call-1",
              approvals: ["approval-1"],
              // Nodes of their own, not among the call's raw events.
              mcp: [
                ["mcp_request", 11, { status: "recorded", body: REQUEST }],
                [
                  "mcp_response",
                  12,
                  { status: "unrecorded", reason: "the body log has no response for this call" },
                ],
              ],
              events: [4, 5, 6, 7, 8, 9, 10],
            },
          ],
        },
        {
          id: "second",
          executions: ["x2"],
          // The partial proposal comes before the call exists; the policy error names no call.
          events: [14, 15, 16, 20, 22],
          calls: [{ id: "call-2", approvals: [], mcp: [], events: [17, 18, 19] }],
        },
      ],
    });
  });

  it("leaves a proposal with the task when more than one call has its binding", () => {
    const rows = finalRows();
    const [, call2] = rows.tool_calls;
    if (!call2) throw new Error("fixture call missing");
    rows.tool_calls.push({ ...call2, id: "call-3", binding_revision: 2, proposal_event_id: null });
    const secondTask = treeShape(rows).tasks[1];
    expect(secondTask?.events).toEqual([14, 15, 16, 17, 20, 22]);
    // The call with no event of its own enters with its task, so before the one proposed later.
    expect(secondTask?.calls.map((call) => [call.id, call.events])).toEqual([
      ["call-3", []],
      ["call-2", [18, 19]],
    ]);
  });

  it("checks each candidate call against the event's task", () => {
    const rows = finalRows();
    // The payload names a call of another task; the row that references the event is its own.
    rows.events = rows.events.map((row) =>
      row.id === "e18" ? { ...row, payload: JSON.stringify({ tool_call_id: "call-1" }) } : row,
    );
    expect(treeShape(rows).tasks[1]?.calls[0]?.events).toEqual([17, 18, 19]);
  });

  it("keeps a task and a tool call that have no events of their own", () => {
    const rows = finalRows();
    rows.events = rows.events.filter((row) => row.task_id !== "second");
    expect(treeShape(rows).tasks.find((task) => task.id === "second")).toEqual({
      id: "second",
      executions: ["x2"],
      events: [],
      calls: [{ id: "call-2", approvals: [], mcp: [], events: [] }],
    });
    expect(watchEntriesAfter(rows, -1).map(shown).slice(0, 3)).toEqual([
      { kind: "task", id: "second", sequence: 0, parent: { level: "conversation" } },
      {
        kind: "tool_call",
        id: "call-2",
        sequence: 0,
        parent: { level: "task", task_id: "second" },
      },
      { kind: "event", id: "e1", sequence: 1, parent: { level: "conversation" } },
    ]);
  });

  it("keeps every event when a task row is missing", () => {
    const rows = finalRows();
    rows.tasks = rows.tasks.filter((task) => task.id !== "second");
    const shape = treeShape(rows);
    expect(shape.events).toEqual([1, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
    expect(shape.tasks.map((task) => task.id)).toEqual(["first"]);
  });

  it("refuses rows without their conversation", () => {
    expect(() => watchTree({ ...finalRows(), conversations: [] })).toThrow(
      "the rows hold no conversation",
    );
  });
});

describe("MCP messages", () => {
  /** The final rows, and two MCP events the view cannot place as nodes. */
  const withUnplaced = (): WatchRows => {
    const rows = finalRows();
    rows.events.push(
      // Neither a body nor a reason: kept as a raw event, so nothing recorded is hidden.
      first(23, "mcp_request", { tool_call_id: "call-1" }),
      // Of no known call: kept with its task.
      second(24, "mcp_request", { tool_call_id: "no-such-call", body: {} }),
    );
    return rows;
  };

  it("keeps an MCP event it cannot read, or of no known call, as a raw event", () => {
    const [firstTask, secondTask] = treeShape(withUnplaced()).tasks;
    expect(firstTask?.calls[0]?.mcp.map(([type]) => type)).toEqual(["mcp_request", "mcp_response"]);
    expect(firstTask?.calls[0]?.events).toEqual([4, 5, 6, 7, 8, 9, 10, 23]);
    expect(secondTask?.events).toEqual([14, 15, 16, 20, 22, 24]);
  });

  it("adds an MCP message as an entry under its call, after the sequence a view has shown", () => {
    const call = { level: "tool_call", task_id: "first", tool_call_id: "call-1" };
    expect(watchEntriesAfter(finalRows(), 11).map(shown).slice(0, 2)).toEqual([
      { kind: "mcp", id: "e12", sequence: 12, parent: call },
      { kind: "event", id: "e13", sequence: 13, parent: { level: "task", task_id: "first" } },
    ]);
  });
});

describe("capturedInDebugMode", () => {
  it("tells whether the conversation was captured in debug mode", () => {
    const rows = finalRows();
    expect(capturedInDebugMode(rows)).toBe(false);
    rows.events.push(eventsOf(null)(LAST + 1, "captured_in_debug_mode"));
    expect(capturedInDebugMode(rows)).toBe(true);
  });
});

describe("watchEntriesAfter", () => {
  it("adds a task and a tool call just before their first event", () => {
    expect(watchEntriesAfter(finalRows(), -1).map(shown).slice(0, 6)).toEqual([
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

  it.each([0, 1, 3, 4, 10, 11, 12, 19, LAST])(
    "after sequence %i returns every later event once and no earlier one",
    (after) => {
      const entries = watchEntriesAfter(finalRows(), after);
      const events = entries.flatMap((entry) =>
        match(entry)
          .with({ kind: "event" }, ({ event }) => [event])
          .with({ kind: "mcp" }, ({ mcp }) => [mcp.event])
          .with({ kind: "task" }, { kind: "tool_call" }, () => [])
          .exhaustive(),
      );
      expect(sequences(events)).toEqual(
        sequences(finalRows().events).filter((sequence) => sequence > after),
      );
      expect(entries.every((entry) => entry.sequence > after)).toBe(true);
    },
  );

  // A read sees whole transactions, so it can only stop at the last sequence of one.
  const COMMITTED = commits().flatMap((commit) => sequences(commit.events).slice(-1));

  it.each(COMMITTED)(
    "a view that read at sequence %i and then follows adds each entry once, where a fresh read puts it",
    (cutoff) => {
      const followed = [
        ...watchEntriesAfter(rowsAt(cutoff), -1),
        ...watchEntriesAfter(finalRows(), cutoff),
      ].map(shown);
      expect(followed).toEqual(watchEntriesAfter(finalRows(), -1).map(shown));
      const ids = followed.map((entry) => entry.id);
      expect(new Set(ids).size).toBe(ids.length);
    },
  );

  it("places a parent before every entry under it", () => {
    const seen = new Set<string>(["conversation"]);
    for (const entry of watchEntriesAfter(finalRows(), -1)) {
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
