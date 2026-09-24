import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Catalog } from "./catalog.ts";
import type { CommandReply } from "./schema.ts";
import { RecordWriter } from "./writer.ts";

/** When the rows these tests write say they were recorded. */
const AT = "2026-01-01T00:00:00.000Z";

/** A distinct time for each row, so a test can tell which given time a row stored. */
const second = (index: number) => `2026-01-01T00:00:0${index}.000Z`;

type CommandInput = Parameters<RecordWriter["recordCommand"]>[0];

let dir: string;
let catalog: Catalog;
let writer: RecordWriter;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mia-records-"));
  catalog = Catalog.openSync(dir);
  writer = new RecordWriter(catalog);
});
afterEach(() => {
  catalog.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Stores `text` in the object store, as a capture does before its artifact is registered. */
const put = (text: string) =>
  writer.objects.put(Buffer.from(text), { signal: new AbortController().signal });

/** Records a provenance set for a conversation to name, and returns its id. */
const provenanceSet = (): string => {
  writer.createProvenanceSet({ id: "prov-1", createdAt: AT, description: "test" });
  return "prov-1";
};

/**
 * A tool call awaiting approval, with the conversation, task, execution and client it belongs to, each stamped with
 * the time `at` gives it.
 */
const seedToolCall = (
  at: { conversation: string; task: string; execution: string; call: string } = {
    conversation: AT,
    task: AT,
    execution: AT,
    call: AT,
  },
): void => {
  const prov = provenanceSet();
  writer.createConversation({
    id: "conv-1",
    startedAt: at.conversation,
    provenanceSetId: prov,
    runtimeConversationId: "rt-1",
  });
  writer.ensureClient("client-1", "text-client");
  writer.openConnection({ connectionId: "conn-1", clientId: "client-1", build: {} });
  writer.createTask({
    id: "task-1",
    createdAt: at.task,
    conversationId: "conv-1",
    text: "t",
    clientId: "client-1",
  });
  writer.createExecution({
    id: "exec-1",
    startedAt: at.execution,
    taskId: "task-1",
    conversationId: "conv-1",
    runtimeIdentity: "claude-code",
    runtimeConversationId: "rt-1",
    requestedModel: "m",
    requestedEffort: "medium",
    provenanceSetId: prov,
    executionEpoch: 1,
  });
  writer.createToolCall({
    id: "call-1",
    createdAt: at.call,
    conversationId: "conv-1",
    taskId: "task-1",
    executionId: "exec-1",
    runtimeCallId: "toolu_1",
    bindingRevision: 1,
    toolIdentity: "mcp__d1__change",
    argumentDigest: "d",
    redactedArguments: { delta: 1 },
    policy: "ask",
    status: "awaiting_approval",
    proposalEventId: null,
  });
};

describe("record writer", () => {
  it("enforces foreign keys and rolls back a failed transaction atomically", () => {
    const prov = provenanceSet();
    writer.createConversation({
      id: "conv-1",
      startedAt: AT,
      provenanceSetId: prov,
      runtimeConversationId: "rt-1",
    });
    expect(() =>
      catalog.transaction(() => {
        writer.appendEvent({
          id: "evt-1",
          receivedAt: AT,
          conversationId: "conv-1",
          type: "task_submitted",
          payload: { ok: true },
        });
        writer.createTask({
          id: "task-1",
          createdAt: AT,
          conversationId: "conv_does_not_exist",
          text: "x",
          clientId: null,
        });
      }),
    ).toThrow();
    expect(catalog.all("SELECT * FROM events")).toHaveLength(0);
  });

  it("records a conversation without creating its directory", () => {
    const conv = writer.createConversation({
      id: "conv-1",
      startedAt: AT,
      provenanceSetId: provenanceSet(),
      runtimeConversationId: "rt-1",
    });
    expect(conv.directory.endsWith("_conv-1")).toBe(true);
    expect(conv.directory.startsWith(catalog.paths.conversations)).toBe(true);
    expect(existsSync(conv.directory)).toBe(false);
  });

  it("assigns a dense per-conversation sequence and redacts payloads", () => {
    const prov = provenanceSet();
    writer.createConversation({
      id: "conv-1",
      startedAt: AT,
      provenanceSetId: prov,
      runtimeConversationId: "rt-1",
    });
    const first = writer.appendEvent({
      id: "evt-1",
      receivedAt: AT,
      conversationId: "conv-1",
      type: "task_submitted",
      payload: { api_key: "sk-ant-abcdefghijklmnop", text: "Bearer abcdefghijklmnopqrstuvwxyz" },
    });
    const second = writer.appendEvent({
      id: "evt-2",
      receivedAt: AT,
      conversationId: "conv-1",
      type: "runtime_exit",
      payload: {},
    });
    expect([first, second].map(({ id, sequence }) => ({ id, sequence }))).toEqual([
      { id: "evt-1", sequence: 1 },
      { id: "evt-2", sequence: 2 },
    ]);
    const row = catalog.get<{ payload: string }>(
      "SELECT payload FROM events WHERE id = ?",
      first.id,
    );
    if (!row) throw new Error("event row missing");
    expect(row.payload).not.toContain("sk-ant");
    expect(row.payload).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(row.payload).toContain("[REDACTED]");
  });

  it("names a transition's rows with the ids its caller gives, and refuses a reused one", () => {
    const prov = provenanceSet();
    writer.createConversation({
      id: "conv-1",
      startedAt: AT,
      provenanceSetId: prov,
      runtimeConversationId: "rt-1",
    });
    writer.createTask({
      id: "task-1",
      createdAt: AT,
      conversationId: "conv-1",
      text: "t",
      clientId: null,
    });
    const append = (taskId: string | null) =>
      writer.appendEvent({
        id: "evt-1",
        receivedAt: AT,
        conversationId: "conv-1",
        type: "task_submitted",
        payload: {},
        taskId,
      });
    append("task-1");
    expect(() => append(null)).toThrow();
    expect(() =>
      writer.createTask({
        id: "task-1",
        createdAt: AT,
        conversationId: "conv-1",
        text: "u",
        clientId: null,
      }),
    ).toThrow();
    expect(catalog.all("SELECT id, task_id FROM events")).toEqual([
      { id: "evt-1", task_id: "task-1" },
    ]);
    expect(catalog.all("SELECT id, text FROM tasks")).toEqual([{ id: "task-1", text: "t" }]);
  });

  it("stores artifact bytes once and keeps distinct logical records", async () => {
    const one = writer.registerArtifact({
      id: "art-1",
      createdAt: AT,
      kind: "tool_output",
      logicalName: "a.txt",
      stored: await put("same"),
    });
    const two = writer.registerArtifact({
      id: "art-2",
      createdAt: AT,
      kind: "tool_output",
      logicalName: "b.txt",
      stored: await put("same"),
    });
    expect(one.digest).toBe(two.digest);
    expect(catalog.all("SELECT id FROM artifacts ORDER BY id")).toEqual([
      { id: "art-1" },
      { id: "art-2" },
    ]);
    expect(catalog.all("SELECT * FROM objects")).toHaveLength(1);
    if (!one.digest) throw new Error("artifact bytes were not stored");
    expect(writer.objects.verifySync(one.digest)).toBe("verified");
  });

  it("names and stamps provenance and artifact rows with the ids and times its caller gives", async () => {
    const stored = await put("snapshot");
    writer.createProvenanceSet({ id: "prov-a", createdAt: second(1), description: "given" });
    writer.registerArtifact({
      id: "art-a",
      createdAt: second(2),
      kind: "snapshot",
      logicalName: "prompt",
      stored,
    });
    // The same bytes again: the object keeps the time of the registration that first recorded it.
    writer.registerArtifact({
      id: "art-b",
      createdAt: second(3),
      kind: "snapshot",
      logicalName: "prompt again",
      stored,
    });
    writer.addProvenanceEntry({
      id: "pe-a",
      provenanceSetId: "prov-a",
      role: "agent_prompt",
      artifactId: "art-a",
      availability: "retained",
    });
    writer.createConversation({
      id: "conv-1",
      startedAt: second(1),
      provenanceSetId: "prov-a",
      runtimeConversationId: "rt-1",
    });
    writer.linkArtifact({
      id: "link-a",
      conversationId: "conv-1",
      artifactId: "art-a",
      relation: "provenance",
      provenanceSetId: "prov-a",
    });
    expect([
      catalog.all("SELECT id, created_at FROM provenance_sets"),
      catalog.all("SELECT id, created_at FROM artifacts ORDER BY id"),
      catalog.all("SELECT created_at FROM objects"),
      catalog.all("SELECT id, artifact_id FROM provenance_entries"),
      catalog.all("SELECT id, artifact_id FROM artifact_links"),
    ]).toEqual([
      [{ id: "prov-a", created_at: second(1) }],
      [
        { id: "art-a", created_at: second(2) },
        { id: "art-b", created_at: second(3) },
      ],
      [{ created_at: second(2) }],
      [{ id: "pe-a", artifact_id: "art-a" }],
      [{ id: "link-a", artifact_id: "art-a" }],
    ]);
  });

  it("stamps a transition's rows with the times its caller gives", () => {
    seedToolCall({
      conversation: second(1),
      task: second(2),
      execution: second(3),
      call: second(4),
    });
    writer.createApproval({
      id: "appr-1",
      requestedAt: second(5),
      toolCallId: "call-1",
      executionEpoch: 1,
      requestingEventId: null,
    });
    writer.appendEvent({
      id: "evt-1",
      receivedAt: second(6),
      conversationId: "conv-1",
      type: "approval_resolved",
      payload: {},
    });
    writer.updateApproval("appr-1", { status: "approved", consumedAt: second(7) });
    writer.updateToolCall("call-1", { updatedAt: second(8), status: "dispatched" });
    expect([
      catalog.get("SELECT started_at FROM conversations"),
      catalog.get("SELECT created_at FROM tasks"),
      catalog.get("SELECT started_at FROM executions"),
      catalog.get("SELECT created_at, updated_at FROM tool_calls"),
      catalog.get("SELECT requested_at, consumed_at FROM approvals"),
      catalog.get("SELECT received_at FROM events"),
    ]).toEqual([
      { started_at: second(1) },
      { created_at: second(2) },
      { started_at: second(3) },
      { created_at: second(4), updated_at: second(8) },
      { requested_at: second(5), consumed_at: second(7) },
      { received_at: second(6) },
    ]);
  });

  it("rejects duplicate approvals for the same binding and epoch, and duplicate command IDs", () => {
    seedToolCall();
    const approval = {
      requestedAt: AT,
      toolCallId: "call-1",
      executionEpoch: 1,
      requestingEventId: null,
    };
    writer.createApproval({ id: "appr-1", ...approval });
    expect(() => writer.createApproval({ id: "appr-2", ...approval })).toThrow();
    const command: CommandInput = {
      connectionId: "conn-1",
      clientId: "client-1",
      clientCommandId: "cmd-1",
      type: "submit_text",
      payload: { text: "a" },
    };
    expect(writer.recordCommand(command).kind).toBe("new");
    expect(writer.recordCommand({ ...command, payload: { text: "b" } })).toEqual({
      kind: "conflict",
    });
  });

  describe("commands", () => {
    const command = (clientCommandId: string, connectionId = "conn-1"): CommandInput => ({
      connectionId,
      clientId: "client-1",
      clientCommandId,
      type: "start_conversation",
      payload: {},
    });
    const recordNew = (clientCommandId: string): string => {
      const recorded = writer.recordCommand(command(clientCommandId));
      if (recorded.kind !== "new") throw new Error(`expected ${clientCommandId} to be new`);
      return recorded.commandId;
    };

    beforeEach(() => {
      writer.ensureClient("client-1", "text-client");
      writer.openConnection({ connectionId: "conn-1", clientId: "client-1", build: {} });
      writer.openConnection({ connectionId: "conn-2", clientId: "client-1", build: {} });
    });

    it("answers a message_id resent on another connection of the same client with its stored reply", () => {
      const replies: CommandReply[] = [
        { disposition: "accepted", result: { conversation_id: "conv_1" } },
        { disposition: "accepted", result: null },
        { disposition: "rejected", error: { code: "busy", message: "a task is running" } },
        { disposition: "failed", error: { code: "internal", message: "broke after recording" } },
      ];
      for (const [index, reply] of replies.entries()) {
        writer.finishCommand(recordNew(`cmd-${index}`), reply);
        expect(writer.recordCommand(command(`cmd-${index}`, "conn-2"))).toEqual({
          kind: "duplicate",
          reply,
        });
      }
    });

    it("reports a command that was recorded but never finished as unfinished", () => {
      const commandId = recordNew("cmd-1");
      expect(writer.recordCommand(command("cmd-1", "conn-2"))).toEqual({
        kind: "unfinished",
        commandId,
      });
    });

    it("stores only the first reply of a command, so a late finish cannot overwrite it", () => {
      const commandId = recordNew("cmd-1");
      const first: CommandReply = {
        disposition: "accepted",
        result: { conversation_id: "conv_1" },
      };
      expect(writer.finishCommand(commandId, first)).toBe(true);
      expect(
        writer.finishCommand(commandId, {
          disposition: "failed",
          error: { code: "internal", message: "late" },
        }),
      ).toBe(false);
      expect(writer.recordCommand(command("cmd-1", "conn-2"))).toEqual({
        kind: "duplicate",
        reply: first,
      });
    });

    it("treats a reused message_id with another command type as a conflict", () => {
      recordNew("cmd-1");
      expect(writer.recordCommand({ ...command("cmd-1"), type: "heartbeat" })).toEqual({
        kind: "conflict",
      });
    });

    it("reports a command whose stored reply cannot be read back as unfinished", () => {
      const commandId = recordNew("cmd-1");
      catalog.db
        .prepare("UPDATE commands SET disposition = 'accepted', result = '[1]' WHERE id = ?")
        .run(commandId);
      expect(writer.recordCommand(command("cmd-1"))).toEqual({ kind: "unfinished", commandId });
    });

    it("redacts the stored reply", () => {
      const secret = "sk-ant-abcdefghijklmnop";
      writer.finishCommand(recordNew("cmd-1"), {
        disposition: "rejected",
        error: { code: "invalid_state", message: `bad key ${secret}` },
      });
      writer.finishCommand(recordNew("cmd-2"), {
        disposition: "accepted",
        result: { api_key: secret },
      });
      expect(
        JSON.stringify(catalog.all("SELECT error_message, result FROM commands")),
      ).not.toContain(secret);
    });

    it("refuses a row whose outcome and error disagree", () => {
      const commandId = recordNew("cmd-1");
      const update = (sql: string) => () => catalog.db.prepare(sql).run(commandId);
      expect(update("UPDATE commands SET disposition = 'failed' WHERE id = ?")).toThrow(/CHECK/);
      expect(
        update(
          "UPDATE commands SET disposition = 'accepted', error_code = 'busy', error_message = 'x' WHERE id = ?",
        ),
      ).toThrow(/CHECK/);
      expect(
        update(
          "UPDATE commands SET disposition = 'rejected', result = '{}', error_code = 'busy', error_message = 'x' WHERE id = ?",
        ),
      ).toThrow(/CHECK/);
    });

    it("keeps message_ids of different clients apart", () => {
      recordNew("cmd-1");
      writer.ensureClient("client-2", "text-client");
      writer.openConnection({ connectionId: "conn-3", clientId: "client-2", build: {} });
      expect(
        writer.recordCommand({ ...command("cmd-1", "conn-3"), clientId: "client-2" }).kind,
      ).toBe("new");
    });
  });
});
