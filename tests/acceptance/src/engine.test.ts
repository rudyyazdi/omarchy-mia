import { execFileSync } from "node:child_process";
import {
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ApprovalStatus,
  type Decision,
  type ServerEventType,
  type TaskStatus,
  type ToolCallStatus,
} from "@mia/protocol";
import { ObjectStore, type CaptureStatus, type LinkRelation } from "@mia/records";
import { MAX_CONVERSATION_FILE_BYTES, MAX_HELD_PROMPTS } from "@mia/server";
import type { AckPayload, MiaClient } from "@mia/text-client";
import { ScriptedRuntime, type ScriptedTurn } from "./scripted-runtime.ts";
import {
  ackError,
  ackResult,
  must,
  mustString,
  startTestServer,
  useScriptedSession,
  type HeldRead,
  type TestServer,
} from "./harness.ts";

let runtime: ScriptedRuntime;
let ts: TestServer;
let client: MiaClient;
const restartSession = useScriptedSession((session) => {
  ({ runtime, server: ts, client } = session);
});

const submit = async (
  text: string,
  messageId?: string,
): Promise<{ turn: ScriptedTurn; taskId: string }> => {
  const next = runtime.nextTurn();
  const ack = await client.submitText(text, { messageId });
  expect(ack.disposition).toBe("accepted");
  const turn = await next;
  return { turn, taskId: mustString(ackResult(ack).task_id, "ack task_id") };
};

/** Submit `text` and have its runtime report its init. */
const startTurn = async (text: string): Promise<{ turn: ScriptedTurn; taskId: string }> => {
  const submitted = await submit(text);
  submitted.turn.init();
  return submitted;
};

/**
 * End `turn` and wait for its task to finish. An earlier task's task_finished satisfies a wait without a predicate,
 * so a later turn passes its `taskId`.
 */
const finishTurn = (turn: ScriptedTurn, taskId?: string) => {
  turn.end();
  return client.waitFor(
    "task_finished",
    (event) => taskId === undefined || event.payload.task_id === taskId,
  );
};

const rows = <T = Record<string, unknown>>(sql: string, ...params: (string | number)[]): T[] => {
  const cat = ts.catalog();
  try {
    return cat.all<T>(sql, ...params);
  } finally {
    cat.close();
  }
};

/** How many events of `type` are recorded. */
const eventCount = (type: string): number =>
  rows("SELECT id FROM events WHERE type = ?", type).length;

/** Every tool call's status, for the tests that make one call or one call's revisions. */
const callStatuses = (): ToolCallStatus[] =>
  rows<{ status: ToolCallStatus }>(
    "SELECT status FROM tool_calls ORDER BY created_at, binding_revision",
  ).map((row) => row.status);

/** Submit a turn whose one tool call is held at the approval gate: where the approval and interruption tests start. */
const submitHeldCall = async (
  text: string,
  tool = "mcp__d1__change",
  args: Record<string, unknown> = { delta: 1 },
) => {
  const { turn, taskId } = await startTurn(text);
  const held = turn.request(tool, args, "toolu_1");
  const requested = await client.waitFor("approval_requested");
  return { turn, taskId, held, requested };
};

const taskStatus = (taskId: string): TaskStatus =>
  must(rows<{ status: TaskStatus }>("SELECT status FROM tasks WHERE id = ?", taskId)[0], "task row")
    .status;

/** The effort evidence recorded with the task's execution. */
const effortEvidence = (taskId: string): unknown =>
  JSON.parse(
    must(
      rows<{ effort_evidence: string }>(
        "SELECT effort_evidence FROM executions WHERE task_id = ?",
        taskId,
      )[0],
      "execution row",
    ).effort_evidence,
  );

/** The task is running again, in the records and in memory: a new submission is told to wait, not to decide. */
const expectResumed = async (taskId: string): Promise<void> => {
  expect(taskStatus(taskId)).toBe("running");
  const busy = await client.submitText("another");
  expect(ackError(busy)).toMatchObject({
    code: "busy",
    message: expect.stringContaining("is running; wait for it to finish or interrupt it"),
  });
};

const decide = (taskId: string, approvalId: string, decision: Decision) =>
  client.decide({ taskId: taskId, approvalId: approvalId, decision: decision });

/**
 * Make the next catalog transaction do its work and then fail to commit, so it rolls back after the engine
 * has run everything it runs inside a transaction.
 */
const failNextCommit = (): void => {
  const catalog = ts.server.catalog;
  const original = catalog.transaction.bind(catalog);
  catalog.transaction = <T>(fn: () => T): T => {
    catalog.transaction = original;
    return original(() => {
      fn();
      throw new Error("simulated commit failure");
    });
  };
};

/**
 * Watch every catalog transaction from now on for one that writes an object: a write inside a transaction stalls
 * every connection while it runs. Returns whether any did.
 */
const watchObjectWrites = (): (() => boolean) => {
  const catalog = ts.server.catalog;
  const objects = join(catalog.paths.root, "objects");
  const entries = () =>
    existsSync(objects) ? readdirSync(objects, { recursive: true }).length : 0;
  let writtenInside = false;
  const original = catalog.transaction.bind(catalog);
  catalog.transaction = <T>(fn: () => T): T => {
    const before = entries();
    try {
      return original(fn);
    } finally {
      writtenInside ||= entries() > before;
    }
  };
  return () => writtenInside;
};

/** How many conversations and provenance sets are recorded: what a refused start must leave unchanged. */
const conversationRecords = () => ({
  conversations: rows("SELECT id FROM conversations").length,
  sets: rows("SELECT id FROM provenance_sets").length,
});

/** Whether the object store holds bytes for `digest`. */
const objectStored = (digest: string | null): boolean =>
  digest !== null && existsSync(new ObjectStore(ts.server.catalog.paths).pathFor(digest));

/** Make every object write fail: a file where the object store stages its writes. */
const failObjectWrites = (): void => {
  const { staging } = ts.server.catalog.paths;
  rmSync(staging, { recursive: true });
  writeFileSync(staging, "");
};

/** Make inserting an artifact link with `relation` fail, after the rows before it are written, when `when` holds. */
const failArtifactLinks = (relation: LinkRelation, when: string): void => {
  ts.server.catalog.db.exec(`CREATE TRIGGER fail_${relation}_link BEFORE INSERT ON artifact_links
    WHEN NEW.relation = '${relation}' AND ${when}
    BEGIN SELECT RAISE(ABORT, 'simulated link failure'); END`);
};

/** Write a file into the profile's output directory, where a declared tool output may be retained from. */
const writeOutputFile = (name: string, text: string): string => {
  const outDir = must(ts.profile.runtime.outputDirectories[0], "output directory");
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, name);
  writeFileSync(file, text);
  return file;
};

/** Submit one artifact call and approve it, with `result.txt` written where its output may be retained from. */
const approvedArtifactCall = async (): Promise<{
  file: string;
  turn: ScriptedTurn;
  taskId: string;
}> => {
  const file = writeOutputFile("result.txt", "D1");
  const { turn, taskId, held, requested } = await submitHeldCall("artifact", "mcp__d1__artifact", {
    name: "result.txt",
  });
  await decide(taskId, requested.payload.approval_id, "approve");
  await held;
  return { file, turn, taskId };
};

/** Hand over the approved call's result, declaring `file` as its output. */
const declareOutput = (turn: ScriptedTurn, file: string): Promise<void> =>
  turn.toolResult("toolu_1", JSON.stringify({ artifact: { path: file, name: "result.txt" } }));

const countRows = (table: string): number => rows(`SELECT 1 FROM ${table}`).length;

/** Make every delivery of one event type to the client throw, as a failing socket would. */
const failDelivery = (type: ServerEventType): void => {
  const { engine, gateway } = ts.server;
  engine.attachDelivery((connectionId, event) => {
    if (event.type === type) throw new Error("simulated socket failure");
    gateway.send(connectionId, event);
  });
};

/** Approval statuses in catalog order: how these tests show that nothing was authorised. */
const approvalStatuses = (): ApprovalStatus[] =>
  rows<{ status: ApprovalStatus }>("SELECT status FROM approvals").map((row) => row.status);

/** End a turn whose one call's prompt was abandoned: the call ends invalidated, and the next turn is told it never ran. */
const expectAbandonedAtTurnEnd = async (turn: ScriptedTurn): Promise<void> => {
  expect((await finishTurn(turn)).payload.status).toBe("completed");
  expect(callStatuses()).toEqual(["invalidated"]);
  expect(approvalStatuses()).toEqual(["expired"]);
  const { turn: next } = await submit("did it run?");
  expect(next.options.text).toContain("abandoned the approval prompt");
  next.end();
};

