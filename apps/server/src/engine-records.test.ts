import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Catalog, RecordWriter } from "@mia/records";
import { commitRecords, eventSequence, type EngineRecord } from "./engine-records.ts";

const AT = "2026-01-01T00:00:00.000Z";

/** A fresh catalog in a temporary directory, and the writer the records commit through. */
let store: { root: string; catalog: Catalog; writer: RecordWriter };

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "mia-engine-records-"));
  const catalog = Catalog.openSync(root);
  store = { root, catalog, writer: new RecordWriter(catalog) };
});
afterEach(() => {
  store.catalog.close();
  rmSync(store.root, { recursive: true, force: true });
});

const conversation: EngineRecord[] = [
  { kind: "create_provenance_set", input: { id: "prov-1", createdAt: AT, description: "test" } },
  {
    kind: "create_conversation",
    input: {
      id: "conv-1",
      startedAt: AT,
      provenanceSetId: "prov-1",
      runtimeConversationId: "rt-1",
    },
  },
];

const event = (id: string): EngineRecord => ({
  kind: "append_event",
  input: { id, receivedAt: AT, conversationId: "conv-1", type: "runtime_exit", payload: {} },
});

describe("commitRecords", () => {
  it("writes records in order and returns each one's change, aligned by index", () => {
    const changes = commitRecords(store.writer, [...conversation, event("evt-1"), event("evt-2")]);
    expect(changes).toEqual([
      { kind: "row" },
      { kind: "row" },
      { kind: "event", id: "evt-1", sequence: 1 },
      { kind: "event", id: "evt-2", sequence: 2 },
    ]);
    expect(eventSequence(changes, "evt-2")).toBe(2);
    expect(() => eventSequence(changes, "evt-3")).toThrow("event evt-3 was not committed");
  });

  it("commits nothing when one record fails", () => {
    commitRecords(store.writer, conversation);
    const failing: EngineRecord = {
      kind: "create_task",
      input: { id: "task-1", createdAt: AT, conversationId: "no-such", text: "x", clientId: null },
    };
    expect(() => commitRecords(store.writer, [event("evt-1"), failing])).toThrow(/FOREIGN KEY/);
    expect(store.catalog.all("SELECT id FROM events")).toEqual([]);
    expect(commitRecords(store.writer, [event("evt-1")])).toEqual([
      { kind: "event", id: "evt-1", sequence: 1 },
    ]);
  });

  it("opens no transaction for no records, so a catalog that cannot commit does not refuse them", () => {
    const root = mkdtempSync(join(tmpdir(), "mia-engine-records-closed-"));
    try {
      const closed = Catalog.openSync(root);
      closed.close();
      const writer = new RecordWriter(closed);
      expect(commitRecords(writer, [])).toEqual([]);
      expect(() => commitRecords(writer, conversation)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
