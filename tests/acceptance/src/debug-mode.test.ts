import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startFixture } from "@mia/controlled-mcp";
import { TOOL_USE_ID_META } from "@mia/mcp-http";
import { isRecord, REDACTED } from "@mia/protocol";
import {
  snapshotConversation,
  type JournalEventType,
  type ConversationSnapshot,
} from "@mia/records";
import {
  ackResult,
  FAKE_RUNTIME,
  FAKE_RUNTIME_ENV,
  must,
  mustString,
  startTestServer,
  type TestServer,
} from "./harness.ts";
import { ScriptedRuntime } from "./scripted-runtime.ts";

const servers: TestServer[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

type SnapshotTables = ConversationSnapshot["tables"];

interface Recorded {
  tables: SnapshotTables;
  conversationId: string;
  taskId: string;
  executionId: string;
}

/** The body log lines the fixture would write for the allowed read call: its request, and its response. */
const READ_REQUEST = {
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "read", arguments: {}, _meta: { [TOOL_USE_ID_META]: "toolu_read" } },
};
const READ_RESPONSE = {
  jsonrpc: "2.0",
  id: 3,
  result: { content: [{ type: "text", text: JSON.stringify({ unread: 3 }) }], api_key: "sk-live" },
};

/**
 * One conversation on a fresh server with debug mode on or off: a user command whose turn streams text and a
 * message, runs an allowed call, and has a forbidden call and an unlisted call rejected by policy. The d1 server
 * names a body log, as the controlled fixture's profile does, and the allowed call's lines are written to it before
 * its result arrives. With `bodyLog` "missing" none are written; with "expired" they are, but the result's read of
 * them outlives its deadline; with "unconfigured" the server names no body log.
 */