describe("streaming and commands", () => {
  it("streams deltas in order before completion and deduplicates command ids", async () => {
    const { turn, taskId } = await submit("hello", "cmd-1");
    turn.init();
    turn.text("Hel");
    turn.text("lo");
    expect((await finishTurn(turn)).payload.status).toBe("completed");
    const deltas = client.events.flatMap((event) =>
      event.type === "text_delta" ? [event.payload.text] : [],
    );
    expect(deltas).toEqual(["Hel", "lo"]);
    const idx = (type: string) => client.events.findIndex((event) => event.type === type);
    expect(idx("text_delta")).toBeLessThan(idx("task_finished"));
    const seqs = client.events.flatMap((event) =>
      event.sequence === null ? [] : [event.sequence],
    );
    expect([...seqs].sort((left, right) => left - right)).toEqual(seqs);
    // resend with the same message id: the original reply marked duplicate, no new task
    const dup = await client.submitText("hello", { messageId: "cmd-1" });
    expect(dup).toMatchObject({
      disposition: "accepted",
      duplicate: true,
      result: { task_id: taskId },
    });
    expect(runtime.turns).toHaveLength(1);
    // same id, different payload: conflict, nothing executed
    const conflict = await client.submitText("different", { messageId: "cmd-1" });
    expect(conflict.disposition).toBe("rejected");
    expect(ackError(conflict).code).toBe("duplicate_command_conflict");
    expect(rows("SELECT id FROM tasks")).toHaveLength(1);
    expect(taskStatus(taskId)).toBe("completed");
  });

  it("answers a resend on a new connection of the same client with the original reply", async () => {
    const started = await client.send("start_conversation", {}, { messageId: "cmd-start" });
    client.conversationId = mustString(ackResult(started).conversation_id, "conversation id");
    const { turn, taskId } = await submit("hello", "cmd-1");
    const busy = await client.submitText("second", { messageId: "cmd-2" });
    expect(ackError(busy).code).toBe("busy");
    // Finished first, so a resend of cmd-2 that runs again would be accepted, not `busy`.
    await finishTurn(turn);
    client.close();
    const again = await ts.connect("client-A");
    again.conversationId = client.conversationId;
    const resent = await again.submitText("hello", { messageId: "cmd-1" });
    expect(resent).toEqual({
      command_id: "cmd-1",
      disposition: "accepted",
      duplicate: true,
      result: { task_id: taskId, execution_id: expect.any(String), execution_epoch: 1 },
    });
    expect(runtime.turns).toHaveLength(1);
    expect(await again.submitText("second", { messageId: "cmd-2" })).toEqual({
      ...busy,
      duplicate: true,
    });
    expect(await again.send("start_conversation", {}, { messageId: "cmd-start" })).toEqual({
      ...started,
      duplicate: true,
    });
  });

  /** Submit "hello" as cmd-1 under an injected fault: its turn starts, but the ack reports it failed. */
  const submitThatFails = async (): Promise<{ failed: AckPayload; turn: ScriptedTurn }> => {
    const started = runtime.nextTurn();
    const failed = await client.submitText("hello", { messageId: "cmd-1" });
    expect(failed).toMatchObject({ disposition: "failed", error: { code: "internal" } });
    return { failed, turn: await started };
  };

  const cmd1Rows = () =>
    rows("SELECT disposition, error_code FROM commands WHERE client_command_id = 'cmd-1'");

  /** A resend of cmd-1 repeats the failed reply, starts no second turn, and leaves the record failed. */
  const expectResendRepeats = async (failed: AckPayload, turn: ScriptedTurn): Promise<void> => {
    expect(await client.submitText("hello", { messageId: "cmd-1" })).toEqual({
      ...failed,
      duplicate: true,
    });
    expect(runtime.turns).toHaveLength(1);
    expect(cmd1Rows()).toEqual([{ disposition: "failed", error_code: "internal" }]);
    await finishTurn(turn);
  };

  it("answers a command that fails after it is recorded as failed, and never runs it again", async () => {
    const engine = ts.server.engine;
    const original = engine.submitText.bind(engine);
    engine.submitText = (ctx, payload) => {
      engine.submitText = original;
      original(ctx, payload);
      throw new Error("simulated failure after dispatch");
    };
    const { failed, turn } = await submitThatFails();
    expect(ackError(failed).message).not.toContain("nothing executed");
    expect(failed.duplicate).toBeUndefined();
    await expectResendRepeats(failed, turn);
  });

  it("settles a command whose outcome could not be stored as failed when it is resent", async () => {
    const { db } = ts.server.catalog;
    db.exec(`CREATE TRIGGER fail_command_finish BEFORE UPDATE ON commands
      BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`);
    const { failed, turn } = await submitThatFails();
    expect(cmd1Rows()).toEqual([{ disposition: "received", error_code: null }]);
    db.exec("DROP TRIGGER fail_command_finish");
    await expectResendRepeats(failed, turn);
  });

  it("rejects an undecodable submission and a submission while a task runs, from any client", async () => {
    const big = await client.submitText("x".repeat(40_000));
    expect(ackError(big).code).toBe("invalid_message");
    const { turn } = await submit("first");
    expect(ackError(await client.submitText("second")).code).toBe("busy");
    const other = await ts.connect("client-B");
    const otherBusy = await other.send("submit_text", {
      conversation_id: must(client.conversationId, "conversation id"),
      text: "hi",
    });
    expect(ackError(otherBusy).code).toBe("busy");
    await finishTurn(turn);
  });

  /**
   * Ends the turn with its hook evidence `line`, and holds the engine's turn-end read of it until `release`.
   * Resolves once the engine has started that read.
   */
  const endHoldingHookEvidence = async (turn: ScriptedTurn, line: string) => {
    writeFileSync(turn.hookEvidencePath, line);
    const held = ts.holdEvidenceRead(turn.hookEvidencePath);
    turn.end();
    await held.started;
    return held;
  };

  /** The transcript artifacts a task recorded. */
  const transcriptArtifacts = (taskId: string) =>
    rows<{
      capture_status: CaptureStatus;
      capture_reason: string | null;
      object_digest: string | null;
    }>(
      `SELECT a.capture_status, a.capture_reason, a.object_digest FROM artifacts a
       JOIN artifact_links l ON l.artifact_id = a.id
       WHERE l.task_id = ? AND l.relation = 'runtime_transcript'`,
      taskId,
    );

  it("records FIFOs left as a turn's evidence unreadable without reading them, turn after turn", async () => {
    // More turns than libuv has worker threads (4), so reads that each kept one blocked would stall every later one.
    const turns = 5;
    const taskIds: string[] = [];
    for (let index = 0; index < turns; index += 1) {
      const { turn, taskId } = await startTurn(`turn ${index}`);
      taskIds.push(taskId);
      execFileSync("mkfifo", [turn.hookEvidencePath]);
      turn.transcriptAs = "fifo";
      await finishTurn(turn, taskId);
    }
    for (const taskId of taskIds) {
      expect(taskStatus(taskId)).toBe("completed");
      expect(effortEvidence(taskId)).toMatchObject({
        values: [],
        read_error: "not a regular file",
        note: expect.stringContaining("hook evidence unreadable (not a regular file"),
      });
      expect(transcriptArtifacts(taskId)).toEqual([
        {
          capture_status: "failed",
          capture_reason: expect.stringContaining("unreadable: not a regular file"),
          object_digest: null,
        },
      ]);
    }
    const { turn, taskId } = await startTurn("and now?");
    writeFileSync(turn.hookEvidencePath, `${JSON.stringify({ effort: "medium" })}\n`);
    await finishTurn(turn, taskId);
    expect(effortEvidence(taskId)).toMatchObject({ values: ["medium"], read_error: null });
    expect(transcriptArtifacts(taskId)).toEqual([
      { capture_status: "retained", capture_reason: null, object_digest: expect.any(String) },
    ]);
  });

  it("answers another connection while a turn-end read is held open, then records the turn", async () => {
    const { turn, taskId } = await startTurn("hello");
    const held = await endHoldingHookEvidence(turn, `${JSON.stringify({ effort: "medium" })}\n`);
    const other = await ts.connect("client-B");
    expect((await other.sendDiagnostics()).disposition).toBe("accepted");
    expect(taskStatus(taskId)).toBe("running");
    held.release();
    expect((await client.waitFor("task_finished")).payload.status).toBe("completed");
    expect(effortEvidence(taskId)).toMatchObject({ values: ["medium"] });
  });

  it("records a turn whose runtime exited as it ended, when an interruption arrives while it is recorded", async () => {
    const { turn, taskId } = await startTurn("hello");
    const held = await endHoldingHookEvidence(turn, "");
    expect(ackResult(await client.interrupt(taskId))).toEqual({ runtime_ended: true });
    held.release();
    expect((await client.waitFor("task_finished")).payload.status).toBe("completed");
    expect(taskStatus(taskId)).toBe("completed");
    expect(rows("SELECT 1 FROM events WHERE type LIKE 'interruption%'")).toEqual([]);
    const { turn: next, taskId: nextId } = await submit("and now?");
    expect(next.options.text).not.toContain("[Mia note, not from the user]");
    await finishTurn(next, nextId);
  });

  it("never releases a call approved after its runtime exited, while the turn is recorded", async () => {
    const { turn, taskId, held: request, requested } = await submitHeldCall("change");
    const held = await endHoldingHookEvidence(turn, "");
    const ack = await decide(taskId, requested.payload.approval_id, "approve");
    expect(ackResult(ack).released).toBe(false);
    expect((await request).behavior).toBe("deny");
    held.release();
    expect((await client.waitFor("task_finished")).payload.status).toBe("completed");
    expect(callStatuses()).toEqual(["blocked_gate"]);
  });

  it("records a turn finished without the evidence whose read outlives its deadline", async () => {
    const { turn, taskId } = await startTurn("hello");
    await endHoldingHookEvidence(turn, `${JSON.stringify({ effort: "medium" })}\n`);
    ts.expireEvidenceReads();
    expect((await client.waitFor("task_finished")).payload.status).toBe("completed");
    expect(taskStatus(taskId)).toBe("completed");
    expect(effortEvidence(taskId)).toMatchObject({ values: [], read_error: "timed out" });
    const { turn: next, taskId: nextId } = await submit("and now?");
    await finishTurn(next, nextId);
  });

  it("records a turn whose evidence read is still held when shutdown stops waiting", async () => {
    const { turn, taskId } = await startTurn("hello");
    await endHoldingHookEvidence(turn, "");
    const turnWait = new AbortController();
    const closing = ts.server.close(turnWait.signal);
    turnWait.abort();
    await closing;
    expect(taskStatus(taskId)).toBe("completed");
    expect(effortEvidence(taskId)).toMatchObject({ read_error: "abandoned at shutdown" });
    expect(ts.logs).not.toContainEqual(expect.stringContaining("unrecorded"));
  });

  it("keeps the transcript of a turn that shutdown interrupts, read after shutdown began", async () => {
    const { turn, taskId } = await startTurn("hello");
    const closing = ts.server.close(new AbortController().signal);
    expect(turn.interrupted).toBe(true);
    turn.end(); // a no-op once the kill ended it
    await closing;
    expect(taskStatus(taskId)).toBe("interrupted");
    expect(transcriptArtifacts(taskId)).toMatchObject([{ capture_status: "retained" }]);
  });

  it("stores a turn's transcript before the transaction that records the turn finished opens", async () => {
    const { turn, taskId } = await startTurn("hello");
    const writtenInside = watchObjectWrites();
    await finishTurn(turn);
    const [transcript] = transcriptArtifacts(taskId);
    expect(transcript?.capture_status).toBe("retained");
    expect(objectStored(transcript?.object_digest ?? null)).toBe(true);
    expect(writtenInside()).toBe(false);
  });

  it("records a turn finished, and why its transcript is missing, when the transcript cannot be stored", async () => {
    const { turn, taskId } = await startTurn("hello");
    failObjectWrites();
    expect((await finishTurn(turn)).payload.status).toBe("completed");
    expect(taskStatus(taskId)).toBe("completed");
    expect(transcriptArtifacts(taskId)).toEqual([
      {
        capture_status: "failed",
        capture_reason: expect.stringContaining("not retained: "),
        object_digest: null,
      },
    ]);
  });

  it("records nothing of a turn's end when its transcript's rows cannot be written", async () => {
    const { turn, taskId } = await startTurn("hello");
    // Retention was decided before the turn-end transaction opened; the rows that record it commit with the
    // turn's end or not at all, so a failed link undoes the object row written before it, and the finish too.
    failArtifactLinks("runtime_transcript", "1");
    const statusBefore = taskStatus(taskId);
    const failed = ts.waitForLog((line) =>
      line.includes("finishTurn record failure: Error: simulated link failure"),
    );
    turn.end();
    await failed;
    // Stored before the transaction, and referenced by no row once it rolled back.
    const digest = ObjectStore.digestOf(readFileSync(turn.streamLogPath));
    expect(objectStored(digest)).toBe(true);
    expect(rows("SELECT 1 FROM objects WHERE digest = ?", digest)).toHaveLength(0);
    expect(transcriptArtifacts(taskId)).toEqual([]);
    expect(rows("SELECT 1 FROM artifacts WHERE kind = 'runtime_transcript'")).toHaveLength(0);
    expect(taskStatus(taskId)).toBe(statusBefore);
    expect(eventCount("task_finished")).toBe(0);
  });

  it("still carries an interrupted turn's note into the next turn when the turn's end cannot be recorded", async () => {
    const { taskId } = await submitHeldCall("change");
    ts.server.catalog.db.exec(`CREATE TRIGGER fail_task_finish BEFORE UPDATE ON tasks
      WHEN NEW.finished_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'simulated finish failure'); END`);
    const failed = ts.waitForLog((line) => line.includes("finishTurn record failure"));
    expect((await client.interrupt(taskId)).disposition).toBe("accepted");
    await failed;
    ts.server.catalog.db.exec("DROP TRIGGER fail_task_finish");
    expect(taskStatus(taskId)).toBe("interrupting");
    // The task left memory all the same, so the next one starts, told what may have happened in this one.
    const { turn: next, taskId: nextId } = await submit("and now?");
    expect(next.options.text).toContain("[Mia note, not from the user]");
    expect(next.options.text).toContain("mcp__d1__change: invalidated");
    await finishTurn(next, nextId);
  });
});

describe("diagnostics", () => {
  it("records a report about no conversation, or another one, as its row alone, under the active task", async () => {
    const { taskId } = await submit("hello");
    const before = rows("SELECT id FROM events WHERE type = 'client_diagnostics'");
    for (const conversationId of [null, "conv_other"])
      expect(
        (
          await client.send("diagnostic_snapshot", {
            conversation_id: conversationId,
            diagnostics: client.diagnostics(),
          })
        ).disposition,
      ).toBe("accepted");
    expect(rows("SELECT id FROM events WHERE type = 'client_diagnostics'")).toEqual(before);
    expect(
      rows(
        "SELECT conversation_id, event_id, task_id, client_id FROM diagnostics WHERE task_id IS NOT NULL",
      ),
    ).toEqual(
      Array(2).fill({
        conversation_id: null,
        event_id: null,
        task_id: taskId,
        client_id: client.clientId,
      }),
    );
  });
});

