import { afterEach, describe, expect, it } from "vitest";
import { isRecord } from "@mia/protocol";
import {
  snapshotConversation,
  type JournalEventType,
  type ConversationSnapshot,
} from "@mia/records";
import { ackResult, must, mustString, startTestServer, type TestServer } from "./harness.ts";
import { ScriptedRuntime } from "./scripted-runtime.ts";

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

type SnapshotTables = ConversationSnapshot["tables"];

interface Recorded {
  tables: SnapshotTables;
  conversationId: string;
  taskId: string;
  executionId: string;
}

/**
 * One conversation on a fresh server with debug mode on or off: a user command whose turn streams text and a
 * message, runs an allowed call, and has a forbidden call rejected by policy.
 */
const recordConversation = async (debugMode: boolean): Promise<Recorded> => {
  const runtime = new ScriptedRuntime();
  const server = await startTestServer(runtime, {}, { debugMode });
  servers.push(server);
  const client = await server.connect("client-A");
  await client.startConversation();
  const next = runtime.nextTurn();
  const started = ackResult(await client.submitText("summarise my inbox"));
  const turn = await next;
  turn.init();
  turn.text("Looking at your inbox.");
  await turn.emit({
    type: "assistant_message",
    message: { role: "assistant", content: [{ type: "text", text: "Looking at your inbox." }] },
    at: new Date().toISOString(),
  });
  turn.propose("toolu_read", "mcp__d1__read", {});
  expect((await turn.request("mcp__d1__read", {}, "toolu_read")).behavior).toBe("allow");
  await turn.toolResult("toolu_read", JSON.stringify({ unread: 3 }));
  expect((await turn.request("mcp__d1__forbidden", {}, "toolu_forbidden")).behavior).toBe("deny");
  turn.end();
  await client.waitFor("task_finished");
  const conversationId = must(client.conversationId, "conversation id");
  const catalog = server.catalog();
  try {
    return {
      tables: snapshotConversation(catalog, conversationId).tables,
      conversationId,
      taskId: mustString(started.task_id, "task id"),
      executionId: mustString(started.execution_id, "execution id"),
    };
  } finally {
    catalog.close();
  }
};

const eventsOf = (tables: SnapshotTables, type: JournalEventType) =>
  tables.events.filter((event) => event.type === type);

const payloadOf = (event: { payload: string }): unknown => JSON.parse(event.payload);

describe("debug mode on", () => {
  it("records that the conversation was captured in debug mode, once, at its start", async () => {
    const { tables } = await recordConversation(true);
    const flags = eventsOf(tables, "debug_mode_enabled");
    expect(flags).toHaveLength(1);
    const started = must(eventsOf(tables, "conversation_started")[0], "conversation_started");
    expect(must(flags[0], "flag").sequence).toBe(started.sequence + 1);
  });

  it("records the user's command", async () => {
    const { tables, taskId } = await recordConversation(true);
    expect(tables.tasks).toMatchObject([{ id: taskId, text: "summarise my inbox" }]);
    expect(eventsOf(tables, "task_submitted").map(payloadOf)).toMatchObject([
      { text: "summarise my inbox" },
    ]);
  });

  it("records every id: conversation, task, execution, client and tool call", async () => {
    const { tables, conversationId, taskId, executionId } = await recordConversation(true);
    expect(tables.conversations.map((row) => row.id)).toEqual([conversationId]);
    expect(tables.executions).toMatchObject([{ id: executionId, task_id: taskId }]);
    expect(tables.clients.map((row) => row.id)).toEqual(["client-A"]);
    const submitted = must(eventsOf(tables, "task_submitted")[0], "task_submitted");
    expect(submitted).toMatchObject({
      conversation_id: conversationId,
      task_id: taskId,
      execution_id: executionId,
      client_id: "client-A",
    });
    const calls = tables.tool_calls.map((row) => [row.runtime_call_id, row.execution_id]);
    expect(calls).toEqual([
      ["toolu_read", executionId],
      ["toolu_forbidden", executionId],
    ]);
  });

  it("records the model's actions: its text, its messages and its tool calls", async () => {
    const { tables } = await recordConversation(true);
    expect(eventsOf(tables, "text_delta").map(payloadOf)).toMatchObject([
      { text: "Looking at your inbox." },
    ]);
    expect(eventsOf(tables, "assistant_message")).toHaveLength(1);
    expect(eventsOf(tables, "tool_proposed").map(payloadOf)).toMatchObject([
      { runtime_call_id: "toolu_read", tool_identity: "mcp__d1__read" },
      { runtime_call_id: "toolu_forbidden", tool_identity: "mcp__d1__forbidden" },
    ]);
    expect(eventsOf(tables, "tool_result")).toHaveLength(1);
  });

  it("records a rejection the harness made on its own, with its reason", async () => {
    const { tables } = await recordConversation(true);
    const forbidden = must(
      tables.tool_calls.find((row) => row.runtime_call_id === "toolu_forbidden"),
      "forbidden call",
    );
    expect(forbidden).toMatchObject({
      policy: "deny",
      status: "denied",
      detail: "denied by policy",
    });
    expect(eventsOf(tables, "policy_evaluated").map(payloadOf)).toContainEqual(
      expect.objectContaining({ tool_call_id: forbidden.id, policy: "deny" }),
    );
  });
});

describe("debug mode off", () => {
  it("records nothing of debug mode, and the same records as with it on otherwise", async () => {
    const off = await recordConversation(false);
    const on = await recordConversation(true);
    expect(eventsOf(off.tables, "debug_mode_enabled")).toEqual([]);
    // Two servers differ in ids, times and directories, so compare which records were written, with which
    // columns, rather than their bytes.
    const shape = (tables: SnapshotTables) => ({
      rows: Object.entries(tables).map(([table, rows]) => [
        table,
        Array.isArray(rows) ? rows.map((row) => (isRecord(row) ? Object.keys(row) : row)) : rows,
      ]),
      events: tables.events.map((event) => {
        const payload = payloadOf(event);
        return [event.type, isRecord(payload) ? Object.keys(payload) : payload];
      }),
    });
    const withoutFlag = {
      ...on.tables,
      events: on.tables.events.filter((event) => event.type !== "debug_mode_enabled"),
    };
    expect(shape(off.tables)).toEqual(shape(withoutFlag));
  });
});
