import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigurationError, validateRuntimeConfig } from "@mia/agent-adapter";
import { ObjectStore } from "@mia/records";
import type { MiaClient } from "@mia/text-client";
import { ScriptedRuntime, type ScriptedTurn } from "./scripted-runtime.ts";
import {
  must,
  mustString,
  testProfile,
  tick,
  useScriptedSession,
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
  const ack = await client.submitText(text, messageId);
  expect(ack.disposition).toBe("accepted");
  const turn = await next;
  return { turn, taskId: mustString(ack.result?.task_id, "ack task_id") };
};

const rows = <T = Record<string, unknown>>(sql: string, ...params: (string | number)[]): T[] => {
  const cat = ts.catalog();
  try {
    return cat.all<T>(sql, ...params);
  } finally {
    cat.close();
  }
};

/** Submit a turn whose one tool call is held at the approval gate: where the approval and interruption tests start. */
const submitHeldCall = async (
  text: string,
  tool = "mcp__d1__change",
  args: Record<string, unknown> = { delta: 1 },
) => {
  const { turn, taskId } = await submit(text);
  turn.init();
  const held = turn.request(tool, args, "toolu_1");
  const requested = await client.waitFor("approval_requested");
  return { turn, taskId, held, requested };
};

const decide = (taskId: string, approvalId: string, decision: "approve" | "reject") =>
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

/** Make every delivery of one event type to the client throw, as a failing socket would. */
const failDelivery = (type: string): void => {
  const engine = ts.server.engine;
  const send = engine.send;
  engine.send = (connectionId, event) => {
    if (event.type === type) throw new Error("simulated socket failure");
    send(connectionId, event);
  };
};

/** Approval statuses in catalog order: how these tests show that nothing was authorised. */
const approvalStatuses = (): string[] =>
  rows<{ status: string }>("SELECT status FROM approvals").map((row) => row.status);

describe("streaming and commands", () => {
  it("streams deltas in order before completion and deduplicates command ids", async () => {
    const { turn, taskId } = await submit("hello", "cmd-1");
    turn.init();
    turn.text("Hel");
    turn.text("lo");
    turn.end();
    const finished = await client.waitFor("task_finished");
    expect(finished.payload.status).toBe("completed");
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
    // resend with the same message id: duplicate disposition, no new task
    const dup = await client.submitText("hello", "cmd-1");
    expect(dup.disposition).toBe("duplicate");
    expect(runtime.turns).toHaveLength(1);
    // same id, different payload: conflict, nothing executed
    const conflict = await client.submitText("different", "cmd-1");
    expect(conflict.disposition).toBe("rejected");
    expect(conflict.error?.code).toBe("duplicate_command_conflict");
    expect(rows("SELECT id FROM tasks")).toHaveLength(1);
    expect(
      must(rows<{ status: string }>("SELECT status FROM tasks WHERE id = ?", taskId)[0]).status,
    ).toBe("completed");
  });

  it("rejects unsupported protocol versions, invalid JSON, oversized text and busy submissions", async () => {
    const rejected = client.waitFor("ack", (event) => event.payload.disposition === "rejected");
    client.sendRaw(
      JSON.stringify({
        protocol_version: 99,
        message_id: "x1",
        client_id: client.clientId,
        type: "submit_text",
        payload: {},
      }),
    );
    const ack = await rejected;
    expect(ack.payload.error?.code).toBe("unsupported_protocol_version");
    expect(ack.payload.error?.message).toContain("protocol_version 1");
    const bad = client.waitFor("ack", (event) => event.payload.command_id === "unknown");
    client.sendRaw("{not json");
    expect((await bad).payload.error?.code).toBe("invalid_message");
    const big = await client.submitText("x".repeat(40_000));
    expect(big.disposition).toBe("rejected");
    expect(big.error?.code).toBe("invalid_message");
    const { turn } = await submit("first");
    const busy = await client.submitText("second");
    expect(busy.disposition).toBe("rejected");
    expect(busy.error?.code).toBe("busy");
    const other = await ts.connect("client-B");
    const otherBusy = await other.send("submit_text", {
      conversation_id: must(client.conversationId, "conversation id"),
      text: "hi",
    });
    expect(otherBusy.error?.code).toBe("busy");
    turn.end();
    await client.waitFor("task_finished");
  });
});

