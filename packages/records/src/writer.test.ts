import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Catalog } from "./catalog.ts";
import type { CommandReply } from "./schema.ts";
import { RecordWriter } from "./writer.ts";

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

describe("record writer", () => {
  it("enforces foreign keys and rolls back a failed transaction atomically", () => {
    const prov = writer.createProvenanceSet("test");
    const conv = writer.createConversation({
      provenanceSetId: prov,
      runtimeConversationId: "rt-1",
    });
    expect(() =>
      catalog.transaction(() => {
        writer.appendEvent({
          conversationId: conv.id,
          type: "task_submitted",
          payload: { ok: true },
        });
        writer.createTask({ conversationId: "conv_does_not_exist", text: "x", clientId: null });
      }),
    ).toThrow();
    expect(catalog.all("SELECT * FROM events")).toHaveLength(0);
  });

  it("records a conversation without creating its directory", () => {
    const conv = writer.createConversation({
      provenanceSetId: writer.createProvenanceSet("test"),
      runtimeConversationId: "rt-1",
    });
    expect(conv.directory.startsWith(catalog.paths.conversations)).toBe(true);
    expect(existsSync(conv.directory)).toBe(false);
  });

  it("assigns a dense per-conversation sequence and redacts payloads", () => {
    const prov = writer.createProvenanceSet("test");
    const conv = writer.createConversation({
      provenanceSetId: prov,
      runtimeConversationId: "rt-1",
    });
    const first = writer.appendEvent({
      conversationId: conv.id,
      type: "task_submitted",
      payload: { api_key: "sk-ant-abcdefghijklmnop", text: "Bearer abcdefghijklmnopqrstuvwxyz" },
    });
    const second = writer.appendEvent({
      conversationId: conv.id,
      type: "runtime_exit",
      payload: {},
    });
    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    const row = catalog.get<{ payload: string }>(
      "SELECT payload FROM events WHERE id = ?",
      first.id,
    );
    if (!row) throw new Error("event row missing");
    expect(row.payload).not.toContain("sk-ant");
    expect(row.payload).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(row.payload).toContain("[REDACTED]");
  });

  it("stores artifact bytes once and keeps distinct logical records", async () => {
    const one = writer.registerArtifact({
      kind: "tool_output",
      logicalName: "a.txt",
      stored: await writer.objects.put(Buffer.from("same"), {
        signal: new AbortController().signal,
      }),
    });
    const two = writer.registerArtifact({
      kind: "tool_output",
      logicalName: "b.txt",
      stored: await writer.objects.put(Buffer.from("same"), {
        signal: new AbortController().signal,
      }),
    });
    expect(one.digest).toBe(two.digest);
    expect(one.artifactId).not.toBe(two.artifactId);
    expect(catalog.all("SELECT * FROM objects")).toHaveLength(1);
    if (!one.digest) throw new Error("artifact bytes were not stored");
    expect(writer.objects.verifySync(one.digest)).toBe("verified");
  });

  it("rejects duplicate approvals for the same binding and epoch, and duplicate command IDs", () => {
    const prov = writer.createProvenanceSet("test");
    const conv = writer.createConversation({
      provenanceSetId: prov,
      runtimeConversationId: "rt-1",
    });
    writer.ensureClient("client-1", "text-client");
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
    expect(() =>
      writer.createApproval({ toolCallId: call, executionEpoch: 1, requestingEventId: null }),
    ).toThrow();
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
