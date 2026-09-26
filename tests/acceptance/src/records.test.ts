import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ObjectStore,
  exportConversationSync,
  reconcileObjectsSync,
  snapshotConversation,
  verifyExportSync,
} from "@mia/records";
import type { MiaClient } from "@mia/text-client";
import type { ScriptedRuntime } from "./scripted-runtime.ts";
import { ackResult, must, mustString, useScriptedSession, type TestServer } from "./harness.ts";

let runtime: ScriptedRuntime;
let ts: TestServer;
let client: MiaClient;
useScriptedSession((session) => {
  ({ runtime, server: ts, client } = session);
});

const ExportedArtifactRow = z.object({ logical_name: z.string(), object_digest: z.string() });
const ExportedEventRow = z.object({ sequence: z.number() });
const jsonLines = <T>(path: string, schema: z.ZodType<T>): T[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => schema.parse(JSON.parse(line)));

/** Build a conversation containing every evidence type the D1 verification list asks for. */
const richConversation = async (): Promise<{ conversationId: string; artifactFile: string }> => {
  const outDir = must(ts.profile.runtime.outputDirectories[0], "output directory");
  mkdirSync(outDir, { recursive: true });
  const artifactFile = join(outDir, "result.txt");
  writeFileSync(artifactFile, "D1");
  // task 1: stream + approve + reject + artifact
  let next = runtime.nextTurn();
  let ack = await client.submitText("do things");
  const taskId = mustString(ackResult(ack).task_id, "ack task_id");
  const turn = await next;
  turn.init("scripted-model");
  turn.text("Working on it. secret sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 leaked?");
  const p1 = turn.request(
    "mcp__d1__change",
    { delta: 1, token: "super-secret-value-123456" },
    "toolu_1",
  );
  const r1 = await client.waitFor(
    "approval_requested",
    (event) => event.payload.runtime_call_id === "toolu_1",
  );
  await client.decide({ taskId: taskId, approvalId: r1.payload.approval_id, decision: "approve" });
  await p1;
  await turn.toolResult("toolu_1", JSON.stringify({ counter: 1 }));
  const p2 = turn.request("mcp__d1__change", { delta: 1 }, "toolu_2");
  const r2 = await client.waitFor(
    "approval_requested",
    (event) => event.payload.runtime_call_id === "toolu_2",
  );
  await client.decide({ taskId: taskId, approvalId: r2.payload.approval_id, decision: "reject" });
  await p2;
  await turn.toolResult("toolu_2", "denied", true);
  const p3 = turn.request("mcp__d1__artifact", { name: "result.txt", text: "D1" }, "toolu_3");
  const r3 = await client.waitFor(
    "approval_requested",
    (event) => event.payload.runtime_call_id === "toolu_3",
  );
  await client.decide({ taskId: taskId, approvalId: r3.payload.approval_id, decision: "approve" });
  await p3;
  await turn.toolResult(
    "toolu_3",
    JSON.stringify({
      artifact: { path: artifactFile, name: "result.txt", mime_type: "text/plain" },
    }),
  );
  await turn.request("mcp__d1__mystery", {}, "toolu_4"); // produces an error event
  turn.end();
  await client.waitFor("task_finished", (event) => event.payload.task_id === taskId);
  await client.sendDiagnostics();
  // task 2: interruption with an in-flight action
  next = runtime.nextTurn();
  ack = await client.submitText("slow");
  const task2 = mustString(ackResult(ack).task_id, "ack task_id");
  const turn2 = await next;
  turn2.init();
  const slow = turn2.request("mcp__d1__slow", { mode: "uncancellable" }, "toolu_5");
  const r5 = await client.waitFor(
    "approval_requested",
    (event) => event.payload.runtime_call_id === "toolu_5",
  );
  await client.decide({ taskId: task2, approvalId: r5.payload.approval_id, decision: "approve" });
  await slow;
  await client.interrupt(task2);
  await client.waitFor("task_finished", (event) => event.payload.task_id === task2);
  return { conversationId: must(client.conversationId, "conversation id"), artifactFile };
};