describe("approval path", () => {
  it("holds a call until approval, releases exactly once, and never releases a rejected call", async () => {
    const { turn, taskId } = await startTurn("change once");
    turn.propose("toolu_1", "mcp__d1__change", { delta: 1 });
    const decision = turn.request("mcp__d1__change", { delta: 1 }, "toolu_1");
    const requested = await client.waitFor("approval_requested");
    expect(requested.payload.tool_identity).toBe("mcp__d1__change");
    expect(requested.payload.redacted_arguments).toEqual({ delta: 1 });
    expect(requested.payload.binding_revision).toBe(1);
    expect(turn.decisions).toHaveLength(0); // still held
    expect(approvalStatuses()).toEqual(["pending"]);
    // The approval and the event that requested it name each other.
    expect(rows("SELECT id, requesting_event_id FROM approvals")).toEqual([
      { id: requested.payload.approval_id, requesting_event_id: requested.message_id },
    ]);
    const ack = await decide(taskId, requested.payload.approval_id, "approve");
    expect(ack.disposition).toBe("accepted");
    expect(ackResult(ack).released).toBe(true);
    expect((await decision).behavior).toBe("allow");
    // decision persisted before release: approval_resolved precedes tool_dispatched in the event log
    const types = rows<{ type: string }>("SELECT type FROM events ORDER BY sequence").map(
      (row) => row.type,
    );
    expect(types.indexOf("approval_resolved")).toBeLessThan(types.indexOf("tool_dispatched"));
    // a second decision on the same approval cannot reuse it
    const reuse = await decide(taskId, requested.payload.approval_id, "approve");
    expect(reuse.disposition).toBe("rejected");
    expect(ackError(reuse).code).toBe("invalid_state");
    await turn.toolResult("toolu_1", JSON.stringify({ counter: 1 }));
    // second identical call needs a fresh approval, and rejection never dispatches
    turn.propose("toolu_2", "mcp__d1__change", { delta: 1 });
    const second = turn.request("mcp__d1__change", { delta: 1 }, "toolu_2");
    const requested2 = await client.waitFor(
      "approval_requested",
      (event) => event.payload.runtime_call_id === "toolu_2",
    );
    expect(requested2.payload.approval_id).not.toBe(requested.payload.approval_id);
    await decide(taskId, requested2.payload.approval_id, "reject");
    const d2 = await second;
    expect(d2.behavior).toBe("deny");
    await turn.toolResult("toolu_2", "denied", true);
    expect((await finishTurn(turn)).payload.status).toBe("completed");
    // The refused call's error result stays linked to it, as its result, not as an unmatched one.
    const calls = rows<{ runtime_call_id: string; status: ToolCallStatus; has_result: number }>(
      "SELECT runtime_call_id, status, result_event_id IS NOT NULL AS has_result FROM tool_calls ORDER BY created_at",
    );
    expect(calls).toEqual([
      { runtime_call_id: "toolu_1", status: "completed", has_result: 1 },
      { runtime_call_id: "toolu_2", status: "denied", has_result: 1 },
    ]);
    expect(eventCount("tool_result_unmatched")).toBe(0);
  });

  it("tells the client each call's progress in the status that call committed in", async () => {
    // Record, as each tool_call notification is sent, the status the catalog then holds for its call.
    const { engine, gateway } = ts.server;
    const notified: {
      call: string;
      status: ToolCallStatus;
      detail?: string;
      committed: unknown;
    }[] = [];
    let lastPayload: unknown = null;
    engine.attachDelivery((connectionId, event) => {
      if (event.type === "tool_call") {
        const { runtime_call_id: call, status, detail, tool_call_id: id } = event.payload;
        const committed = rows("SELECT status FROM tool_calls WHERE id = ?", id)[0]?.status;
        notified.push({ call, status, ...(detail ? { detail } : {}), committed });
        lastPayload = event.payload;
      }
      gateway.send(connectionId, event);
    });
    const { turn, taskId } = await startTurn("progress");
    turn.propose("toolu_read", "mcp__d1__read", {});
    expect((await turn.request("mcp__d1__read", {}, "toolu_read")).behavior).toBe("allow");
    await turn.toolResult("toolu_read", "read");
    expect((await turn.request("mcp__d1__forbidden", {}, "toolu_forbidden")).behavior).toBe("deny");
    const approved = turn.request("mcp__d1__change", { delta: 1 }, "toolu_approved");
    const requested = await client.waitFor("approval_requested");
    await decide(taskId, requested.payload.approval_id, "approve");
    expect((await approved).behavior).toBe("allow");
    const rejected = turn.request("mcp__d1__change", { delta: 3 }, "toolu_rejected");
    const rejection = await client.waitFor(
      "approval_requested",
      (event) => event.payload.runtime_call_id === "toolu_rejected",
    );
    await decide(taskId, rejection.payload.approval_id, "reject");
    expect((await rejected).behavior).toBe("deny");
    const interrupted = turn.request("mcp__d1__change", { delta: 2 }, "toolu_interrupted");
    const asked = await client.waitFor(
      "approval_requested",
      (event) => event.payload.runtime_call_id === "toolu_interrupted",
    );
    expect((await client.interrupt(taskId)).disposition).toBe("accepted");
    expect((await interrupted).behavior).toBe("deny");
    await client.waitFor("task_finished");
    const progress = (call: string, status: ToolCallStatus, detail?: string) => ({
      call,
      status,
      ...(detail ? { detail } : {}),
      committed: status,
    });
    expect(notified).toEqual([
      progress("toolu_read", "proposed"),
      progress("toolu_read", "dispatched"),
      progress("toolu_read", "completed"),
      progress("toolu_forbidden", "denied"),
      progress("toolu_approved", "awaiting_approval"),
      progress("toolu_approved", "dispatched"),
      progress("toolu_rejected", "awaiting_approval"),
      progress("toolu_rejected", "denied", "rejected"),
      progress("toolu_interrupted", "awaiting_approval"),
      progress("toolu_interrupted", "invalidated", "interrupted"),
    ]);
    // The whole payload, built with the transition, names the call and its task as the approval request did.
    expect(lastPayload).toEqual({
      conversation_id: asked.payload.conversation_id,
      task_id: taskId,
      tool_call_id: asked.payload.tool_call_id,
      runtime_call_id: "toolu_interrupted",
      tool_identity: "mcp__d1__change",
      status: "invalidated",
      detail: "interrupted",
      redacted_arguments: { delta: 2 },
    });
  });

  it("invalidates an approval when arguments change under the same runtime call id", async () => {
    const { turn, taskId } = await startTurn("change");
    turn.propose("toolu_1", "mcp__d1__change", { delta: 1 });
    const first = turn.request("mcp__d1__change", { delta: 1 }, "toolu_1");
    const requested1 = await client.waitFor("approval_requested");
    const second = turn.request("mcp__d1__change", { delta: 2 }, "toolu_1");
    const invalidated = await client.waitFor(
      "approval_resolved",
      (event) => event.payload.approval_id === requested1.payload.approval_id,
    );
    expect(invalidated.payload.status).toBe("invalidated");
    expect((await first).behavior).toBe("deny");
    const requested2 = await client.waitFor(
      "approval_requested",
      (event) => event.payload.binding_revision === 2,
    );
    expect(requested2.payload.redacted_arguments).toEqual({ delta: 2 });
    // Superseding resumed the task, and the new revision's ask, later in the same transaction, set it back,
    // in the records and in memory alike.
    expect(taskStatus(taskId)).toBe("awaiting_approval");
    expect(ackError(await client.submitText("meanwhile")).message).toContain(
      `is awaiting_approval; approve or reject ${requested2.payload.approval_id}`,
    );
    // the old approval id cannot authorise the new binding
    const stale = await decide(taskId, requested1.payload.approval_id, "approve");
    expect(ackError(stale).code).toBe("invalid_state");
    await decide(taskId, requested2.payload.approval_id, "approve");
    expect((await second).behavior).toBe("allow");
    await finishTurn(turn);
    expect(callStatuses()).toEqual(["invalidated", "unknown"]);
  });

  it("invalidates an approval when the stream proposes a different tool with the same arguments under its call id", async () => {
    const { turn, taskId, held, requested } = await submitHeldCall("change");
    // The stream event commits synchronously, so the records show the new revision before any delivery.
    turn.propose("toolu_1", "mcp__d1__read", { delta: 1 });
    expect(
      rows<{ binding_revision: number; tool_identity: string; status: ToolCallStatus }>(
        "SELECT binding_revision, tool_identity, status FROM tool_calls WHERE runtime_call_id = 'toolu_1' ORDER BY binding_revision",
      ),
    ).toEqual([
      { binding_revision: 1, tool_identity: "mcp__d1__change", status: "invalidated" },
      { binding_revision: 2, tool_identity: "mcp__d1__read", status: "proposed" },
    ]);
    expect(approvalStatuses()).toEqual(["invalidated"]);
    const invalidated = await client.waitFor(
      "approval_resolved",
      (event) => event.payload.approval_id === requested.payload.approval_id,
    );
    expect(invalidated.payload).toMatchObject({ status: "invalidated", reason: "tool changed" });
    expect((await held).behavior).toBe("deny");
    const stale = await decide(taskId, requested.payload.approval_id, "approve");
    expect(ackError(stale).code).toBe("invalid_state");
    await expectResumed(taskId);
    await finishTurn(turn);
  });

  it("attaches a late stream line to the earlier revision it announces and keeps the later approval pending", async () => {
    const { turn, taskId, held: first } = await submitHeldCall("change");
    const second = turn.request("mcp__d1__change", { delta: 2 }, "toolu_1");
    const requested2 = await client.waitFor(
      "approval_requested",
      (event) => event.payload.binding_revision === 2,
    );
    expect((await first).behavior).toBe("deny");
    // The stream line for the first request's arguments arrives only now.
    turn.propose("toolu_1", "mcp__d1__change", { delta: 1 });
    const streamLine = must(
      rows<{ id: string }>(
        "SELECT id FROM events WHERE type = 'tool_proposed' ORDER BY sequence DESC LIMIT 1",
      )[0],
      "stream line event",
    ).id;
    expect(
      rows<{ binding_revision: number; status: ToolCallStatus; streamed: number }>(
        "SELECT binding_revision, status, proposal_event_id = ? AS streamed FROM tool_calls WHERE runtime_call_id = 'toolu_1' ORDER BY binding_revision",
        streamLine,
      ),
    ).toEqual([
      { binding_revision: 1, status: "invalidated", streamed: 1 },
      { binding_revision: 2, status: "awaiting_approval", streamed: 0 },
    ]);
    expect(approvalStatuses()).toEqual(["invalidated", "pending"]);
    expect(taskStatus(taskId)).toBe("awaiting_approval");
    const ack = await decide(taskId, requested2.payload.approval_id, "approve");
    expect(ackResult(ack).released).toBe(true);
    expect((await second).behavior).toBe("allow");
    await finishTurn(turn);
  });

  it("completes the released call, not a later stream binding under its call id, when the result arrives", async () => {
    const { turn } = await startTurn("read");
    expect((await turn.request("mcp__d1__read", { q: 1 }, "toolu_1")).behavior).toBe("allow");
    turn.propose("toolu_1", "mcp__d1__change", { q: 1 });
    await turn.toolResult("toolu_1", "read");
    await finishTurn(turn);
    expect(
      rows<{ tool_identity: string; status: ToolCallStatus; has_result: number }>(
        "SELECT tool_identity, status, result_event_id IS NOT NULL AS has_result FROM tool_calls WHERE runtime_call_id = 'toolu_1' ORDER BY binding_revision",
      ),
    ).toEqual([
      { tool_identity: "mcp__d1__read", status: "completed", has_result: 1 },
      { tool_identity: "mcp__d1__change", status: "invalidated", has_result: 0 },
    ]);
  });

  it("never settles a call Mia never released: a result for a streamed-only call is unmatched", async () => {
    const { turn } = await startTurn("change");
    turn.propose("toolu_1", "mcp__d1__change", { delta: 1 });
    await turn.toolResult("toolu_1", "ran anyway");
    await finishTurn(turn);
    expect(
      rows<{ status: ToolCallStatus; has_result: number }>(
        "SELECT status, result_event_id IS NOT NULL AS has_result FROM tool_calls",
      ),
    ).toEqual([{ status: "invalidated", has_result: 0 }]);
    expect(eventCount("tool_result_unmatched")).toBe(1);
  });

  it("refuses a repeated request for a call already awaiting approval and keeps one approval", async () => {
    const { turn, taskId, held, requested } = await submitHeldCall("change");
    // The approvals table's unique key would also refuse a second approval, but only as a record failure
    // that leaves no trace in the journal; the refusal is a decision, recorded as such.
    const duplicate = await turn.request("mcp__d1__change", { delta: 1 }, "toolu_1");
    expect(duplicate).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("already awaiting the user's approval"),
    });
    expect(
      rows<{ payload: string }>("SELECT payload FROM events WHERE type = 'error'").map(
        (row) => JSON.parse(row.payload).message,
      ),
    ).toEqual([expect.stringContaining("(toolu_1) repeats a request already awaiting approval")]);
    expect(approvalStatuses()).toEqual(["pending"]);
    // The refused request dropping its own prompt afterwards abandons nothing: the first one stays held.
    must(turn.pendingAbandons[1], "refused prompt").abort();
    expect(approvalStatuses()).toEqual(["pending"]);
    const ack = await decide(taskId, requested.payload.approval_id, "approve");
    expect(ackResult(ack).released).toBe(true);
    expect((await held).behavior).toBe("allow");
    expect(turn.decisions.map(({ decision }) => decision.behavior)).toEqual(["deny", "allow"]);
    expect(approvalStatuses()).toEqual(["approved"]);
    expect(callStatuses()).toEqual(["dispatched"]);
    await finishTurn(turn);
  });

  it("rejects decisions with wrong task, wrong client, or foreign ids", async () => {
    const { turn, taskId, held, requested } = await submitHeldCall("change");
    expect(
      ackError(await decide("task_wrong", requested.payload.approval_id, "approve")).code,
    ).toBe("not_found");
    expect(ackError(await decide(taskId, "appr_foreign", "approve")).code).toBe("not_found");
    const other = await ts.connect("client-B");
    const foreign = await other.send("approval_decision", {
      conversation_id: must(client.conversationId, "conversation id"),
      task_id: taskId,
      approval_id: requested.payload.approval_id,
      decision: "approve",
    });
    expect(ackError(foreign).code).toBe("busy");
    expect(turn.decisions).toHaveLength(0);
    await decide(taskId, requested.payload.approval_id, "reject");
    expect((await held).behavior).toBe("deny");
    await finishTurn(turn);
  });

  it("denies policy-denied and unlisted tools, inherited names among them, and requests without a runtime call id", async () => {
    const { turn } = await startTurn("bad tools");
    // A name every object inherits is unlisted, not an inherited policy, whether streamed or requested.
    turn.propose("toolu_s", "__proto__", {});
    expect((await turn.request("mcp__d1__forbidden", {}, "toolu_f")).behavior).toBe("deny");
    expect(await turn.request("constructor", {}, "toolu_i")).toEqual({
      behavior: "deny",
      message: "Mia denied constructor: it is not part of the configured policy.",
    });
    expect((await turn.request("mcp__d1__change", { delta: 1 }, undefined)).behavior).toBe("deny");
    expect(rows("SELECT id FROM approvals")).toHaveLength(0);
    // Each wait is the assertion: the client is told of both refusals.
    await client.waitFor("error", (event) => event.payload.code === "configuration_error");
    await client.waitFor("error", (event) => event.payload.code === "runtime_failure");
    await finishTurn(turn);
    expect(
      rows(
        "SELECT runtime_call_id, tool_identity, policy, status, detail FROM tool_calls WHERE runtime_call_id IN ('toolu_s', 'toolu_f', 'toolu_i') ORDER BY runtime_call_id",
      ),
    ).toMatchObject([
      {
        runtime_call_id: "toolu_f",
        tool_identity: "mcp__d1__forbidden",
        policy: "deny",
        status: "denied",
        detail: "denied by policy",
      },
      {
        runtime_call_id: "toolu_i",
        tool_identity: "constructor",
        policy: "unlisted",
        status: "denied",
        detail: "tool not listed in toolPolicy",
      },
      {
        runtime_call_id: "toolu_s",
        tool_identity: "__proto__",
        policy: "unlisted",
      },
    ]);
    expect(
      rows(
        "SELECT id FROM events WHERE type = 'tool_proposed' AND json_extract(payload, '$.runtime_call_id') = 'toolu_s'",
      ),
    ).toHaveLength(1);
  });

  it("keeps the call held when the decision cannot be persisted", async () => {
    const { turn, taskId, held, requested } = await submitHeldCall("change");
    failNextCommit();
    const ack = await decide(taskId, requested.payload.approval_id, "approve");
    expect(ack.disposition).toBe("rejected");
    expect(ackError(ack).code).toBe("record_failure");
    expect(turn.decisions).toHaveLength(0);
    expect(approvalStatuses()).toEqual(["pending"]);
    const retry = await decide(taskId, requested.payload.approval_id, "approve");
    expect(retry.disposition).toBe("accepted");
    expect((await held).behavior).toBe("allow");
    await finishTurn(turn);
  });

  it("releases a committed decision even when delivering it to the client fails", async () => {
    const { turn, taskId, held, requested } = await submitHeldCall("change");
    failDelivery("approval_resolved");
    const dispatched = client.waitFor(
      "tool_call",
      (event) => event.payload.status === "dispatched",
    );
    expect(await decide(taskId, requested.payload.approval_id, "approve")).toMatchObject({
      disposition: "accepted",
      result: { released: true },
    });
    expect((await held).behavior).toBe("allow");
    await dispatched;
    expect(approvalStatuses()).toEqual(["approved"]);
    await finishTurn(turn);
  });

  it("denies each request that cannot be recorded, leaving no call behind and no prompt held", async () => {
    const { turn, taskId } = await startTurn("change");
    failNextCommit();
    expect((await turn.request("mcp__d1__read", {}, "toolu_read")).behavior).toBe("deny");
    failNextCommit();
    // A refusal answers with its own denial even when it cannot be recorded.
    expect(await turn.request("mcp__d1__change", { delta: 1 }, undefined)).toEqual({
      behavior: "deny",
      message: "Mia cannot bind this call to a runtime call id; rejected.",
    });
    expect(rows("SELECT id FROM tool_calls")).toHaveLength(0);
    failNextCommit();
    const refused = await turn.request("mcp__d1__change", { delta: 1 }, "toolu_1");
    expect(refused).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("could not record"),
    });
    expect(rows("SELECT id FROM approvals")).toHaveLength(0);
    must(turn.pendingAbandons[0], "refused prompt").abort();
    const retry = turn.request("mcp__d1__change", { delta: 1 }, "toolu_1");
    const requested = await client.waitFor("approval_requested");
    await decide(taskId, requested.payload.approval_id, "approve");
    expect((await retry).behavior).toBe("allow");
    expect(approvalStatuses()).toEqual(["approved"]);
    await finishTurn(turn);
  });

  it("holds a prompt whose approval request committed even when delivering it to the client fails", async () => {
    const { turn, taskId } = await startTurn("change");
    failDelivery("approval_requested");
    const awaiting = client.waitFor(
      "tool_call",
      (event) => event.payload.status === "awaiting_approval",
    );
    const held = turn.request("mcp__d1__change", { delta: 1 }, "toolu_1");
    await awaiting;
    const approvalId = must(rows<{ id: string }>("SELECT id FROM approvals")[0], "approval").id;
    expect(await decide(taskId, approvalId, "approve")).toMatchObject({
      disposition: "accepted",
      result: { released: true },
    });
    expect((await held).behavior).toBe("allow");
    await finishTurn(turn);
  });

  it("keeps the earlier approval pending when a changed binding cannot be recorded", async () => {
    const { turn, taskId, held, requested } = await submitHeldCall("change");
    failNextCommit();
    expect((await turn.request("mcp__d1__change", { delta: 2 }, "toolu_1")).behavior).toBe("deny");
    expect(approvalStatuses()).toEqual(["pending"]);
    expect(taskStatus(taskId)).toBe("awaiting_approval");
    const ack = await decide(taskId, requested.payload.approval_id, "approve");
    expect(ack.disposition).toBe("accepted");
    expect((await held).behavior).toBe("allow");
    await finishTurn(turn);
  });

  it("expires an approval whose prompt the runtime abandoned, resumes the task, and tells the next turn", async () => {
    const { turn, taskId, held } = await submitHeldCall("change");
    must(turn.pendingAbandons[0], "held prompt").abort();
    expect((await held).behavior).toBe("deny");
    expect(approvalStatuses()).toEqual(["expired"]);
    await expectResumed(taskId);
    await expectAbandonedAtTurnEnd(turn);
  });

  describe("when an abandonment cannot be recorded", () => {
    /** Hold a call, then have the runtime abandon its prompt while the expiry fails to commit. */
    const abandonUnrecorded = async () => {
      const held = await submitHeldCall("change");
      failNextCommit();
      must(held.turn.pendingAbandons[0], "held prompt").abort();
      expect((await held.held).behavior).toBe("deny");
      expect(approvalStatuses()).toEqual(["pending"]);
      return held;
    };

    it("refuses a later decision, resumes the task, and ends the call invalidated", async () => {
      const { turn, taskId, requested } = await abandonUnrecorded();
      const late = await decide(taskId, requested.payload.approval_id, "approve");
      expect(ackError(late)).toMatchObject({
        code: "invalid_state",
        message: expect.stringContaining("can no longer be decided; its call was not released"),
      });
      expect(turn.decisions.map(({ decision }) => decision.behavior)).toEqual(["deny"]);
      expect(eventCount("tool_dispatched")).toBe(0);
      const busy = await client.submitText("another");
      expect(ackError(busy).message).toContain("is running; wait for it to finish or interrupt it");
      await expectAbandonedAtTurnEnd(turn);
    });

    it("lets the runtime ask again for the same call, as a new revision", async () => {
      const { turn, taskId, requested } = await abandonUnrecorded();
      const retry = turn.request("mcp__d1__change", { delta: 1 }, "toolu_1");
      const again = await client.waitFor(
        "approval_requested",
        (event) => event.payload.approval_id !== requested.payload.approval_id,
      );
      expect(again.payload.binding_revision).toBe(2);
      await decide(taskId, again.payload.approval_id, "approve");
      expect((await retry).behavior).toBe("allow");
      await turn.toolResult("toolu_1", "changed");
      expect((await finishTurn(turn)).payload.status).toBe("completed");
      expect(callStatuses()).toEqual(["invalidated", "completed"]);
      expect(approvalStatuses().sort()).toEqual(["approved", "expired"]);
    });

    it("ends the call invalidated, not gate-blocked, when the task is then interrupted", async () => {
      const { taskId } = await abandonUnrecorded();
      expect((await client.interrupt(taskId)).disposition).toBe("accepted");
      expect((await client.waitFor("task_finished")).payload.status).toBe("interrupted");
      expect(callStatuses()).toEqual(["invalidated"]);
      expect(approvalStatuses()).toEqual(["expired"]);
    });
  });

  it("expires at once an approval whose prompt the runtime abandoned before Mia got it", async () => {
    const { turn, taskId } = await startTurn("change");
    const decision = await turn.requestAbandoned("mcp__d1__change", { delta: 1 }, "toolu_1");
    expect(decision).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("was abandoned before the user decided"),
    });
    const requested = await client.waitFor("approval_requested");
    expect(approvalStatuses()).toEqual(["expired"]);
    const late = await decide(taskId, requested.payload.approval_id, "approve");
    expect(ackError(late).code).toBe("invalid_state");
    expect(eventCount("tool_dispatched")).toBe(0);
    await expectResumed(taskId);
    await expectAbandonedAtTurnEnd(turn);
  });

  it("expires an approval whose prompt the runtime drops while the client is told of it", async () => {
    // The prompt is held before approval_requested is delivered, so dropping it then abandons a held prompt from
    // inside the request's own dispatch: the expiry must follow that dispatch, not nest in it (the harness fails
    // any test whose server refused a nested dispatch).
    const { engine, gateway } = ts.server;
    const { turn, taskId } = await submit("change");
    engine.attachDelivery((connectionId, event) => {
      if (event.type === "approval_requested") must(turn.pendingAbandons[0], "prompt").abort();
      gateway.send(connectionId, event);
    });
    turn.init();
    const decision = await turn.request("mcp__d1__change", { delta: 1 }, "toolu_1");
    expect(decision).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("was abandoned before the user decided"),
    });
    const resolved = await client.waitFor("approval_resolved");
    const requested = must(
      client.events.find((event) => event.type === "approval_requested"),
      "approval_requested",
    );
    expect(client.events.indexOf(requested)).toBeLessThan(client.events.indexOf(resolved));
    expect(must(requested.sequence)).toBeLessThan(must(resolved.sequence));
    expect(resolved.payload).toMatchObject({
      approval_id: requested.payload.approval_id,
      status: "expired",
    });
    await expectResumed(taskId);
    expect(ackError(await decide(taskId, requested.payload.approval_id, "approve"))).toMatchObject({
      code: "invalid_state",
      message: expect.stringContaining("is expired, not pending"),
    });
    expect(eventCount("tool_dispatched")).toBe(0);
    await expectAbandonedAtTurnEnd(turn);
  });

  it("keeps an approval abandoned before Mia got it undecidable when its expiry cannot be recorded", async () => {
    const { turn, taskId } = await startTurn("change");
    // The request commits; the expiry that follows it does not.
    ts.server.catalog.db.exec(`CREATE TRIGGER fail_expiry BEFORE UPDATE ON approvals
      WHEN NEW.status = 'expired' BEGIN SELECT RAISE(ABORT, 'simulated expiry failure'); END`);
    const decision = await turn.requestAbandoned("mcp__d1__change", { delta: 1 }, "toolu_1");
    expect(decision.behavior).toBe("deny");
    const requested = await client.waitFor("approval_requested");
    expect(approvalStatuses()).toEqual(["pending"]);
    expect(ts.logs).toContainEqual(expect.stringContaining("could not record abandoned approval"));
    ts.server.catalog.db.exec("DROP TRIGGER fail_expiry");
    expect(ackError(await decide(taskId, requested.payload.approval_id, "approve"))).toMatchObject({
      code: "invalid_state",
      message: expect.stringContaining("can no longer be decided; its call was not released"),
    });
    expect(eventCount("tool_dispatched")).toBe(0);
    await expectAbandonedAtTurnEnd(turn);
  });

  describe("with as many prompts held as the server holds at once", () => {
    /** Hold MAX_HELD_PROMPTS calls in one turn, each awaiting its own approval. */
    const holdAll = async () => {
      const { turn, taskId } = await startTurn("change everything");
      const held = Array.from({ length: MAX_HELD_PROMPTS }, (_, index) =>
        turn.request("mcp__d1__change", { delta: index }, `toolu_${index}`),
      );
      await client.waitFor(
        "approval_requested",
        (event) => event.payload.runtime_call_id === `toolu_${MAX_HELD_PROMPTS - 1}`,
      );
      expect(approvalStatuses()).toHaveLength(MAX_HELD_PROMPTS);
      return { turn, taskId, held };
    };

    it("denies one more call without asking, still dispatches an allowed one, and asks again once one is decided", async () => {
      const { turn, taskId, held } = await holdAll();
      const extra = await turn.request("mcp__d1__change", { delta: -1 }, "toolu_extra");
      expect(extra).toMatchObject({
        behavior: "deny",
        message: expect.stringContaining("too many approval prompts are already waiting"),
      });
      expect(approvalStatuses()).toHaveLength(MAX_HELD_PROMPTS);
      expect(
        rows("SELECT status, detail FROM tool_calls WHERE runtime_call_id = 'toolu_extra'"),
      ).toEqual([
        { status: "denied", detail: "not asked: too many approval prompts already waiting" },
      ]);
      expect((await turn.request("mcp__d1__read", {}, "toolu_read")).behavior).toBe("allow");
      const first = await client.waitFor(
        "approval_requested",
        (event) => event.payload.runtime_call_id === "toolu_0",
      );
      await decide(taskId, first.payload.approval_id, "reject");
      expect((await must(held[0], "first held prompt")).behavior).toBe("deny");
      const again = turn.request("mcp__d1__change", { delta: -1 }, "toolu_again");
      const asked = await client.waitFor(
        "approval_requested",
        (event) => event.payload.runtime_call_id === "toolu_again",
      );
      await decide(taskId, asked.payload.approval_id, "approve");
      expect((await again).behavior).toBe("allow");
      await finishTurn(turn);
    });

    it("answers the prompts still held even when the turn's end cannot be recorded", async () => {
      const { turn, held } = await holdAll();
      ts.server.catalog.db.exec(`CREATE TRIGGER fail_task_finish BEFORE UPDATE ON tasks
        WHEN NEW.finished_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'simulated finish failure'); END`);
      const failed = ts.waitForLog((line) => line.includes("finishTurn record failure"));
      turn.end();
      await failed;
      const answers = await Promise.all(held);
      expect(answers.every((answer) => answer.behavior === "deny")).toBe(true);
      expect(new Set(approvalStatuses())).toEqual(new Set(["pending"]));
    });

    it("answers every prompt still held when the turn ends, so the next turn can ask", async () => {
      const { turn, held } = await holdAll();
      await finishTurn(turn);
      const answers = await Promise.all(held);
      expect(answers.every((answer) => answer.behavior === "deny")).toBe(true);
      expect(answers[0]).toMatchObject({ message: expect.stringContaining("the turn ended") });
      expect(new Set(approvalStatuses())).toEqual(new Set(["expired"]));
      const { turn: next, taskId } = await submit("try again");
      next.init();
      const retry = next.request("mcp__d1__change", { delta: 1 }, "toolu_next");
      const asked = await client.waitFor(
        "approval_requested",
        (event) => event.payload.task_id === taskId,
      );
      await decide(taskId, asked.payload.approval_id, "approve");
      expect((await retry).behavior).toBe("allow");
      await finishTurn(next, taskId);
    });
  });

  it("resumes the task when a request the policy allows supersedes its last pending approval", async () => {
    const { turn, taskId, held } = await submitHeldCall("change");
    expect((await turn.request("mcp__d1__read", { delta: 1 }, "toolu_1")).behavior).toBe("allow");
    expect((await held).behavior).toBe("deny");
    await expectResumed(taskId);
    await turn.toolResult("toolu_1", "read");
    expect((await finishTurn(turn)).payload.status).toBe("completed");
  });

  it("treats disconnection as no decision and keeps the pending record", async () => {
    const { turn, taskId, held, requested } = await submitHeldCall("change");
    const closed = ts.waitForLog((line) => line.endsWith(" closed"));
    client.close();
    await closed;
    expect(turn.decisions).toHaveLength(0);
    expect(approvalStatuses()).toEqual(["pending"]);
    expect(eventCount("client_disconnected")).toBe(1);
    // the same client reconnecting can still decide
    const again = await ts.connect("client-A");
    again.conversationId = client.conversationId;
    const ack = await again.decide({
      taskId: taskId,
      approvalId: requested.payload.approval_id,
      decision: "reject",
    });
    expect(ack.disposition).toBe("accepted");
    expect((await held).behavior).toBe("deny");
    turn.end();
    await again.waitFor("task_finished");
  });

  it("lists and resolves pending approvals in the order they were requested, not the order their calls were seen", async () => {
    const { turn, taskId } = await startTurn("two changes");
    turn.propose("toolu_a", "mcp__d1__change", { delta: 1 });
    turn.propose("toolu_b", "mcp__d1__change", { delta: 2 });
    await client.waitFor("tool_call", (event) => event.payload.runtime_call_id === "toolu_b");
    const heldB = turn.request("mcp__d1__change", { delta: 2 }, "toolu_b");
    const askedB = await client.waitFor(
      "approval_requested",
      (event) => event.payload.runtime_call_id === "toolu_b",
    );
    const heldA = turn.request("mcp__d1__change", { delta: 1 }, "toolu_a");
    const askedA = await client.waitFor(
      "approval_requested",
      (event) => event.payload.runtime_call_id === "toolu_a",
    );
    const requestOrder = [askedB.payload.approval_id, askedA.payload.approval_id];
    const closed = ts.waitForLog((line) => line.endsWith(" closed"));
    client.close();
    await closed;
    const disconnected = rows<{ payload: string }>(
      "SELECT payload FROM events WHERE type = 'client_disconnected'",
    ).map((row) => JSON.parse(row.payload).pending_approvals);
    expect(disconnected).toEqual([requestOrder]);
    const again = await ts.connect("client-A");
    again.conversationId = client.conversationId;
    expect((await again.interrupt(taskId)).disposition).toBe("accepted");
    expect((await heldA).behavior).toBe("deny");
    expect((await heldB).behavior).toBe("deny");
    expect(
      rows<{ payload: string }>(
        "SELECT payload FROM events WHERE type = 'approval_resolved' ORDER BY sequence",
      ).map((row) => JSON.parse(row.payload).approval_id),
    ).toEqual(requestOrder);
    await again.waitFor("task_finished");
  });
});

