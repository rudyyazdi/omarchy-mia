import { TaskStatusSchema, type TaskStatus } from "@mia/protocol";
import { describe, expect, it } from "vitest";
import { diagnosticsViews, taskViews } from "./queries.ts";
import { fixtureEvent, snapshotFixture } from "./snapshot-fixture.ts";

const partialByStatus: Record<TaskStatus, boolean> = {
  running: true,
  awaiting_approval: true,
  interrupting: true,
  completed: false,
  failed: true,
  interrupted: true,
  outcome_unknown: true,
};

describe("taskViews", () => {
  it("assembles only each task's text deltas in journal order", () => {
    const snapshot = snapshotFixture();
    const task = snapshot.tables.tasks[0];
    if (!task) throw new Error("fixture task missing");
    snapshot.tables.tasks.push({ ...task, id: "other-task" }, { ...task, id: "silent-task" });
    snapshot.tables.events = [
      fixtureEvent({ payload: '{"text":"Hello "}' }),
      fixtureEvent({
        id: "unrelated",
        sequence: 2,
        task_id: "other-task",
        payload: '{"text":"Other"}',
      }),
      fixtureEvent({ id: "non-text", sequence: 3, type: "notice", payload: '{"text":"ignored"}' }),
      fixtureEvent({ id: "last", sequence: 4, payload: '{"text":"world"}' }),
      fixtureEvent({ id: "global", sequence: 5, task_id: null, payload: '{"text":"global"}' }),
    ];
    expect(taskViews(snapshot).map((view) => ({ id: view.id, text: view.assistant_text }))).toEqual(
      [
        { id: "task", text: "Hello world" },
        { id: "other-task", text: "Other" },
        { id: "silent-task", text: "" },
      ],
    );
  });

  it.each(TaskStatusSchema.options)("labels partial output for task status %s", (status) => {
    const snapshot = snapshotFixture();
    for (const task of snapshot.tables.tasks) task.status = status;
    expect(taskViews(snapshot)[0]?.partial).toBe(partialByStatus[status]);
  });
});

describe("diagnosticsViews freshness", () => {
  it.each([
    { age: 59_999, disconnected: false, expected: "current" },
    { age: 60_000, disconnected: false, expected: "current" },
    { age: 60_001, disconnected: false, expected: "stale" },
    { age: 0, disconnected: true, expected: "disconnected" },
    { age: 60_001, disconnected: true, expected: "disconnected" },
  ])(
    "reports $expected at age $age with disconnected=$disconnected",
    ({ age, disconnected, expected }) => {
      const snapshot = snapshotFixture();
      const now = Date.parse("2026-01-01T00:02:00Z");
      for (const diagnostic of snapshot.tables.diagnostics) {
        diagnostic.received_at = new Date(now - age).toISOString();
        diagnostic.captured_at = "2000-01-01T00:00:00Z";
      }
      snapshot.tables.client_connections = [
        {
          id: "connection",
          client_id: "client",
          build: null,
          provenance_set_id: null,
          connected_at: "2026-01-01T00:00:00Z",
          disconnected_at: disconnected ? "2026-01-01T00:01:00Z" : null,
          last_received_at: null,
        },
      ];
      expect(diagnosticsViews(snapshot, now)[0]).toMatchObject({
        freshness: expected,
        state: { detail: "diagnostic-state" },
      });
    },
  );

  it("uses custom age thresholds even when a connection is absent", () => {
    const snapshot = snapshotFixture();
    for (const diagnostic of snapshot.tables.diagnostics) {
      diagnostic.client_connection_id = null;
      diagnostic.received_at = "2026-01-01T00:00:00Z";
    }
    const now = Date.parse("2026-01-01T00:00:01Z");
    expect(diagnosticsViews(snapshot, now, 1000)[0]?.freshness).toBe("current");
    expect(diagnosticsViews(snapshot, now, 999)[0]?.freshness).toBe("stale");
    snapshot.tables.diagnostics = [];
    expect(diagnosticsViews(snapshot, now)).toEqual([]);
  });
});