describe("records, report and export", () => {
  it("produces one report covering streamed output, approvals, interruption, errors, diagnostics, a generated file and provenance; exports and verifies offline; survives source edits", async () => {
    const { conversationId, artifactFile } = await richConversation();
    const exportDir = join(ts.dir, "export-1");
    const catalog = ts.catalog();
    const snapshot = snapshotConversation(catalog, conversationId);
    expect(snapshot.tables.tasks).toHaveLength(2);
    expect(snapshot.tables.events.some((event) => event.type === "text_delta")).toBe(true);
    expect(snapshot.tables.approvals.map((approval) => approval.status).sort()).toEqual([
      "approved",
      "approved",
      "approved",
      "rejected",
    ]);
    expect(snapshot.tables.events.some((event) => event.type === "interruption_outcome")).toBe(
      true,
    );
    expect(snapshot.tables.events.some((event) => event.type === "error")).toBe(true);
    expect(snapshot.tables.diagnostics.length).toBeGreaterThan(0);
    // The runtime's own result message is the recorded evidence; usage keeps its stored snake_case keys.
    expect(
      snapshot.tables.events
        .filter((event) => event.type === "runtime_result")
        .map((event): unknown => JSON.parse(event.payload)),
    ).toContainEqual({ scripted: "result", session: expect.any(String) });
    expect(
      snapshot.tables.executions
        .flatMap((execution) => (execution.usage ? [execution.usage] : []))
        .map((usage): unknown => JSON.parse(usage)),
    ).toContainEqual({
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
      duration_ms: 5,
      num_turns: 1,
    });
    expect(
      snapshot.tables.artifacts.some(
        (artifact) => artifact.kind === "tool_output" && artifact.capture_status === "retained",
      ),
    ).toBe(true);
    expect(
      snapshot.tables.provenance_entries.some(
        (entry) => entry.role === "agent_prompt" && entry.availability === "retained",
      ),
    ).toBe(true);
    expect(
      snapshot.tables.provenance_entries.some(
        (entry) => entry.role === "runtime_instructions" && entry.availability === "unavailable",
      ),
    ).toBe(true);
    // Seeded credentials never reach the records.
    const dump = JSON.stringify(snapshot.tables);
    expect(dump).not.toContain("sk-ant-api03");
    expect(dump).not.toContain("super-secret-value-123456");
    const result = exportConversationSync(catalog, conversationId, exportDir);
    catalog.close();
    expect(result.manifest.complete).toBe(true);
    const verification = verifyExportSync(exportDir);
    expect(verification.problems).toEqual([]);
    const report = readFileSync(join(exportDir, "report.html"), "utf8");
    expect(report).toContain("partial output");
    expect(report).not.toContain("sk-ant-api03");
    // Edit the original generated file and the prompt after export: retained bytes still verify.
    writeFileSync(artifactFile, "changed later");
    writeFileSync(ts.profile.runtime.agentPromptFile, "edited prompt");
    expect(verifyExportSync(exportDir).ok).toBe(true);
    const artifacts = jsonLines(join(exportDir, "records/artifacts.jsonl"), ExportedArtifactRow);
    const retained = must(
      artifacts.find((artifact) => artifact.logical_name === "result.txt"),
      "retained artifact",
    );
    expect(
      readFileSync(
        join(
          exportDir,
          "objects/sha256",
          retained.object_digest.slice(0, 2),
          retained.object_digest,
        ),
        "utf8",
      ),
    ).toBe("D1");
  });

  it("exports from one consistent snapshot: events written during export do not leak", async () => {
    const next = runtime.nextTurn();
    const ack = await client.submitText("stream");
    const turn = await next;
    turn.init();
    const delivered = (text: string) =>
      client.waitFor("text_delta", (event) => event.payload.text === text);
    turn.text("a");
    await delivered("a");
    const catalog = ts.catalog();
    const conversationId = must(client.conversationId, "conversation id");
    const before = snapshotConversation(catalog, conversationId).cutoff_sequence;
    // Write more events while exporting: the export must stop at its own cutoff.
    turn.text("b");
    turn.text("c");
    await delivered("c");
    const exportDir = join(ts.dir, "export-2");
    const result = exportConversationSync(catalog, conversationId, exportDir);
    catalog.close();
    expect(result.manifest.cutoff_sequence).toBeGreaterThanOrEqual(before);
    const events = jsonLines(join(exportDir, "events.jsonl"), ExportedEventRow);
    expect(Math.max(...events.map((event) => event.sequence))).toBe(
      result.manifest.cutoff_sequence,
    );
    expect(result.manifest.ongoing_tasks).toEqual([ackResult(ack).task_id]);
    const report = readFileSync(join(exportDir, "report.html"), "utf8");
    expect(report).toContain("ongoing tasks at cutoff");
    turn.end();
    await client.waitFor("task_finished");
    expect(verifyExportSync(exportDir).ok).toBe(true);
  });

  it("exports the prompt object two conversations share without the other conversation's records", async () => {
    const first = must(client.conversationId, "conversation id");
    const { turn } = await (async () => {
      const next = runtime.nextTurn();
      await client.submitText("first conversation text");
      return { turn: await next };
    })();
    turn.init();
    turn.text("first answer");
    turn.end();
    await client.waitFor("task_finished");
    // Second conversation from the same client shares the prompt snapshot (same bytes -> same object).
    const second = await client.startConversation();
    expect(second).not.toBe(first);
    const next2 = runtime.nextTurn();
    await client.submitText("UNRELATED-SECOND-TEXT");
    const turn2 = await next2;
    turn2.init();
    turn2.text("UNRELATED-SECOND-ANSWER");
    turn2.end();
    await client.waitFor("task_finished", (event) => event.payload.conversation_id === second);
    const catalog = ts.catalog();
    const promptDigest = must(
      catalog.get<{ object_digest: string }>(
        "SELECT a.object_digest FROM artifacts a JOIN provenance_entries p ON p.artifact_id = a.id WHERE p.role = 'agent_prompt' LIMIT 1",
      ),
      "agent prompt artifact",
    ).object_digest;
    const exportDir = join(ts.dir, "export-3");
    const result = exportConversationSync(catalog, first, exportDir);
    catalog.close();
    expect(result.manifest.complete).toBe(true);
    const all =
      readFileSync(join(exportDir, "events.jsonl"), "utf8") +
      readFileSync(join(exportDir, "records/tasks.jsonl"), "utf8") +
      readFileSync(join(exportDir, "report.html"), "utf8");
    expect(all).not.toContain("UNRELATED-SECOND");
    expect(
      existsSync(join(exportDir, "objects/sha256", promptDigest.slice(0, 2), promptDigest)),
    ).toBe(true);
    expect(result.manifest.record_counts.conversations).toBe(1);
  });

  it("detects missing and corrupt objects, labels the export partial, and reconciles orphans", async () => {
    await richConversation();
    const catalog = ts.catalog();
    const store = new ObjectStore(catalog.paths);
    const artifact = must(
      catalog.get<{ object_digest: string }>(
        "SELECT object_digest FROM artifacts WHERE logical_name = 'result.txt'",
      ),
      "result.txt artifact",
    );
    const path = store.pathFor(artifact.object_digest);
    rmSync(path, { force: true });
    // Orphan object: bytes published without a catalog row (simulated crash between publish and commit).
    const orphan = await store.put(Buffer.from("orphan bytes"), {
      signal: new AbortController().signal,
    });
    // Corrupt a provenance object.
    const prov = must(
      catalog.get<{ object_digest: string }>(
        "SELECT a.object_digest FROM artifacts a JOIN provenance_entries p ON p.artifact_id = a.id WHERE p.role = 'configuration'",
      ),
      "configuration provenance artifact",
    );
    const provPath = store.pathFor(prov.object_digest);
    const { chmodSync } = await import("node:fs");
    chmodSync(provPath, 0o600);
    writeFileSync(provPath, "corrupted");
    const reconciled = reconcileObjectsSync(catalog);
    expect(reconciled.orphans).toContain(orphan.digest);
    expect(reconciled.missing).toContain(artifact.object_digest);
    expect(reconciled.corrupt).toContain(prov.object_digest);
    const exportDir = join(ts.dir, "export-4");
    const result = exportConversationSync(
      catalog,
      must(client.conversationId, "conversation id"),
      exportDir,
    );
    catalog.close();
    expect(result.manifest.complete).toBe(false);
    expect(result.manifest.objects.missing).toEqual([artifact.object_digest]);
    expect(result.manifest.objects.corrupt).toEqual([prov.object_digest]);
    expect(result.manifest.partial_reasons.length).toBe(2);
    const verification = verifyExportSync(exportDir);
    expect(verification.ok).toBe(true); // internally consistent
    expect(verification.complete).toBe(false); // but explicitly incomplete
    const report = readFileSync(join(exportDir, "report.html"), "utf8");
    expect(report).toContain("missing");
    expect(report).toContain("corrupt");
  });
});
