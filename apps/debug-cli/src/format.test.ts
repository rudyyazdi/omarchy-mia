import { emptySnapshotTables, type ConversationSnapshot } from "@mia/records";
import { describe, expect, it } from "vitest";
import { formatConversationHeader, formatExport } from "./format.ts";

const emptySnapshot = (): ConversationSnapshot => ({
  conversation_id: "conv_1",
  captured_at: "2026-01-01T00:00:00.000Z",
  cutoff_sequence: 0,
  tables: emptySnapshotTables(),
  artifact_closure: [],
  unresolved_references: [],
  ongoing_tasks: [],
});

describe("debug formatting", () => {
  it("names partial export reasons only when there are some", () => {
    const manifest = {
      complete: true,
      record_counts: { events: 3 },
      partial_reasons: [],
      objects: { included: 1 },
    };
    expect(formatExport({ directory: "/x", manifest })).toBe(
      "exported to /x; complete=true; events=3; objects=1",
    );
    expect(
      formatExport({
        directory: "/x",
        manifest: {
          ...manifest,
          complete: false,
          partial_reasons: ["missing object", "ongoing task"],
        },
      }),
    ).toBe(
      "exported to /x; complete=false; events=3; objects=1; partial: missing object, ongoing task",
    );
  });

  it("refuses a snapshot without its conversation row", () => {
    expect(() => formatConversationHeader(emptySnapshot())).toThrow(
      "conversation conv_1 has no catalog row",
    );
  });
});