const recordConversation = async (
  debugMode: boolean,
  bodyLog: "written" | "missing" | "expired" | "unconfigured" = "written",
): Promise<Recorded> => {
  const logDirectory = mkdtempSync(join(tmpdir(), "mia-body-log-"));
  directories.push(logDirectory);
  const bodyLogFile = join(logDirectory, "mcp-bodies.jsonl");
  const runtime = new ScriptedRuntime();
  const server = await startTestServer(
    runtime,
    bodyLog === "unconfigured"
      ? {}
      : {
          mcpServers: { d1: { type: "http", url: "http://127.0.0.1:1/mcp", bodyLog: bodyLogFile } },
        },
    { debugMode },
  );
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
  if (bodyLog !== "missing")
    writeFileSync(
      bodyLogFile,
      [
        { tool_use_id: "toolu_read", direction: "request", body: READ_REQUEST },
        { tool_use_id: "toolu_other", direction: "request", body: {} },
        { tool_use_id: "toolu_read", direction: "response", body: READ_RESPONSE },
      ]
        .map((line) => JSON.stringify(line) + "\n")
        .join(""),
    );
  const held = bodyLog === "expired" ? server.holdEvidenceRead(bodyLogFile) : null;
  const result = turn.toolResult("toolu_read", JSON.stringify({ unread: 3 }));
  if (held) {
    await held.started;
    server.expireEvidenceReads();
  }
  await result;
  expect((await turn.request("mcp__d1__forbidden", {}, "toolu_forbidden")).behavior).toBe("deny");
  const mystery = await turn.request("mcp__d1__mystery", { query: "is:unread" }, "toolu_mystery");
  expect(mystery.behavior).toBe("deny");
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

/**
 * The tables that hold what the conversation did. The provenance tables (objects, artifacts and their links) are
 * left out: their rows follow the source tree the server runs from, such as whether it has local changes.
 */
const CONVERSATION_TABLES: readonly (keyof SnapshotTables)[] = [
  "conversations",
  "clients",
  "client_connections",
  "tasks",
  "executions",
  "events",
  "commands",
  "tool_calls",
  "approvals",
  "diagnostics",
];

const POLICY_EVALUATED = [
  "tool_call_id",
  "tool_identity",
  "policy",
  "gate_open",
  "execution_epoch",
  "binding_revision",
];
const PERMISSION_PROPOSAL = [
  "runtime_call_id",
  "tool_identity",
  "redacted_arguments",
  "argument_digest",
  "source",
];

/** A call's row, found by the runtime's id for it: rows come back in id order, and ids are random. */
const callOf = (tables: SnapshotTables, runtimeCallId: string) =>
  must(
    tables.tool_calls.find((row) => row.runtime_call_id === runtimeCallId),
    `call ${runtimeCallId}`,
  );

describe("debug mode on", () => {
  it("records that the conversation was captured in debug mode, once, right after it started", async () => {
    const { tables } = await recordConversation(true);
    const flags = eventsOf(tables, "captured_in_debug_mode");
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
    for (const runtimeCallId of ["toolu_read", "toolu_forbidden", "toolu_mystery"])
      expect(callOf(tables, runtimeCallId)).toMatchObject({
        id: expect.stringMatching(/^call_/),
        task_id: taskId,
        execution_id: executionId,
      });
  });

  it("records the model's actions: its text, its messages, its tool calls and their results", async () => {
    const { tables } = await recordConversation(true);
    expect(eventsOf(tables, "text_delta").map(payloadOf)).toMatchObject([
      { text: "Looking at your inbox." },
    ]);
    expect(eventsOf(tables, "assistant_message").map(payloadOf)).toEqual([
      { role: "assistant", content: [{ type: "text", text: "Looking at your inbox." }] },
    ]);
    expect(eventsOf(tables, "tool_proposed").map(payloadOf)).toMatchObject([
      { runtime_call_id: "toolu_read", tool_identity: "mcp__d1__read" },
      { runtime_call_id: "toolu_forbidden", tool_identity: "mcp__d1__forbidden" },
      {
        runtime_call_id: "toolu_mystery",
        tool_identity: "mcp__d1__mystery",
        redacted_arguments: { query: "is:unread" },
      },
    ]);
    expect(eventsOf(tables, "tool_result").map(payloadOf)).toMatchObject([
      { runtime_call_id: "toolu_read", content: JSON.stringify({ unread: 3 }) },
    ]);
  });

  it("records each rejection the harness made on its own, with its reason", async () => {
    const { tables } = await recordConversation(true);
    expect(callOf(tables, "toolu_forbidden")).toMatchObject({
      policy: "deny",
      status: "denied",
      detail: "denied by policy",
    });
    expect(callOf(tables, "toolu_mystery")).toMatchObject({
      status: "denied",
      detail: "tool not listed in toolPolicy",
    });
    expect(eventsOf(tables, "error").map(payloadOf)).toMatchObject([
      {
        code: "configuration_error",
        message: "tool mcp__d1__mystery is not listed in toolPolicy; call denied",
      },
    ]);
  });
});

/** The MCP body events a conversation recorded, in order. */
const mcpBodiesOf = (tables: SnapshotTables) =>
  tables.events.filter((event) => event.type === "mcp_request" || event.type === "mcp_response");

describe("debug mode on: MCP bodies", () => {
  it("records the request and response bodies of a call to a body-logged server, redacted, under the call", async () => {
    const { tables } = await recordConversation(true);
    const call = callOf(tables, "toolu_read");
    const result = must(eventsOf(tables, "tool_result")[0], "tool_result");
    const bodies = mcpBodiesOf(tables);
    expect(bodies.map((event) => [event.type, payloadOf(event)])).toEqual([
      ["mcp_request", { tool_call_id: call.id, runtime_call_id: "toolu_read", body: READ_REQUEST }],
      [
        "mcp_response",
        {
          tool_call_id: call.id,
          runtime_call_id: "toolu_read",
          body: { ...READ_RESPONSE, result: { ...READ_RESPONSE.result, api_key: REDACTED } },
        },
      ],
    ]);
    // Recorded with the result that caused them, right after it, in its task and execution.
    bodies.forEach((event, index) =>
      expect(event).toMatchObject({
        caused_by_event_id: result.id,
        task_id: result.task_id,
        execution_id: result.execution_id,
        sequence: result.sequence + 1 + index,
      }),
    );
  });

  it("records why a call's bodies are missing when its server's body log does not exist", async () => {
    const { tables } = await recordConversation(true, "missing");
    const call = callOf(tables, "toolu_read");
    expect(mcpBodiesOf(tables).map((event) => [event.type, payloadOf(event)])).toEqual(
      (["mcp_request", "mcp_response"] as const).map((type) => [
        type,
        {
          tool_call_id: call.id,
          runtime_call_id: "toolu_read",
          unrecorded: "the body log does not exist",
        },
      ]),
    );
  });

  it("records why a call's bodies are missing when reading its body log outlives the deadline", async () => {
    const { tables } = await recordConversation(true, "expired");
    expect(mcpBodiesOf(tables).map(payloadOf)).toEqual([
      expect.objectContaining({
        unrecorded: expect.stringMatching(/^the body log is unreadable: /),
      }),
      expect.objectContaining({
        unrecorded: expect.stringMatching(/^the body log is unreadable: /),
      }),
    ]);
  });

  it("records no bodies for a call to a server that names no body log", async () => {
    const { tables } = await recordConversation(true, "unconfigured");
    expect(callOf(tables, "toolu_read").status).toBe("completed");
    expect(mcpBodiesOf(tables)).toEqual([]);
  });
});

describe("debug mode on: MCP bodies from the controlled fixture", () => {
  it("records the bodies the fixture logged for a call the runtime made to it", async () => {
    const fixtureDirectory = mkdtempSync(join(tmpdir(), "mia-fixture-"));
    directories.push(fixtureDirectory);
    const fixture = await startFixture({ dir: fixtureDirectory });
    try {
      const server = await startTestServer(
        undefined,
        {
          executable: FAKE_RUNTIME,
          mcpServers: {
            d1: { type: "http", url: fixture.mcpUrl, bodyLog: fixture.bodyLogFile },
          },
        },
        { env: FAKE_RUNTIME_ENV, debugMode: true },
      );
      servers.push(server);
      const client = await server.connect("client-A");
      await client.startConversation();
      await client.submitText("READ");
      await client.waitFor("task_finished");
      const catalog = server.catalog();
      let tables: SnapshotTables;
      try {
        tables = snapshotConversation(catalog, must(client.conversationId, "conversation")).tables;
      } finally {
        catalog.close();
      }
      const call = callOf(tables, "toolu_fake_read_1");
      expect(mcpBodiesOf(tables).map((event) => [event.type, payloadOf(event)])).toMatchObject([
        [
          "mcp_request",
          {
            tool_call_id: call.id,
            body: {
              method: "tools/call",
              params: { name: "read", _meta: { [TOOL_USE_ID_META]: "toolu_fake_read_1" } },
            },
          },
        ],
        [
          "mcp_response",
          { tool_call_id: call.id, body: { result: { content: [{ type: "text" }] } } },
        ],
      ]);
    } finally {
      await fixture.close();
    }
  });
});

describe("debug mode off", () => {
  /**
   * What a conversation records with debug mode off, pinned: which rows each table holds and which events, with
   * which payload fields. Ids, times and directories differ between servers, so they are left out, and so are the
   * provenance tables (see CONVERSATION_TABLES). Change this
   * only for a deliberate change to what every conversation records; debug mode must never change it.
   */
  const OFF_MODE_RECORDS = {
    rows: [
      ["conversations", 1],
      ["clients", 1],
      ["client_connections", 1],
      ["tasks", 1],
      ["executions", 1],
      ["events", 19],
      ["commands", 1],
      ["tool_calls", 3],
      ["approvals", 0],
      ["diagnostics", 0],
    ],
    events: [
      [
        "provenance_recorded",
        [
          "provenance_set_id",
          "agent_prompt_digest",
          "agent_prompt_version",
          "configuration_digest",
          "architecture_revision",
          "server_build",
          "runtime_version",
          "entries",
        ],
      ],
      ["conversation_started", ["conversation_id", "started_at", "provenance_set_id"]],
      ["task_submitted", ["text", "runtime_prompt", "mia_note", "command_id"]],
      ["task_started", ["conversation_id", "task_id", "execution_id", "execution_epoch", "text"]],
      ["runtime_init", ["scripted", "session", "model"]],
      ["text_delta", ["conversation_id", "task_id", "execution_id", "text"]],
      ["assistant_message", ["role", "content"]],
      [
        "tool_proposed",
        ["runtime_call_id", "tool_identity", "redacted_arguments", "argument_digest"],
      ],
      ["policy_evaluated", POLICY_EVALUATED],
      ["tool_dispatched", ["tool_call_id", "runtime_call_id", "tool_identity", "policy", "via"]],
      ["tool_result", ["runtime_call_id", "is_error", "content", "raw"]],
      ["tool_proposed", PERMISSION_PROPOSAL],
      ["policy_evaluated", POLICY_EVALUATED],
      ["tool_proposed", PERMISSION_PROPOSAL],
      ["policy_evaluated", POLICY_EVALUATED],
      ["error", ["code", "message", "conversation_id", "task_id"]],
      ["runtime_result", ["scripted", "session"]],
      ["runtime_exit", ["code", "signal"]],
      ["task_finished", ["conversation_id", "task_id", "status", "usage"]],
    ],
  };

  const recordedShape = (tables: SnapshotTables) => ({
    rows: CONVERSATION_TABLES.map((table) => [table, tables[table].length]),
    events: tables.events.map((event) => {
      const payload = payloadOf(event);
      return [event.type, isRecord(payload) ? Object.keys(payload) : payload];
    }),
  });

  it("records exactly what a conversation recorded before debug mode existed, even with a body log to read", async () => {
    const { tables } = await recordConversation(false);
    expect(eventsOf(tables, "captured_in_debug_mode")).toEqual([]);
    expect(recordedShape(tables)).toEqual(OFF_MODE_RECORDS);
  });
});
