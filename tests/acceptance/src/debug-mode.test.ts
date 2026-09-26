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
 * A fresh server with debug mode on or off whose d1 server names a body log in a fresh directory, as the controlled
 * fixture's profile does (none with `bodyLog` "unconfigured"), and a user command whose turn has started.
 */
const startTurn = async (debugMode: boolean, bodyLog: "configured" | "unconfigured") => {
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
  return { server, client, started, turn, bodyLogFile };
};

/** Writes body log lines as the fixture does: one JSON object per line. */
const writeBodyLog = (path: string, lines: readonly unknown[]): void =>
  writeFileSync(path, lines.map((line) => JSON.stringify(line) + "\n").join(""));

/** The tables of the conversation `client` started, once its task has finished. */
const finishedTables = async (
  server: TestServer,
  client: Awaited<ReturnType<TestServer["connect"]>>,
): Promise<SnapshotTables> => {
  await client.waitFor("task_finished");
  const catalog = server.catalog();
  try {
    return snapshotConversation(catalog, must(client.conversationId, "conversation id")).tables;
  } finally {
    catalog.close();
  }
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
  const { server, client, started, turn, bodyLogFile } = await startTurn(
    debugMode,
    bodyLog === "unconfigured" ? "unconfigured" : "configured",
  );
  turn.text("Looking at your inbox.");
  await turn.emit({
    type: "assistant_message",
    message: { role: "assistant", content: [{ type: "text", text: "Looking at your inbox." }] },
    at: new Date().toISOString(),
  });
  turn.propose("toolu_read", "mcp__d1__read", {});
  expect((await turn.request("mcp__d1__read", {}, "toolu_read")).behavior).toBe("allow");
  if (bodyLog !== "missing")
    writeBodyLog(bodyLogFile, [
      { tool_use_id: "toolu_read", direction: "request", body: READ_REQUEST },
      { tool_use_id: "toolu_other", direction: "request", body: {} },
      { tool_use_id: "toolu_read", direction: "response", body: READ_RESPONSE },
    ]);
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
  return {
    tables: await finishedTables(server, client),
    conversationId: must(client.conversationId, "conversation id"),
    taskId: mustString(started.task_id, "task id"),
    executionId: mustString(started.execution_id, "execution id"),
  };
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

  // What any conversation records, recorded the same way with debug mode on: the ids that tie each row to its
  // conversation, task and execution, the model's actions, and the harness's own rejections.
  it("records the command, the model's actions and the harness's rejections as it does with debug mode off", async () => {
    const { tables, conversationId, taskId, executionId } = await recordConversation(true);
    expect(tables.tasks).toMatchObject([{ id: taskId, text: "summarise my inbox" }]);
    expect(tables.executions).toMatchObject([{ id: executionId, task_id: taskId }]);
    expect(eventsOf(tables, "task_submitted")).toMatchObject([
      {
        conversation_id: conversationId,
        task_id: taskId,
        execution_id: executionId,
        client_id: "client-A",
      },
    ]);
    expect(eventsOf(tables, "tool_proposed").map(payloadOf)).toMatchObject([
      { runtime_call_id: "toolu_read" },
      { runtime_call_id: "toolu_forbidden" },
      { runtime_call_id: "toolu_mystery", redacted_arguments: { query: "is:unread" } },
    ]);
    expect(eventsOf(tables, "tool_result").map(payloadOf)).toMatchObject([
      { runtime_call_id: "toolu_read", content: JSON.stringify({ unread: 3 }) },
    ]);
    expect(callOf(tables, "toolu_forbidden")).toMatchObject({
      task_id: taskId,
      status: "denied",
      detail: "denied by policy",
    });
    expect(callOf(tables, "toolu_mystery")).toMatchObject({
      status: "denied",
      detail: "tool not listed in toolPolicy",
    });
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
    const unreadable = { unrecorded: expect.stringMatching(/^the body log is unreadable: /) };
    expect(mcpBodiesOf(tables).map(payloadOf)).toMatchObject([unreadable, unreadable]);
  });

  it("records no bodies for a call to a server that names no body log", async () => {
    const { tables } = await recordConversation(true, "unconfigured");
    expect(callOf(tables, "toolu_read").status).toBe("completed");
    expect(mcpBodiesOf(tables)).toEqual([]);
  });
});

/** The body log lines the fixture would write for a request with tool-use id `toolUseId`, and its response. */
const bodyLinesFor = (toolUseId: string, id: number) => ({
  request: {
    tool_use_id: toolUseId,
    direction: "request",
    body: {
      ...READ_REQUEST,
      id,
      params: { ...READ_REQUEST.params, _meta: { [TOOL_USE_ID_META]: toolUseId } },
    },
  },
  response: { tool_use_id: toolUseId, direction: "response", body: { ...READ_RESPONSE, id } },
});

