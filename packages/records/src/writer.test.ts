import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Catalog } from "./catalog.ts";
import { RecordWriter } from "./writer.ts";

let dir: string;
let catalog: Catalog;
let writer: RecordWriter;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mia-records-"));
  catalog = new Catalog(dir);
  writer = new RecordWriter(catalog);
});
afterEach(() => {
  catalog.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("record writer", () => {
  it("enforces foreign keys and rolls back a failed transaction atomically", () => {
    const prov = writer.createProvenanceSet("test");
    const conv = writer.createConversation({ provenanceSetId: prov, runtimeConversationId: "rt-1" });
    expect(() =>
      catalog.transaction(() => {
        writer.appendEvent({ conversationId: conv.id, type: "a", payload: { ok: true } });
        writer.createTask({ conversationId: "conv_does_not_exist", text: "x", clientId: null });
      }),
    ).toThrow();
    expect(catalog.all("SELECT * FROM events")).toHaveLength(0);
  });

  it("assigns a dense per-conversation sequence and redacts payloads", () => {
    const prov = writer.createProvenanceSet("test");
    const conv = writer.createConversation({ provenanceSetId: prov, runtimeConversationId: "rt-1" });
    const a = writer.appendEvent({ conversationId: conv.id, type: "x", payload: { api_key: "sk-ant-abcdefghijklmnop", text: "Bearer abcdefghijklmnopqrstuvwxyz" } });
    const b = writer.appendEvent({ conversationId: conv.id, type: "y", payload: {} });
    expect([a.sequence, b.sequence]).toEqual([1, 2]);
    const row = catalog.get<{ payload: string }>("SELECT payload FROM events WHERE id = ?", a.id)!;
    expect(row.payload).not.toContain("sk-ant");
    expect(row.payload).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(row.payload).toContain("[REDACTED]");
  });

  it("stores artifact bytes once and keeps distinct logical records", () => {
    const one = writer.registerArtifact({ kind: "output", logicalName: "a.txt", bytes: Buffer.from("same") });
    const two = writer.registerArtifact({ kind: "output", logicalName: "b.txt", bytes: Buffer.from("same") });
    expect(one.digest).toBe(two.digest);
    expect(one.artifactId).not.toBe(two.artifactId);
    expect(catalog.all("SELECT * FROM objects")).toHaveLength(1);
    expect(writer.objects.verify(one.digest!)).toBe("verified");
  });

  it("rejects duplicate approvals for the same binding and epoch, and duplicate command IDs", () => {
    const prov = writer.createProvenanceSet("test");
    const conv = writer.createConversation({ provenanceSetId: prov, runtimeConversationId: "rt-1" });
    writer.ensureClient("client-1", "text");
    writer.openConnection({ connectionId: "conn-1", clientId: "client-1", build: {} });
    const task = writer.createTask({ conversationId: conv.id, text: "t", clientId: "client-1" });
    const exec = writer.createExecution({
      taskId: task,
      conversationId: conv.id,
      runtimeIdentity: "claude-code",
      runtimeConversationId: "rt-1",
      requestedModel: "m",
      requestedEffort: "medium",
      provenanceSetId: prov,
      executionEpoch: 1,
    });
    const call = writer.createToolCall({
      conversationId: conv.id,
      taskId: task,
      executionId: exec,
      runtimeCallId: "toolu_1",
      bindingRevision: 1,
      toolIdentity: "mcp__d1__change",
      argumentDigest: "d",
      redactedArguments: { delta: 1 },
      policy: "ask",
      status: "awaiting_approval",
      proposalEventId: null,
    });
    writer.createApproval({ toolCallId: call, executionEpoch: 1, requestingEventId: null });
    expect(() => writer.createApproval({ toolCallId: call, executionEpoch: 1, requestingEventId: null })).toThrow();
    const first = writer.recordCommand({ connectionId: "conn-1", clientId: "client-1", clientCommandId: "cmd-1", type: "submit_text", payload: { text: "a" } });
    expect(first.duplicate).toBe(false);
    const dup = writer.recordCommand({ connectionId: "conn-1", clientId: "client-1", clientCommandId: "cmd-1", type: "submit_text", payload: { text: "b" } });
    expect(dup.duplicate).toBe(true);
    if (dup.duplicate) expect(dup.sameDigest).toBe(false);
  });
});