describe("record times", () => {
  const start = "2031-01-01T00:00:00.000Z";
  /** Every reading is one second after the last, so rows that share a time came from one reading. */
  const useSteppingClock = (): void => {
    let reading = Date.parse(start);
    ts.setClock(() => new Date((reading += 1000)));
  };

  it("stamps each commit's rows, and each event sent, with a reading of the injected clock", async () => {
    useSteppingClock();
    const conversationId = await client.startConversation();
    const started = await client.waitFor(
      "conversation_started",
      (event) => event.payload.conversation_id === conversationId,
    );
    const startAck = await client.waitFor("ack", (event) => event.server_time > start);
    const { turn, taskId, held, requested } = await submitHeldCall("change once");
    await decide(taskId, requested.payload.approval_id, "approve");
    expect((await held).behavior).toBe("allow");
    await turn.toolResult("toolu_1", JSON.stringify({ counter: 1 }));
    const finished = await finishTurn(turn);
    const one = <T>(sql: string): T => must(rows<T>(sql, taskId)[0], sql);
    const eventAt = (type: string): string =>
      must(
        rows<{ received_at: string }>(
          "SELECT received_at FROM events WHERE task_id = ? AND type = ?",
          taskId,
          type,
        )[0],
        `${type} event`,
      ).received_at;
    const conversation = must(
      rows<{ started_at: string; directory: string }>(
        "SELECT started_at, directory FROM conversations WHERE id = ?",
        conversationId,
      )[0],
      "conversation row",
    );
    const task = one<{ created_at: string; finished_at: string }>(
      "SELECT created_at, finished_at FROM tasks WHERE id = ?",
    );
    const execution = one<{ started_at: string; ended_at: string }>(
      "SELECT started_at, ended_at FROM executions WHERE task_id = ?",
    );
    const call = one<{ created_at: string; updated_at: string }>(
      "SELECT created_at, updated_at FROM tool_calls WHERE task_id = ?",
    );
    const approval = one<{ requested_at: string; consumed_at: string }>(
      "SELECT a.requested_at, a.consumed_at FROM approvals a JOIN tool_calls t ON t.id = a.tool_call_id WHERE t.task_id = ?",
    );
    // The start, the submission, the approval request, the decision and the turn's end each commit together.
    const startedEvent = must(
      rows<{ received_at: string }>(
        "SELECT received_at FROM events WHERE conversation_id = ? AND type = 'conversation_started'",
        conversationId,
      )[0],
      "conversation_started event",
    );
    expect([startedEvent.received_at, started.payload.started_at]).toEqual([
      conversation.started_at,
      conversation.started_at,
    ]);
    expect(conversation.directory).toContain(conversation.started_at.replace(/[:.]/g, "-"));
    expect([execution.started_at, eventAt("task_submitted")]).toEqual([
      task.created_at,
      task.created_at,
    ]);
    expect([call.created_at, eventAt("approval_requested")]).toEqual([
      approval.requested_at,
      approval.requested_at,
    ]);
    expect([eventAt("approval_resolved"), eventAt("tool_dispatched")]).toEqual([
      approval.consumed_at,
      approval.consumed_at,
    ]);
    expect([execution.ended_at, call.updated_at, eventAt("task_finished")]).toEqual([
      task.finished_at,
      task.finished_at,
      task.finished_at,
    ]);
    // Each commit read the injected clock afresh, and so did each event and ack as it was sent.
    const times = [
      conversation.started_at,
      started.server_time,
      startAck.server_time,
      task.created_at,
      approval.requested_at,
      approval.consumed_at,
      task.finished_at,
      finished.server_time,
    ];
    expect(conversation.started_at > start).toBe(true);
    expect(times.toSorted()).toEqual(times);
    expect(new Set(times).size).toBe(times.length);
  });

  it("stamps provenance, tool-output and evidence artifacts with the reading of the commit that records them", async () => {
    useSteppingClock();
    const conversationId = await client.startConversation();
    const conversation = must(
      rows<{ started_at: string; provenance_set_id: string }>(
        "SELECT started_at, provenance_set_id FROM conversations WHERE id = ?",
        conversationId,
      )[0],
      "conversation row",
    );
    const { file, turn, taskId } = await approvedArtifactCall();
    await declareOutput(turn, file);
    await finishTurn(turn);
    const createdAt = (sql: string, id: string): string[] =>
      rows<{ created_at: string }>(sql, id).map((row) => row.created_at);
    // The start's commit: the provenance set and every snapshot it retained.
    const snapshots = createdAt(
      "SELECT a.created_at FROM artifacts a JOIN provenance_entries e ON e.artifact_id = a.id WHERE e.provenance_set_id = ?",
      conversation.provenance_set_id,
    );
    expect(snapshots.length).toBeGreaterThan(0);
    expect([
      ...createdAt(
        "SELECT created_at FROM provenance_sets WHERE id = ?",
        conversation.provenance_set_id,
      ),
      ...snapshots,
    ]).toEqual(Array(snapshots.length + 1).fill(conversation.started_at));
    // The tool result's commit: the output artifact and its artifact_registered event.
    const registered = must(
      rows<{ received_at: string }>(
        "SELECT received_at FROM events WHERE task_id = ? AND type = 'artifact_registered'",
        taskId,
      )[0],
      "artifact_registered event",
    ).received_at;
    expect(
      createdAt(
        "SELECT a.created_at FROM artifacts a JOIN artifact_links l ON l.artifact_id = a.id WHERE l.task_id = ? AND l.relation = 'task_output'",
        taskId,
      ),
    ).toEqual([registered]);
    // The turn end's commit: the evidence retained with the finished task.
    const finishedAt = must(
      rows<{ finished_at: string }>("SELECT finished_at FROM tasks WHERE id = ?", taskId)[0],
      "task row",
    ).finished_at;
    const evidence = createdAt(
      "SELECT a.created_at FROM artifacts a JOIN artifact_links l ON l.artifact_id = a.id WHERE l.task_id = ? AND a.kind <> 'tool_output'",
      taskId,
    );
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence).toEqual(Array(evidence.length).fill(finishedAt));
    expect([conversation.started_at, registered, finishedAt].toSorted()).toEqual([
      conversation.started_at,
      registered,
      finishedAt,
    ]);
    expect(new Set([conversation.started_at, registered, finishedAt]).size).toBe(3);
  });

  it("stamps a diagnostics report with the reading of its commit, and a heartbeat with a reading of its own", async () => {
    useSteppingClock();
    expect((await client.sendDiagnostics()).disposition).toBe("accepted");
    expect((await client.heartbeat()).disposition).toBe("accepted");
    // The session's own report came before the stepping clock, so only these two rows are stamped after `start`.
    const stamped = rows<{ received_at: string; event_id: string | null }>(
      "SELECT received_at, event_id FROM diagnostics WHERE received_at > ? ORDER BY received_at",
      start,
    );
    expect(stamped).toHaveLength(2);
    const [snapshot, heartbeat] = [
      must(stamped[0], "diagnostic_snapshot row"),
      must(stamped[1], "heartbeat row"),
    ];
    const event = must(
      rows<{ received_at: string }>(
        "SELECT received_at FROM events WHERE id = ? AND type = 'client_diagnostics'",
        mustString(snapshot.event_id, "diagnostics event_id"),
      )[0],
      "client_diagnostics event",
    );
    expect(event.received_at).toBe(snapshot.received_at);
    expect(heartbeat.event_id).toBeNull();
    expect(heartbeat.received_at > snapshot.received_at).toBe(true);
  });
});