const REDACTED_RESULT = { ...READ_RESPONSE.result, api_key: REDACTED };

/**
 * One conversation on a fresh server whose turn runs three allowed calls to the body-logged d1 server: toolu_done
 * gets its result, and the turn is then interrupted while toolu_open and toolu_early are running, so neither gets
 * one. The log holds both of toolu_done's and toolu_open's lines, and only toolu_early's request, as when the
 * server is still handling it.
 */
const recordInterruptedCalls = async (debugMode: boolean): Promise<SnapshotTables> => {
  const { server, client, started, turn, bodyLogFile } = await startTurn(debugMode, "configured");
  const [done, open, early] = [
    bodyLinesFor("toolu_done", 3),
    bodyLinesFor("toolu_open", 4),
    bodyLinesFor("toolu_early", 5),
  ];
  expect((await turn.request("mcp__d1__read", {}, "toolu_done")).behavior).toBe("allow");
  writeBodyLog(bodyLogFile, [done.request, done.response]);
  await turn.toolResult("toolu_done", JSON.stringify({ unread: 3 }));
  for (const runtimeCallId of ["toolu_open", "toolu_early"])
    expect((await turn.request("mcp__d1__read", {}, runtimeCallId)).behavior).toBe("allow");
  writeBodyLog(bodyLogFile, [
    done.request,
    done.response,
    open.request,
    early.request,
    open.response,
  ]);
  expect((await client.interrupt(mustString(started.task_id, "task id"))).disposition).toBe(
    "accepted",
  );
  return finishedTables(server, client);
};

/** The MCP body events recorded for the call with id `callId`, in order. */
const bodyEventsOfCall = (tables: SnapshotTables, callId: unknown) =>
  mcpBodiesOf(tables).filter((event) => {
    const payload = payloadOf(event);
    return isRecord(payload) && payload.tool_call_id === callId;
  });

/** The MCP body events recorded for the call with id `callId`, as [type, payload] pairs. */
const bodiesOfCall = (tables: SnapshotTables, callId: unknown) =>
  bodyEventsOfCall(tables, callId).map((event) => [event.type, payloadOf(event)]);

describe("debug mode on: MCP bodies of calls without a tool result", () => {
  it("records, at turn end, the bodies of each released call whose result never arrived, and only of those", async () => {
    const tables = await recordInterruptedCalls(true);
    const open = callOf(tables, "toolu_open");
    const early = callOf(tables, "toolu_early");
    expect([open.status, early.status]).toEqual(["unknown", "unknown"]);
    const lines = { open: bodyLinesFor("toolu_open", 4), early: bodyLinesFor("toolu_early", 5) };
    expect(bodiesOfCall(tables, open.id)).toEqual([
      [
        "mcp_request",
        { tool_call_id: open.id, runtime_call_id: "toolu_open", body: lines.open.request.body },
      ],
      [
        "mcp_response",
        {
          tool_call_id: open.id,
          runtime_call_id: "toolu_open",
          body: { ...lines.open.response.body, result: REDACTED_RESULT },
        },
      ],
    ]);
    // Only its request was logged: the server may still be handling it, so the response is only not written yet.
    expect(bodiesOfCall(tables, early.id)).toEqual([
      [
        "mcp_request",
        { tool_call_id: early.id, runtime_call_id: "toolu_early", body: lines.early.request.body },
      ],
      [
        "mcp_response",
        {
          tool_call_id: early.id,
          runtime_call_id: "toolu_early",
          unrecorded: "the body log had no response for this call when its turn ended",
        },
      ],
    ]);
    // Recorded with the turn's end, in its task and execution, before the task finished; no result caused them.
    const outcome = must(eventsOf(tables, "interruption_outcome")[0], "interruption_outcome");
    const atTurnEnd = mcpBodiesOf(tables).filter((event) => event.caused_by_event_id === null);
    expect(atTurnEnd).toHaveLength(4);
    for (const event of atTurnEnd) {
      expect(event).toMatchObject({ task_id: outcome.task_id, execution_id: outcome.execution_id });
      expect(event.sequence).toBeLessThan(outcome.sequence);
    }
    // A call that got its result had its bodies recorded with that result, not again at turn end.
    const done = callOf(tables, "toolu_done");
    const result = must(eventsOf(tables, "tool_result")[0], "tool_result");
    expect(
      bodyEventsOfCall(tables, done.id).map((event) => [event.type, event.caused_by_event_id]),
    ).toEqual([
      ["mcp_request", result.id],
      ["mcp_response", result.id],
    ]);
  });

  it("records no bodies for them with debug mode off", async () => {
    const tables = await recordInterruptedCalls(false);
    expect(callOf(tables, "toolu_open").status).toBe("unknown");
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