describe("approval path", () => {
  it("holds a call until approval, releases exactly once, and never releases a rejected call", async () => {
    const { turn, taskId } = await submit("change once");
    turn.init();
    turn.propose("toolu_1", "mcp__d1__change", { delta: 1 });
    const decision = turn.request("mcp__d1__change", { delta: 1 }, "toolu_1");
    const requested = await client.waitFor("approval_requested");
    expect(requested.payload.tool_identity).toBe("mcp__d1__change");
    expect(requested.payload.redacted_arguments).toEqual({ delta: 1 });
    expect(requested.payload.binding_revision).toBe(1);
    await tick();
    expect(turn.decisions).toHaveLength(0); // still held
    expect(approvalStatuses()).toEqual(["pending"]);
    const ack = await decide(taskId, requested.payload.approval_id, "approve");
    expect(ack.disposition).toBe("accepted");
    expect(ack.result?.released).toBe(true);
    expect((await decision).behavior).toBe("allow");
    // decision persisted before release: approval_resolved precedes tool_dispatched in the event log
    const types = rows<{ type: string }>("SELECT type FROM events ORDER BY sequence").map(
      (row) => row.type,
    );
    expect(types.indexOf("approval_resolved")).toBeLessThan(types.indexOf("tool_dispatched"));
    // a second decision on the same approval cannot reuse it
    const reuse = await decide(taskId, requested.payload.approval_id, "approve");
    expect(reuse.disposition).toBe("rejected");
    expect(reuse.error?.code).toBe("invalid_state");
    turn.toolResult("toolu_1", JSON.stringify({ counter: 1 }));
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
    turn.toolResult("toolu_2", "denied", true);
    turn.end();
    const finished = await client.waitFor("task_finished");
    expect(finished.payload.status).toBe("completed");
    const calls = rows<{ runtime_call_id: string; status: string }>(
      "SELECT runtime_call_id, status FROM tool_calls ORDER BY created_at",
    );
    expect(calls).toEqual([
      { runtime_call_id: "toolu_1", status: "completed" },
      { runtime_call_id: "toolu_2", status: "denied" },
    ]);
  });

  it("invalidates an approval when arguments change under the same runtime call id", async () => {
    const { turn, taskId } = await submit("change");
    turn.init();
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
    // the old approval id cannot authorise the new binding
    const stale = await decide(taskId, requested1.payload.approval_id, "approve");
    expect(stale.error?.code).toBe("invalid_state");
    await decide(taskId, requested2.payload.approval_id, "approve");
    expect((await second).behavior).toBe("allow");
    turn.end();
    await client.waitFor("task_finished");
    const revisions = rows<{ binding_revision: number; status: string }>(
      "SELECT binding_revision, status FROM tool_calls WHERE runtime_call_id = 'toolu_1' ORDER BY binding_revision",
    );
    expect(revisions.map((row) => row.status)).toEqual(["invalidated", "unknown"]);
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
    const ack = await decide(taskId, requested.payload.approval_id, "approve");
    expect(ack.result?.released).toBe(true);
    expect((await held).behavior).toBe("allow");
    expect(turn.decisions.map(({ decision }) => decision.behavior)).toEqual(["deny", "allow"]);
    expect(approvalStatuses()).toEqual(["approved"]);
    expect(
      rows<{ status: string }>("SELECT status FROM tool_calls").map((row) => row.status),
    ).toEqual(["dispatched"]);
    turn.end();
    await client.waitFor("task_finished");
  });

  it("rejects decisions with wrong task, wrong client, or foreign ids", async () => {
    const { turn, taskId, held, requested } = await submitHeldCall("change");
    expect((await decide("task_wrong", requested.payload.approval_id, "approve")).error?.code).toBe(
      "not_found",
    );
    expect((await decide(taskId, "appr_foreign", "approve")).error?.code).toBe("not_found");
    const other = await ts.connect("client-B");
    const foreign = await other.send("approval_decision", {
      conversation_id: must(client.conversationId, "conversation id"),
      task_id: taskId,
      approval_id: requested.payload.approval_id,
      decision: "approve",
    });
    expect(foreign.error?.code).toBe("busy");
    await tick();
    expect(turn.decisions).toHaveLength(0);
    await decide(taskId, requested.payload.approval_id, "reject");
    expect((await held).behavior).toBe("deny");
    turn.end();
    await client.waitFor("task_finished");
  });

  it("denies unlisted tools, policy-denied proposals, and requests without a runtime call id", async () => {
    const { turn } = await submit("bad tools");
    turn.init();
    const forbidden = await turn.request("mcp__d1__forbidden", {}, "toolu_f");
    expect(forbidden.behavior).toBe("deny");
    const unlisted = await turn.request("mcp__d1__mystery", {}, "toolu_m");
    expect(unlisted.behavior).toBe("deny");
    const noId = await turn.request("mcp__d1__change", { delta: 1 }, undefined);
    expect(noId.behavior).toBe("deny");
    expect(rows("SELECT id FROM approvals")).toHaveLength(0);
    await tick();
    const errors = client.events.flatMap((event) =>
      event.type === "error" ? [event.payload.code] : [],
    );
    expect(errors).toContain("configuration_error");
    expect(errors).toContain("runtime_failure");
    turn.end();
    await client.waitFor("task_finished");
    const statuses = rows<{ tool_identity: string; status: string }>(
      "SELECT tool_identity, status FROM tool_calls",
    );
    expect(statuses.find((row) => row.tool_identity === "mcp__d1__forbidden")?.status).toBe(
      "denied",
    );
  });

  it("keeps the call held when the decision cannot be persisted", async () => {
    const { turn, taskId, held, requested } = await submitHeldCall("change");
    failNextCommit();
    const ack = await decide(taskId, requested.payload.approval_id, "approve");
    expect(ack.disposition).toBe("rejected");
    expect(ack.error?.code).toBe("record_failure");
    await tick();
    expect(turn.decisions).toHaveLength(0);
    expect(approvalStatuses()).toEqual(["pending"]);
    const retry = await decide(taskId, requested.payload.approval_id, "approve");
    expect(retry.disposition).toBe("accepted");
    expect((await held).behavior).toBe("allow");
    turn.end();
    await client.waitFor("task_finished");
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
    turn.end();
    await client.waitFor("task_finished");
  });

  it("leaves no call behind when a permission request cannot be recorded", async () => {
    const { turn } = await submit("read");
    turn.init();
    failNextCommit();
    const read = await turn.request("mcp__d1__read", {}, "toolu_1");
    expect(read.behavior).toBe("deny");
    turn.end();
    const finished = await client.waitFor("task_finished");
    expect(finished.payload.status).toBe("completed");
    expect(rows("SELECT id FROM tool_calls")).toHaveLength(0);
  });

  it("keeps the earlier approval pending when a changed binding cannot be recorded", async () => {
    const { turn, taskId, held, requested } = await submitHeldCall("change");
    failNextCommit();
    expect((await turn.request("mcp__d1__change", { delta: 2 }, "toolu_1")).behavior).toBe("deny");
    expect(approvalStatuses()).toEqual(["pending"]);
    const ack = await decide(taskId, requested.payload.approval_id, "approve");
    expect(ack.disposition).toBe("accepted");
    expect((await held).behavior).toBe("allow");
    turn.end();
    await client.waitFor("task_finished");
  });

  it("expires an approval whose prompt the runtime abandoned and tells the next turn", async () => {
    const { turn, held } = await submitHeldCall("change");
    must(turn.pendingAbandons[0], "held prompt").abort();
    expect((await held).behavior).toBe("deny");
    expect(approvalStatuses()).toEqual(["expired"]);
    turn.end();
    expect((await client.waitFor("task_finished")).payload.status).toBe("completed");
    expect(must(rows<{ status: string }>("SELECT status FROM tool_calls")[0]).status).toBe(
      "invalidated",
    );
    const { turn: next } = await submit("did it run?");
    expect(next.options.text).toContain("abandoned the approval prompt");
    next.end();
  });

  it("treats disconnection as no decision and keeps the pending record", async () => {
    const { turn, taskId, held, requested } = await submitHeldCall("change");
    client.close();
    await tick();
    await tick();
    expect(turn.decisions).toHaveLength(0);
    expect(approvalStatuses()).toEqual(["pending"]);
    expect(rows("SELECT id FROM events WHERE type = 'client_disconnected'")).toHaveLength(1);
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
});

describe("interruption path", () => {
  it("keeps the gate open and the approval pending when an interruption cannot be recorded", async () => {
    const { turn, taskId, held, requested } = await submitHeldCall("change");
    failNextCommit();
    const ack = await client.interrupt(taskId);
    expect(ack.error?.code).toBe("record_failure");
    await tick();
    expect(turn.interrupted).toBe(false);
    expect(turn.decisions).toHaveLength(0);
    expect(approvalStatuses()).toEqual(["pending"]);
    await decide(taskId, requested.payload.approval_id, "approve");
    expect((await held).behavior).toBe("allow");
    turn.end();
    expect((await client.waitFor("task_finished")).payload.status).toBe("outcome_unknown");
  });

  it("interrupt before release: gate closes, approval is stale, nothing dispatches", async () => {
    const { taskId, held, requested } = await submitHeldCall("change");
    const ack = await client.interrupt(taskId);
    expect(ack.disposition).toBe("accepted");
    const decision = await held;
    expect(decision.behavior).toBe("deny");
    const late = await decide(taskId, requested.payload.approval_id, "approve");
    expect(late.error?.code).toBe("invalid_state");
    const outcome = await client.waitFor("interruption_outcome");
    expect(outcome.payload.task_status).toBe("interrupted");
    expect(outcome.payload.actions[0]?.status).toBe("invalidated");
    expect(outcome.payload.runtime_cancellation).toBe("forced_kill");
    expect(rows("SELECT id FROM events WHERE type = 'tool_dispatched'")).toHaveLength(0);
    const finished = await client.waitFor("task_finished");
    expect(finished.payload.status).toBe("interrupted");
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
    const { turn: next } = await submit("what happened?");
    expect(next.options.text).toContain("[Mia note, not from the user]");
    expect(next.options.text).toContain("mcp__d1__slow: unknown");
    expect(next.options.text.endsWith("what happened?")).toBe(true);
    const recorded = rows<{ payload: string }>(
      "SELECT payload FROM events WHERE type = 'task_submitted' ORDER BY sequence",
    );
    expect(JSON.parse(must(recorded[1], "second task_submitted event").payload).text).toBe(
      "what happened?",
    );
    next.end();
    await client.waitFor("task_finished", (event) => event.payload.task_id !== taskId);
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
    const submission = await submit("slow then change");
    const turn = submission.turn;
    const taskId = submission.taskId;
    turn.survivesInterrupt = true;
    turn.init();
    const slow = turn.request("mcp__d1__slow", { mode: "cancellable" }, "toolu_1");
    const requested = await client.waitFor("approval_requested");
    await decide(taskId, requested.payload.approval_id, "approve");
    expect((await slow).behavior).toBe("allow");
    await client.interrupt(taskId);
    const change = await turn.request("mcp__d1__change", { delta: 1 }, "toolu_2");
    expect(change.behavior).toBe("deny");
    expect(
      must(
        rows<{ status: string }>(
          "SELECT status FROM tool_calls WHERE runtime_call_id = 'toolu_2'",
        )[0],
      ).status,
    ).toBe("blocked_gate");
    turn.end("failed", "killed late");
    const outcome = await client.waitFor("interruption_outcome");
    expect(outcome.payload.runtime_cancellation).toBe("unknown");
    expect(
      outcome.payload.actions.find((action) => action.tool_identity === "mcp__d1__change")?.status,
    ).toBe("blocked_gate");
  });

  it("reports unknown when a released call's result cannot be recorded", async () => {
    const { turn } = await submit("read");
    turn.init();
    expect((await turn.request("mcp__d1__read", {}, "toolu_1")).behavior).toBe("allow");
    failNextCommit();
    turn.toolResult("toolu_1", "ok");
    turn.end();
    const finished = await client.waitFor("task_finished");
    expect(finished.payload.status).toBe("outcome_unknown");
    expect(must(rows<{ status: string }>("SELECT status FROM tool_calls")[0]).status).toBe(
      "unknown",
    );
  });

  it("reports unknown when a released call never returns a result", async () => {
    const { turn } = await submit("read");
    turn.init();
    const read = await turn.request("mcp__d1__read", {}, "toolu_1");
    expect(read.behavior).toBe("allow");
    turn.end("failed", "runtime crashed");
    const finished = await client.waitFor("task_finished");
    expect(finished.payload.status).toBe("outcome_unknown");
    expect(finished.payload.error).toContain("runtime crashed");
    expect(must(rows<{ status: string }>("SELECT status FROM tool_calls")[0]).status).toBe(
      "unknown",
    );
    // The configured policy is unchanged by the unknown outcome: the model, not the harness, judges whether a repeat is
    // safe, and it is told what is unknown through the Mia note on its next turn.
    const { turn: next, taskId } = await submit("read again");
    expect(next.options.text).toContain("[Mia note, not from the user]");
    expect(next.options.text).toContain("mcp__d1__read: unknown");
    const again = await next.request("mcp__d1__read", {}, "toolu_2");
    expect(again.behavior).toBe("allow");
    next.end();
    await client.waitFor("task_finished", (event) => event.payload.task_id === taskId);
  });
});

describe("configuration and provenance", () => {
  it("refuses unsupported tool surfaces and unresolved placeholders", () => {
    const profile = testProfile(ts.dir);
    expect(() => validateRuntimeConfig({ ...profile.runtime, builtinTools: ["Bash"] })).toThrow(
      ConfigurationError,
    );
    expect(() =>
      validateRuntimeConfig({ ...profile.runtime, toolPolicy: { mcp__other__x: "ask" } }),
    ).toThrow(ConfigurationError);
    expect(() => validateRuntimeConfig({ ...profile.runtime, env: { MY_API_KEY: "x" } })).toThrow(
      ConfigurationError,
    );
  });

  it("registers declared tool outputs inside the output directory and ignores unmatched calls", async () => {
    const outDir = must(ts.profile.runtime.outputDirectories[0], "output directory");
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, "result.txt");
    writeFileSync(file, "D1");
    const { turn, taskId } = await submit("artifact");
    turn.init();
    const decision = turn.request(
      "mcp__d1__artifact",
      { name: "result.txt", text: "D1" },
      "toolu_1",
    );
    const requested = await client.waitFor("approval_requested");
    await client.decide({
      taskId: taskId,
      approvalId: requested.payload.approval_id,
      decision: "approve",
    });
    await decision;
    turn.toolResult(
      "toolu_1",
      JSON.stringify({ artifact: { path: file, name: "result.txt", mime_type: "text/plain" } }),
    );
    turn.toolResult(
      "toolu_x",
      JSON.stringify({ artifact: { path: "/etc/hostname", name: "hostname" } }),
    );
    turn.end();
    await client.waitFor("task_finished");
    const artifacts = rows<{
      logical_name: string;
      capture_status: string;
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
        .read(must(retained.object_digest, "object digest"))
        .toString(),
    ).toBe("D1");
    expect(existsSync(file)).toBe(true);
    // the unmatched tool_use id (toolu_x) is recorded, not collected
    expect(rows("SELECT id FROM events WHERE type = 'tool_result_unmatched'")).toHaveLength(1);
    expect(artifacts.find((artifact) => artifact.logical_name === "hostname")).toBeUndefined();
  });

  it("records a non-retained capture with its reason, linked only to its tool call", async () => {
    const outDir = must(ts.profile.runtime.outputDirectories[0], "output directory");
    mkdirSync(join(outDir, "folder"), { recursive: true });
    const declarations = {
      toolu_1: { path: "/etc/hostname", name: "external" },
      toolu_2: { path: join(outDir, "folder"), name: "directory" },
      toolu_3: { path: join(outDir, "absent.txt"), name: "absent" },
      toolu_4: { path: "outputs/absent.txt", name: "relative" },
    };
    const { turn, taskId } = await submit("artifacts");
    turn.init();
    for (const [callId, artifact] of Object.entries(declarations)) {
      const pending = turn.request("mcp__d1__artifact", { name: artifact.name }, callId);
      const requested = await client.waitFor(
        "approval_requested",
        (event) => event.payload.runtime_call_id === callId,
      );
      await decide(taskId, requested.payload.approval_id, "approve");
      await pending;
      turn.toolResult(callId, JSON.stringify({ artifact }));
    }
    turn.end();
    await client.waitFor("task_finished");
    const captured = rows<{ logical_name: string; capture_status: string; capture_reason: string }>(
      "SELECT logical_name, capture_status, capture_reason FROM artifacts WHERE kind = 'tool_output' AND object_digest IS NULL AND external_locator = original_path ORDER BY logical_name",
    );
    expect(captured).toEqual([
      { logical_name: "absent", capture_status: "missing", capture_reason: expect.any(String) },
      { logical_name: "directory", capture_status: "failed", capture_reason: expect.any(String) },
      {
        logical_name: "external",
        capture_status: "external_only",
        capture_reason: expect.any(String),
      },
      {
        logical_name: "relative",
        capture_status: "failed",
        capture_reason: "declared path must be absolute",
      },
    ]);
    const relations = rows<{ relation: string }>(
      "SELECT l.relation FROM artifact_links l JOIN artifacts a ON a.id = l.artifact_id WHERE a.kind = 'tool_output' AND l.tool_call_id IS NOT NULL",
    );
    expect(relations).toEqual(Array.from({ length: 4 }, () => ({ relation: "tool_result" })));
    expect(rows("SELECT id FROM artifact_links WHERE relation = 'task_output'")).toHaveLength(0);
    expect(rows("SELECT id FROM events WHERE type = 'artifact_registered'")).toHaveLength(0);
    expect(rows("SELECT id FROM events WHERE type = 'tool_result'")).toHaveLength(4);
  });
});