describe("interruption path", () => {
  it("keeps the gate open and the approval pending when an interruption cannot be recorded", async () => {
    const { turn, taskId, held, requested } = await submitHeldCall("change");
    failNextCommit();
    const ack = await client.interrupt(taskId);
    expect(ackError(ack).code).toBe("record_failure");
    expect(turn.interrupted).toBe(false);
    expect(turn.decisions).toHaveLength(0);
    expect(approvalStatuses()).toEqual(["pending"]);
    await decide(taskId, requested.payload.approval_id, "approve");
    expect((await held).behavior).toBe("allow");
    expect((await finishTurn(turn)).payload.status).toBe("outcome_unknown");
  });

  it("interrupt before release: gate closes, approval is stale, nothing dispatches", async () => {
    const { taskId, held, requested } = await submitHeldCall("change");
    const ack = await client.interrupt(taskId);
    expect(ack.disposition).toBe("accepted");
    const decision = await held;
    expect(decision.behavior).toBe("deny");
    const late = await decide(taskId, requested.payload.approval_id, "approve");
    expect(ackError(late).code).toBe("invalid_state");
    const outcome = await client.waitFor("interruption_outcome");
    expect(outcome.payload.task_status).toBe("interrupted");
    expect(outcome.payload.actions[0]?.status).toBe("invalidated");
    expect(outcome.payload.runtime_cancellation).toBe("forced_kill");
    expect(eventCount("tool_dispatched")).toBe(0);
    const finished = await client.waitFor("task_finished");
    expect(finished.payload.status).toBe("interrupted");
  });

  it("records the killed runtime's exit after the interruption that killed it", async () => {
    const { taskId } = await startTurn("interrupted");
    expect((await client.interrupt(taskId)).disposition).toBe("accepted");
    await client.waitFor("task_finished");
    const types = rows<{ type: string }>(
      "SELECT type FROM events WHERE task_id = ? ORDER BY sequence",
      taskId,
    ).map(({ type }) => type);
    expect(types.indexOf("runtime_exit")).toBeGreaterThan(types.indexOf("interruption_requested"));
    expect(types.indexOf("interruption_requested")).toBeGreaterThan(-1);
  });

  it("kills the runtime at shutdown even when the interruption cannot be recorded", async () => {
    const { turn } = await submitHeldCall("change");
    failNextCommit();
    const closing = ts.server.close(new AbortController().signal);
    try {
      expect(turn.interrupted).toBe(true);
    } finally {
      turn.end(); // a no-op once the kill ended it; otherwise it lets the waiting shutdown finish
      await closing;
    }
    expect(ts.logs).toContainEqual(
      expect.stringContaining(
        "interruption not recorded: simulated commit failure; killing the runtime anyway",
      ),
    );
  });

  it("closes the gate once an interruption commits, even when delivering it fails", async () => {
    const { taskId, held } = await submitHeldCall("change");
    failDelivery("interruption_requested");
    const ack = await client.interrupt(taskId);
    expect(ack.disposition).toBe("accepted");
    expect((await held).behavior).toBe("deny");
    expect(approvalStatuses()).toEqual(["invalidated"]);
    expect((await client.waitFor("task_finished")).payload.status).toBe("interrupted");
  });

  it("release before interruption: the action is reported in flight with unknown outcome, and the next turn carries a note", async () => {
    const { taskId, held, requested } = await submitHeldCall("slow", "mcp__d1__slow", {
      mode: "uncancellable",
    });
    await decide(taskId, requested.payload.approval_id, "approve");
    expect((await held).behavior).toBe("allow");
    await client.interrupt(taskId);
    const outcome = await client.waitFor("interruption_outcome");
    expect(outcome.payload.task_status).toBe("outcome_unknown");
    expect(outcome.payload.actions).toEqual([
      expect.objectContaining({ tool_identity: "mcp__d1__slow", status: "unknown" }),
    ]);
    await client.waitFor("task_finished");
    const { turn: next, taskId: nextId } = await submit("what happened?");
    expect(next.options.text).toContain("[Mia note, not from the user]");
    expect(next.options.text).toContain("mcp__d1__slow: unknown");
    expect(next.options.text.endsWith("what happened?")).toBe(true);
    const recorded = rows<{ payload: string }>(
      "SELECT payload FROM events WHERE type = 'task_submitted' ORDER BY sequence",
    );
    expect(JSON.parse(must(recorded[1], "second task_submitted event").payload).text).toBe(
      "what happened?",
    );
    await finishTurn(next, nextId);
  });

  it("blocks a policy-allowed action proposed after the gate closed", async () => {
    await restartSession({
      toolPolicy: {
        mcp__d1__read: "allow",
        mcp__d1__change: "allow",
        mcp__d1__slow: "ask",
        mcp__d1__forbidden: "deny",
      },
    });
    const { turn, taskId } = await submit("slow then change");
    turn.survivesInterrupt = true;
    turn.init();
    const slow = turn.request("mcp__d1__slow", { mode: "cancellable" }, "toolu_1");
    const requested = await client.waitFor("approval_requested");
    await decide(taskId, requested.payload.approval_id, "approve");
    expect((await slow).behavior).toBe("allow");
    await client.interrupt(taskId);
    const change = await turn.request("mcp__d1__change", { delta: 1 }, "toolu_2");
    expect(change.behavior).toBe("deny");
    expect(rows("SELECT status FROM tool_calls WHERE runtime_call_id = 'toolu_2'")).toEqual([
      { status: "blocked_gate" },
    ]);
    turn.end("failed", "killed late");
    const outcome = await client.waitFor("interruption_outcome");
    expect(outcome.payload.runtime_cancellation).toBe("unknown");
    expect(
      outcome.payload.actions.find((action) => action.tool_identity === "mcp__d1__change")?.status,
    ).toBe("blocked_gate");
  });

  it("reports unknown when a released call's result cannot be recorded", async () => {
    const { turn } = await startTurn("read");
    expect((await turn.request("mcp__d1__read", {}, "toolu_1")).behavior).toBe("allow");
    failNextCommit();
    await turn.toolResult("toolu_1", "ok");
    expect((await finishTurn(turn)).payload.status).toBe("outcome_unknown");
    expect(callStatuses()).toEqual(["unknown"]);
  });

  it("reports unknown when a released call never returns a result", async () => {
    const { turn } = await startTurn("read");
    const read = await turn.request("mcp__d1__read", {}, "toolu_1");
    expect(read.behavior).toBe("allow");
    turn.end("failed", "runtime crashed");
    const finished = await client.waitFor("task_finished");
    expect(finished.payload.status).toBe("outcome_unknown");
    expect(finished.payload.error).toContain("runtime crashed");
    expect(callStatuses()).toEqual(["unknown"]);
    // The configured policy is unchanged by the unknown outcome: the model, not the harness, judges whether a repeat is
    // safe, and it is told what is unknown through the Mia note on its next turn.
    const { turn: next, taskId } = await submit("read again");
    expect(next.options.text).toContain("[Mia note, not from the user]");
    expect(next.options.text).toContain("mcp__d1__read: unknown");
    const again = await next.request("mcp__d1__read", {}, "toolu_2");
    expect(again.behavior).toBe("allow");
    await finishTurn(next, taskId);
  });
});

describe("runtime session", () => {
  /** Once `first` has finished, the next turn runs in the same session, resuming it or creating it. */
  const expectNextTurnSession = async (
    first: { turn: ScriptedTurn; taskId: string },
    resume: boolean,
  ) => {
    await client.waitFor("task_finished");
    const { turn: next, taskId: nextId } = await submit("second");
    expect(next.launch.resume).toBe(resume);
    expect(next.options.runtimeConversationId).toBe(first.turn.options.runtimeConversationId);
    await finishTurn(next, nextId);
  };

  it("starts no turn for a submission that cannot be recorded, and starts its retry as the first turn", async () => {
    failNextCommit();
    // A turn starts before its submission is answered, so none can start after this ack.
    expect(ackError(await client.submitText("unrecorded")).code).toBe("record_failure");
    expect(runtime.turns).toHaveLength(0);
    expect(rows("SELECT id FROM tasks")).toEqual([]);
    const next = runtime.nextTurn();
    const ack = await client.submitText("recorded");
    expect(ackResult(ack)).toMatchObject({ execution_epoch: 1 });
    const turn = await next;
    expect(runtime.turns).toHaveLength(1);
    expect(turn.options).toMatchObject({ text: "recorded", turnIndex: 1, firstTurn: true });
  });

  /** Make the adapter throw as it starts the next turn, as if the runtime could not be launched. */
  const failNextLaunch = (): void => {
    const original = runtime.submitTurn.bind(runtime);
    runtime.submitTurn = () => {
      runtime.submitTurn = original;
      throw new Error("simulated launch failure");
    };
  };

  it("fails a submission whose turn the adapter cannot start, once its task is recorded", async () => {
    failNextLaunch();
    const ack = await client.submitText("unlaunched");
    // Not answered ok, as it would be if the turn were started as an effect whose throw is only logged.
    expect(ack.disposition).toBe("failed");
    expect(ackError(ack).code).toBe("internal");
    expect(runtime.turns).toHaveLength(0);
    expect(rows("SELECT text, status FROM tasks")).toEqual([
      { text: "unlaunched", status: "running" },
    ]);
  });

  it("records the interruption of a task whose turn never started, with no runtime to interrupt", async () => {
    failNextLaunch();
    expect((await client.submitText("unlaunched")).disposition).toBe("failed");
    const { id: taskId } = must(rows<{ id: string }>("SELECT id FROM tasks")[0], "task row");
    const ack = await client.interrupt(taskId);
    expect(ackResult(ack)).toMatchObject({ execution_epoch: 2 });
    expect(taskStatus(taskId)).toBe("interrupting");
    // Its interrupt_runtime effect finds no runtime running the task and does nothing, rather than failing.
    expect(ts.logs).not.toContainEqual(expect.stringContaining("delivery failed"));
  });

  it("creates the session again on the turn after one whose runtime never started", async () => {
    const first = await submit("first");
    expect(first.turn.launch.resume).toBe(false);
    await client.interrupt(first.taskId);
    expect((await client.waitFor("task_finished")).payload.status).toBe("interrupted");
    await expectNextTurnSession(first, false);
  });

  it("creates the session again on the turn after one whose runtime exited before its init", async () => {
    const first = await submit("first");
    await first.turn.emit({
      type: "runtime_started",
      pid: 4242,
      launch: first.turn.launch,
      at: new Date().toISOString(),
    });
    first.turn.end("failed", "invalid settings");
    await expectNextTurnSession(first, false);
  });

  it("resumes the session on the turn after one whose runtime reported its init", async () => {
    const first = await submit("first");
    first.turn.init();
    first.turn.end();
    await expectNextTurnSession(first, true);
  });
});

describe("conversation start", () => {
  const conversationCount = () => rows("SELECT id FROM conversations").length;
  const startRow = (messageId: string) =>
    rows(
      "SELECT disposition, error_code, error_message FROM commands WHERE client_command_id = ?",
      messageId,
    );

  /** Sends start_conversation as `messageId` with its prompt read held; resolves once the engine is reading. */
  const startHoldingPrompt = async (messageId: string, sender: MiaClient = client) => {
    const held = ts.holdEvidenceRead(ts.profile.runtime.agentPromptFile);
    const ack = sender.send("start_conversation", {}, { messageId });
    await held.started;
    return { held, ack };
  };

  it("answers another connection while a start's read is held open, then records the conversation", async () => {
    const before = conversationCount();
    const { held, ack } = await startHoldingPrompt("cmd-start");
    const other = await ts.connect("client-B");
    expect((await other.sendDiagnostics()).disposition).toBe("accepted");
    expect(conversationCount()).toBe(before);
    held.release();
    const started = mustString(ackResult(await ack).conversation_id, "conversation id");
    expect(conversationCount()).toBe(before + 1);
    expect(rows("SELECT status FROM conversations WHERE id = ?", started)).toEqual([
      { status: "active" },
    ]);
  });

  it("answers a resend of a start still in flight with the original's reply, running it once", async () => {
    const before = conversationCount();
    const { held, ack } = await startHoldingPrompt("cmd-start");
    const again = await ts.connect("client-A");
    let answered = false;
    const resent = again.send("start_conversation", {}, { messageId: "cmd-start" }).finally(() => {
      answered = true;
    });
    // Commands on one connection are handled in order, so once this is answered the resend has been handled too.
    await again.sendDiagnostics();
    expect(answered).toBe(false);
    // Only one resend waits; a further one is refused at once, unrecorded.
    const third = await ts.connect("client-A");
    expect(
      ackError(await third.send("start_conversation", {}, { messageId: "cmd-start" })),
    ).toEqual({
      code: "busy",
      message: "this command is still running; resend it once its reply arrives",
    });
    held.release();
    const original = await ack;
    expect(await resent).toEqual({ ...original, duplicate: true });
    expect(conversationCount()).toBe(before + 1);
    expect(startRow("cmd-start")).toEqual([
      { disposition: "accepted", error_code: null, error_message: null },
    ]);
  });

  it("refuses a second start while one is in flight", async () => {
    const { held, ack } = await startHoldingPrompt("cmd-start");
    const second = await client.send("start_conversation", {}, { messageId: "cmd-start-2" });
    expect(ackError(second)).toEqual({ code: "busy", message: "another conversation is starting" });
    held.release();
    expect((await ack).disposition).toBe("accepted");
  });

  it("refuses a start whose guard fails once its reads settle, and keeps the current conversation", async () => {
    const current = must(client.conversationId, "conversation id");
    const before = conversationCount();
    const { held, ack } = await startHoldingPrompt("cmd-start");
    const { turn, taskId } = await submit("arrives while the start reads");
    held.release();
    expect(ackError(await ack).code).toBe("busy");
    expect(conversationCount()).toBe(before);
    expect(client.conversationId).toBe(current);
    await finishTurn(turn, taskId);
  });

  it("commits a start whose client disconnects during its reads, for its resend to adopt", async () => {
    const before = conversationCount();
    const { held, ack } = await startHoldingPrompt("cmd-start");
    const unanswered = ack.catch(() => undefined);
    const disconnected = ts.waitForLog((line) => line.endsWith(" closed"));
    client.close();
    await Promise.all([unanswered, disconnected]);
    const again = await ts.connect("client-A");
    const resent = again.send("start_conversation", {}, { messageId: "cmd-start" });
    await again.sendDiagnostics();
    held.release();
    const started = await resent;
    expect(started).toMatchObject({ disposition: "accepted", duplicate: true });
    expect(conversationCount()).toBe(before + 1);
    again.conversationId = mustString(ackResult(started).conversation_id, "conversation id");
    const next = runtime.nextTurn();
    const submitted = await again.submitText("on the adopted conversation");
    expect(submitted.disposition).toBe("accepted");
    (await next).end();
    await again.waitFor("task_finished");
  });

  it("stores the reply of a start that shutdown abandons before the catalog closes", async () => {
    const before = conversationCount();
    const { ack } = await startHoldingPrompt("cmd-start");
    const settled = ack.catch(() => undefined);
    await ts.server.close(new AbortController().signal);
    await settled;
    expect(startRow("cmd-start")).toEqual([
      {
        disposition: "rejected",
        error_code: "invalid_state",
        error_message: "conversation start abandoned: the server is shutting down",
      },
    ]);
    expect(conversationCount()).toBe(before);
    expect(ts.logs).not.toContainEqual(expect.stringContaining("command handling failed"));
  });

  it("refuses a start whose read outlives its deadline, and keeps the current conversation", async () => {
    const current = must(client.conversationId, "conversation id");
    const before = conversationCount();
    const { ack } = await startHoldingPrompt("cmd-start");
    ts.expireEvidenceReads();
    const refused = ackError(await ack);
    expect(refused.code).toBe("record_failure");
    expect(refused.message).toContain("timed out");
    expect(conversationCount()).toBe(before);
    expect(client.conversationId).toBe(current);
  });

  it("stores a start's snapshots before its transaction, and keeps the current conversation when it fails", async () => {
    const promptFile = ts.profile.runtime.agentPromptFile;
    const current = must(client.conversationId, "conversation id");
    const before = conversationRecords();
    const writtenInside = watchObjectWrites();
    const failedPrompt = "# a prompt whose start fails\n";
    writeFileSync(promptFile, failedPrompt);
    failNextCommit();
    expect(ackError(await client.send("start_conversation", {})).code).toBe("record_failure");
    expect(conversationRecords()).toEqual(before);
    expect(client.conversationId).toBe(current);
    expect(rows("SELECT status FROM conversations WHERE id = ?", current)).toEqual([
      { status: "active" },
    ]);
    // Stored before the transaction, then left unreferenced by its rollback.
    const digest = ObjectStore.digestOf(Buffer.from(failedPrompt));
    expect(objectStored(digest)).toBe(true);
    expect(rows("SELECT id FROM artifacts WHERE object_digest = ?", digest)).toEqual([]);
    writeFileSync(promptFile, "# a prompt whose start commits\n");
    await client.startConversation();
    expect(conversationRecords().conversations).toBe(before.conversations + 1);
    expect(writtenInside()).toBe(false);
  });

  it("leaves the conversation its client's when another client's start fails to commit", async () => {
    const current = must(client.conversationId, "conversation id");
    const closed = ts.waitForLog((line) => line.endsWith(" closed"));
    client.close();
    await closed;
    const other = await ts.connect("client-B");
    failNextCommit();
    expect(ackError(await other.send("start_conversation", {})).code).toBe("record_failure");
    // A task-scoped command passes the ownership guard only for the conversation's client, and then finds no task.
    const address = { conversation_id: current, task_id: "task_none" };
    expect(ackError(await other.send("interrupt_task", address))).toEqual({
      code: "busy",
      message: "the conversation belongs to another client",
    });
    const again = await ts.connect("client-A");
    expect(ackError(await again.send("interrupt_task", address)).code).toBe("not_found");
  });

  it("makes another client's started conversation the active one, its own, before telling it", async () => {
    const previous = must(client.conversationId, "conversation id");
    const closed = ts.waitForLog((line) => line.endsWith(" closed"));
    client.close();
    await closed;
    const { engine, gateway } = ts.server;
    const active: { conversation: string | null; client: string | null }[] = [];
    engine.attachDelivery((connectionId, event) => {
      if (event.type === "conversation_started")
        active.push({
          conversation: engine.conversation?.id ?? null,
          client: engine.activeClientId,
        });
      gateway.send(connectionId, event);
    });
    const other = await ts.connect("client-B");
    const started = mustString(
      ackResult(await other.send("start_conversation", {})).conversation_id,
      "conversation id",
    );
    expect(started).not.toBe(previous);
    expect(active).toEqual([{ conversation: started, client: "client-B" }]);
    expect((await other.waitFor("conversation_started")).payload.conversation_id).toBe(started);
  });

  it("gives a first start whose client disconnects during its reads no other client's connection", async () => {
    const fresh = await startTestServer(new ScriptedRuntime());
    try {
      const bystander = await fresh.connect("client-B");
      // Its first command makes its connection the active one: there is no conversation for anyone to own yet.
      expect((await bystander.sendDiagnostics()).disposition).toBe("accepted");
      const starter = await fresh.connect("client-A");
      const held = fresh.holdEvidenceRead(fresh.profile.runtime.agentPromptFile);
      const unanswered = starter
        .send("start_conversation", {}, { messageId: "cmd-first" })
        .catch(() => undefined);
      await held.started;
      const closed = fresh.waitForLog((line) => line.endsWith(" closed"));
      starter.close();
      await Promise.all([unanswered, closed]);
      const again = await fresh.connect("client-A");
      const resent = again.send("start_conversation", {}, { messageId: "cmd-first" });
      held.release();
      const conversationId = mustString(ackResult(await resent).conversation_id, "conversation id");
      // The conversation is client A's, reached through no connection until A adopts one: B is not told it started,
      // and cannot act on it.
      expect(bystander.events.map((event) => event.type)).not.toContain("conversation_started");
      const address = { conversation_id: conversationId, task_id: "task_none" };
      expect(ackError(await bystander.send("interrupt_task", address))).toEqual({
        code: "busy",
        message: "the conversation belongs to another client",
      });
      expect(ackError(await again.send("interrupt_task", address)).code).toBe("not_found");
    } finally {
      await fresh.close();
    }
  });

  it("refuses a start whose prompt is a FIFO or too large, without waiting on it", async () => {
    const promptFile = ts.profile.runtime.agentPromptFile;
    rmSync(promptFile);
    execFileSync("mkfifo", [promptFile]);
    const fifo = ackError(await client.send("start_conversation", {}));
    expect(fifo.code).toBe("record_failure");
    expect(fifo.message).toContain("not a regular file");
    rmSync(promptFile);
    writeFileSync(promptFile, "");
    truncateSync(promptFile, MAX_CONVERSATION_FILE_BYTES + 1);
    const large = ackError(await client.send("start_conversation", {}));
    expect(large.message).toContain(`larger than ${MAX_CONVERSATION_FILE_BYTES} bytes`);
  });
});

describe("configuration and provenance", () => {
  it("records the runtime identity probed at startup, not at each conversation start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mia-identity-"));
    try {
      // A runtime whose `--version` answers whatever the file holds, so an upgrade mid-run is one write.
      const versionFile = join(dir, "version");
      writeFileSync(versionFile, "1.0.0 (Claude Code)\n");
      const executable = join(dir, "claude");
      writeFileSync(
        executable,
        `#!/bin/sh\nread -r version < '${versionFile}'\necho "$version"\n`,
        { mode: 0o755 },
      );
      const server = await startTestServer(new ScriptedRuntime(), { executable });
      try {
        // Upgraded after startup but before any conversation: a probe deferred to the first start would see it.
        writeFileSync(versionFile, "2.0.0 (Claude Code)\n");
        const identityClient = await server.connect();
        await identityClient.startConversation();
        await identityClient.startConversation();
        const catalog = server.catalog();
        try {
          const versions = catalog
            .all<{
              version: string | null;
            }>("SELECT version FROM provenance_entries WHERE role = 'runtime_identity'")
            .map((row) => row.version);
          expect(versions).toEqual(["1.0.0 (Claude Code)", "1.0.0 (Claude Code)"]);
        } finally {
          catalog.close();
        }
      } finally {
        await server.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** The current conversation's agent prompt provenance: whether it was retained, and the digest of the bytes. */
  const promptProvenance = () =>
    must(
      rows<{ availability: string; object_digest: string | null }>(
        `SELECT p.availability, a.object_digest FROM provenance_entries p
         JOIN conversations c ON c.provenance_set_id = p.provenance_set_id
         LEFT JOIN artifacts a ON a.id = p.artifact_id
         WHERE p.role = 'agent_prompt' AND c.id = ?`,
        must(client.conversationId, "conversation id"),
      )[0],
      "agent prompt provenance",
    );

  it("runs every turn on the retained prompt object whose digest provenance recorded", async () => {
    const original = readFileSync(ts.profile.runtime.agentPromptFile, "utf8");
    const digest = must(promptProvenance().object_digest, "agent prompt digest");
    const retained = new ObjectStore(ts.server.catalog.paths).pathFor(digest);
    const first = await submit("first");
    expect(first.turn.options.agentPromptFile).toBe(retained);
    first.turn.init();
    await finishTurn(first.turn, first.taskId);
    const second = await submit("second");
    expect(second.turn.options.agentPromptFile).toBe(retained);
    expect(readFileSync(retained, "utf8")).toBe(original);
    await finishTurn(second.turn, second.taskId);
  });

  it("appends no prompt to a conversation whose prompt file was missing at start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mia-no-prompt-"));
    try {
      await restartSession({ agentPromptFile: join(dir, "missing.md") });
      expect(promptProvenance()).toEqual({ availability: "unavailable", object_digest: null });
      const { turn, taskId } = await submit("no prompt");
      expect(turn.options.agentPromptFile).toBeNull();
      await finishTurn(turn, taskId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers declared tool outputs inside the output directory and ignores unmatched calls", async () => {
    const { file, turn } = await approvedArtifactCall();
    await turn.toolResult(
      "toolu_1",
      JSON.stringify({ artifact: { path: file, name: "result.txt", mime_type: "text/plain" } }),
    );
    await turn.toolResult(
      "toolu_x",
      JSON.stringify({ artifact: { path: "/etc/hostname", name: "hostname" } }),
    );
    await finishTurn(turn);
    const artifacts = rows<{
      logical_name: string;
      capture_status: CaptureStatus;
      object_digest: string | null;
    }>(
      "SELECT logical_name, capture_status, object_digest FROM artifacts WHERE kind = 'tool_output'",
    );
    const retained = must(
      artifacts.find((artifact) => artifact.logical_name === "result.txt"),
      "retained artifact",
    );
    expect(retained.capture_status).toBe("retained");
    writeFileSync(file, "tampered");
    expect(
      new ObjectStore(ts.server.catalog.paths)
        .readSync(must(retained.object_digest, "object digest"))
        .toString(),
    ).toBe("D1");
    expect(existsSync(file)).toBe(true);
    // the unmatched tool_use id (toolu_x) is recorded, not collected
    expect(eventCount("tool_result_unmatched")).toBe(1);
    expect(artifacts.find((artifact) => artifact.logical_name === "hostname")).toBeUndefined();
  });

  /** Approve one artifact call, then hand over its result declaring `result.txt` while the capture is held. */
  const resultWithHeldCapture = async () => {
    const { file, turn, taskId } = await approvedArtifactCall();
    const capture = ts.holdArtifactCapture(file);
    const handled = declareOutput(turn, file);
    await capture.started;
    return { file, turn, taskId, capture, handled };
  };

  /** Release the held capture; the call then completes with its output retained. */
  const releaseIntoRetainedOutput = async (capture: HeldRead, handled: Promise<void>) => {
    capture.release();
    await handled;
    expect(callStatuses()).toEqual(["completed"]);
    expect(rows("SELECT capture_status FROM artifacts WHERE kind = 'tool_output'")).toEqual([
      { capture_status: "retained" },
    ]);
  };

  it("answers commands while a declared tool output is captured, then records the result with it", async () => {
    const { turn, capture, handled } = await resultWithHeldCapture();
    expect((await client.heartbeat()).disposition).toBe("accepted");
    expect(eventCount("tool_result")).toBe(0);
    await releaseIntoRetainedOutput(capture, handled);
    expect((await finishTurn(turn)).payload.status).toBe("completed");
  });

  it("records a result whose output is captured while its task is interrupted as completed", async () => {
    const { turn, taskId, capture, handled } = await resultWithHeldCapture();
    turn.survivesInterrupt = true;
    expect((await client.interrupt(taskId)).disposition).toBe("accepted");
    await releaseIntoRetainedOutput(capture, handled);
    await finishTurn(turn);
    expect(callStatuses()).toEqual(["completed"]);
  });

  // The adapter ends a turn before its pending event settles only when it stops reading a runtime whose
  // interruption did not end it: here the runtime survives the interrupt, and ending the turn stands for that.
  it("does not record a tool result whose output capture finishes after a stuck runtime was abandoned", async () => {
    const { file, turn, taskId, capture, handled } = await resultWithHeldCapture();
    turn.survivesInterrupt = true;
    expect((await client.interrupt(taskId)).disposition).toBe("accepted");
    await finishTurn(turn);
    const recorded = countRows("events");
    capture.release();
    await handled;
    expect(countRows("events")).toBe(recorded);
    expect(eventCount("tool_result")).toBe(0);
    expect(rows("SELECT 1 FROM artifacts WHERE kind = 'tool_output'")).toHaveLength(0);
    expect(ts.logs).toContainEqual(
      expect.stringContaining(`tool_result (output ${file} captured) for task ${taskId}`),
    );
  });

  it("records a non-retained capture with its reason, linked only to its tool call", async () => {
    const { turn } = await approvedArtifactCall();
    await turn.toolResult(
      "toolu_1",
      JSON.stringify({ artifact: { path: "/etc/hostname", name: "external" } }),
    );
    await finishTurn(turn);
    expect(
      rows(
        "SELECT a.capture_status, a.object_digest, a.external_locator, l.relation, l.tool_call_id IS NOT NULL AS linked FROM artifacts a JOIN artifact_links l ON l.artifact_id = a.id WHERE a.kind = 'tool_output'",
      ),
    ).toEqual([
      {
        capture_status: "external_only",
        object_digest: null,
        external_locator: "/etc/hostname",
        relation: "tool_result",
        linked: 1,
      },
    ]);
    expect(eventCount("artifact_registered")).toBe(0);
  });

  it("stores a declared tool output before the transaction that registers it opens", async () => {
    const { file, turn } = await approvedArtifactCall();
    const writtenInside = watchObjectWrites();
    await declareOutput(turn, file);
    const digest = ObjectStore.digestOf(Buffer.from("D1"));
    expect(rows("SELECT object_digest FROM artifacts WHERE kind = 'tool_output'")).toEqual([
      { object_digest: digest },
    ]);
    expect(objectStored(digest)).toBe(true);
    expect(writtenInside()).toBe(false);
    await finishTurn(turn);
  });

  // The rows that record a retained output commit with the tool result or not at all: retention was decided
  // before the transaction opened, so no failed write inside it falls back to recording a failed capture.
  it.each<[failure: string, fail: () => void, error: string]>([
    ["the tool result cannot commit", failNextCommit, "simulated commit failure"],
    [
      "the output rows cannot be written",
      () => failArtifactLinks("tool_result", "1"),
      "simulated link failure",
    ],
  ])(
    "leaves the call as it was, and no row pointing at the stored output, when %s",
    async (_failure, fail, error) => {
      const { file, turn, taskId } = await approvedArtifactCall();
      const statusBefore = callStatuses();
      const digest = ObjectStore.digestOf(Buffer.from("D1"));
      fail();
      await declareOutput(turn, file);
      expect(ts.logs).toContain(`failed to record tool_result: ${error}`);
      // Stored before the transaction, and referenced by no row once it rolled back.
      expect(objectStored(digest)).toBe(true);
      expect(rows("SELECT 1 FROM objects WHERE digest = ?", digest)).toHaveLength(0);
      expect(rows("SELECT 1 FROM artifacts WHERE kind = 'tool_output'")).toHaveLength(0);
      expect(eventCount("tool_result")).toBe(0);
      expect(callStatuses()).toEqual(statusBefore);
      const finished = await finishTurn(turn);
      // In memory the call never completed either, so the turn cannot say what it did.
      expect(finished.payload.status).toBe("outcome_unknown");
      expect(taskStatus(taskId)).toBe("outcome_unknown");
    },
  );

  it("records a tool result, and why its output is missing, when the output cannot be stored", async () => {
    const { file, turn } = await approvedArtifactCall();
    failObjectWrites();
    await declareOutput(turn, file);
    expect((await finishTurn(turn)).payload.status).toBe("completed");
    expect(callStatuses()).toEqual(["completed"]);
    expect(eventCount("tool_result")).toBe(1);
    expect(eventCount("artifact_registered")).toBe(0);
    expect(
      rows(
        "SELECT capture_status, capture_reason, object_digest, external_locator FROM artifacts WHERE kind = 'tool_output'",
      ),
    ).toEqual([
      {
        capture_status: "failed",
        capture_reason: expect.stringMatching(/^not retained: EEXIST: /),
        object_digest: null,
        external_locator: file,
      },
    ]);
    expect(
      rows(
        "SELECT l.relation FROM artifact_links l JOIN artifacts a ON a.id = l.artifact_id WHERE a.kind = 'tool_output'",
      ),
    ).toEqual([{ relation: "tool_result" }]);
  });
});
