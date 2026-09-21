import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Catalog,
  ObjectStore,
  RecordWriter,
  exportConversation,
  reconcileObjects,
  snapshotConversation,
  verifyExport,
} from "@mia/records";
import type { MiaClient } from "@mia/text-client";
import { ScriptedRuntime } from "./scripted-runtime.ts";
import { startTestServer, tick, type TestServer } from "./harness.ts";

let runtime: ScriptedRuntime;
let ts: TestServer;
let client: MiaClient;

beforeEach(async () => {
  runtime = new ScriptedRuntime();
  ts = await startTestServer(runtime);
  client = await ts.connect("client-A");
  await client.sendDiagnostics();
  await client.startConversation();
});
afterEach(async () => {
  await ts.close();
});

/** Build a conversation containing every evidence type the D1 verification list asks for. */
async function richConversation(): Promise<{ conversationId: string; artifactFile: string }> {
  const outDir = ts.profile.runtime.outputDirectories[0]!;
  mkdirSync(outDir, { recursive: true });
  const artifactFile = join(outDir, "result.txt");
  writeFileSync(artifactFile, "D1");
  // task 1: stream + approve + reject + artifact
  let next = runtime.nextTurn();
  let ack = await client.submitText("do things");
  const taskId = ack.result!.task_id as string;
  const turn = await next;
  turn.init("scripted-model");
  turn.text(
    "Working <script>alert(1)</script> on it. secret sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 leaked?",
  );
  const p1 = turn.request(
    "mcp__d1__change",
    { delta: 1, token: "super-secret-value-123456" },
    "toolu_1",
  );
  const r1 = await client.waitFor(
    "approval_requested",
    (e) => e.payload.runtime_call_id === "toolu_1",
  );
  await client.decide(taskId, r1.payload.approval_id, "approve");
  await p1;
  turn.toolResult("toolu_1", JSON.stringify({ counter: 1 }));
  const p2 = turn.request("mcp__d1__change", { delta: 1 }, "toolu_2");
  const r2 = await client.waitFor(
    "approval_requested",
    (e) => e.payload.runtime_call_id === "toolu_2",
  );
  await client.decide(taskId, r2.payload.approval_id, "reject");
  await p2;
  turn.toolResult("toolu_2", "denied", true);
  const p3 = turn.request("mcp__d1__artifact", { name: "result.txt", text: "D1" }, "toolu_3");
  const r3 = await client.waitFor(
    "approval_requested",
    (e) => e.payload.runtime_call_id === "toolu_3",
  );
  await client.decide(taskId, r3.payload.approval_id, "approve");
  await p3;
  turn.toolResult(
    "toolu_3",
    JSON.stringify({
      artifact: { path: artifactFile, name: "result.txt", mime_type: "text/plain" },
    }),
  );
  await turn.request("mcp__d1__mystery", {}, "toolu_4"); // produces an error event
  turn.end();
  await client.waitFor("task_finished", (e) => e.payload.task_id === taskId);
  await client.sendDiagnostics();
  // task 2: interruption with an in-flight action
  next = runtime.nextTurn();
  ack = await client.submitText("slow");
  const task2 = ack.result!.task_id as string;
  const turn2 = await next;
  turn2.init();
  const slow = turn2.request("mcp__d1__slow", { mode: "uncancellable" }, "toolu_5");
  const r5 = await client.waitFor(
    "approval_requested",
    (e) => e.payload.runtime_call_id === "toolu_5",
  );
  await client.decide(task2, r5.payload.approval_id, "approve");
  await slow;
  await client.interrupt(task2);
  await client.waitFor("task_finished", (e) => e.payload.task_id === task2);
  return { conversationId: client.conversationId!, artifactFile };
}

describe("records, report and export", () => {
  it("produces one report covering streamed output, approvals, interruption, errors, diagnostics, a generated file and provenance; exports and verifies offline; survives source edits", async () => {
    const { conversationId, artifactFile } = await richConversation();
    const exportDir = join(ts.dir, "export-1");
    const catalog = ts.catalog();
    const snapshot = snapshotConversation(catalog, conversationId);
    expect(snapshot.tables.tasks).toHaveLength(2);
    expect(snapshot.tables.events.some((e) => e.type === "text_delta")).toBe(true);
    expect(snapshot.tables.approvals.map((a) => a.status).sort()).toEqual([
      "approved",
      "approved",
      "approved",
      "rejected",
    ]);
    expect(snapshot.tables.events.some((e) => e.type === "interruption_outcome")).toBe(true);
    expect(snapshot.tables.events.some((e) => e.type === "error")).toBe(true);
    expect(snapshot.tables.diagnostics.length).toBeGreaterThan(0);
    expect(
      snapshot.tables.artifacts.some(
        (a) => a.kind === "tool_output" && a.capture_status === "retained",
      ),
    ).toBe(true);
    expect(
      snapshot.tables.provenance_entries.some(
        (p) => p.role === "agent_prompt" && p.availability === "retained",
      ),
    ).toBe(true);
    expect(
      snapshot.tables.provenance_entries.some(
        (p) => p.role === "runtime_instructions" && p.availability === "unavailable",
      ),
    ).toBe(true);
    // Seeded credentials never reach the records.
    const dump = JSON.stringify(snapshot.tables);
    expect(dump).not.toContain("sk-ant-api03");
    expect(dump).not.toContain("super-secret-value-123456");
    const result = exportConversation(catalog, conversationId, exportDir);
    catalog.close();
    expect(result.manifest.complete).toBe(true);
    const verification = verifyExport(exportDir);
    expect(verification.problems).toEqual([]);
    const report = readFileSync(join(exportDir, "report.html"), "utf8");
    expect(report).not.toContain("<script>alert(1)</script>");
    expect(report).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(report).toContain("Content-Security-Policy");
    expect(report).toContain("partial output");
    expect(report).not.toContain("sk-ant-api03");
    // Edit the original generated file and the prompt after export: retained bytes still verify.
    writeFileSync(artifactFile, "changed later");
    writeFileSync(ts.profile.runtime.agentPromptFile, "edited prompt");
    expect(verifyExport(exportDir).ok).toBe(true);
    const artifacts = readFileSync(join(exportDir, "records/artifacts.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { logical_name: string; object_digest: string });
    const retained = artifacts.find((a) => a.logical_name === "result.txt")!;
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
    turn.text("a");
    await tick();
    const catalog = ts.catalog();
    const before = snapshotConversation(catalog, client.conversationId!).cutoff_sequence;
    // Write more events while exporting: the export must stop at its own cutoff.
    turn.text("b");
    turn.text("c");
    await tick();
    const exportDir = join(ts.dir, "export-2");
    const result = exportConversation(catalog, client.conversationId!, exportDir);
    catalog.close();
    expect(result.manifest.cutoff_sequence).toBeGreaterThanOrEqual(before);
    const events = readFileSync(join(exportDir, "events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { sequence: number });
    expect(Math.max(...events.map((e) => e.sequence))).toBe(result.manifest.cutoff_sequence);
    expect(result.manifest.ongoing_tasks).toEqual([ack.result!.task_id]);
    const report = readFileSync(join(exportDir, "report.html"), "utf8");
    expect(report).toContain("ongoing tasks at cutoff");
    turn.end();
    await client.waitFor("task_finished");
    expect(verifyExport(exportDir).ok).toBe(true);
  });

  it("shares prompt bytes between conversations without exporting the other conversation's records", async () => {
    const first = client.conversationId!;
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
    await client.waitFor("task_finished", (e) => e.payload.conversation_id === second);
    const catalog = ts.catalog();
    const promptDigest = catalog.get<{ object_digest: string }>(
      "SELECT a.object_digest FROM artifacts a JOIN provenance_entries p ON p.artifact_id = a.id WHERE p.role = 'agent_prompt' LIMIT 1",
    )!.object_digest;
    const promptArtifacts = catalog.all(
      "SELECT a.id FROM artifacts a JOIN provenance_entries p ON p.artifact_id = a.id WHERE p.role = 'agent_prompt'",
    );
    expect(promptArtifacts).toHaveLength(2); // two logical records
    expect(catalog.all("SELECT digest FROM objects WHERE digest = ?", promptDigest)).toHaveLength(
      1,
    ); // one object
    const exportDir = join(ts.dir, "export-3");
    const result = exportConversation(catalog, first, exportDir);
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
    const artifact = catalog.get<{ object_digest: string }>(
      "SELECT object_digest FROM artifacts WHERE logical_name = 'result.txt'",
    )!;
    const path = store.pathFor(artifact.object_digest);
    rmSync(path, { force: true });
    // Orphan object: bytes published without a catalog row (simulated crash between publish and commit).
    const orphan = store.put(Buffer.from("orphan bytes"));
    // Corrupt a provenance object.
    const prov = catalog.get<{ object_digest: string }>(
      "SELECT a.object_digest FROM artifacts a JOIN provenance_entries p ON p.artifact_id = a.id WHERE p.role = 'configuration'",
    )!;
    const provPath = store.pathFor(prov.object_digest);
    const { chmodSync } = await import("node:fs");
    chmodSync(provPath, 0o600);
    writeFileSync(provPath, "corrupted");
    const reconciled = reconcileObjects(catalog);
    expect(reconciled.orphans).toContain(orphan.digest);
    expect(reconciled.missing).toContain(artifact.object_digest);
    expect(reconciled.corrupt).toContain(prov.object_digest);
    const exportDir = join(ts.dir, "export-4");
    const result = exportConversation(catalog, client.conversationId!, exportDir);
    catalog.close();
    expect(result.manifest.complete).toBe(false);
    expect(result.manifest.objects.missing).toEqual([artifact.object_digest]);
    expect(result.manifest.objects.corrupt).toEqual([prov.object_digest]);
    expect(result.manifest.partial_reasons.length).toBe(2);
    const verification = verifyExport(exportDir);
    expect(verification.ok).toBe(true); // internally consistent
    expect(verification.complete).toBe(false); // but explicitly incomplete
    const report = readFileSync(join(exportDir, "report.html"), "utf8");
    expect(report).toContain("missing");
    expect(report).toContain("corrupt");
  });

  it("verify fails when an exported file is tampered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mia-export-"));
    const catalog = new Catalog(join(dir, "state"));
    const writer = new RecordWriter(catalog);
    const prov = writer.createProvenanceSet("t");
    const conv = writer.createConversation({ provenanceSetId: prov, runtimeConversationId: "rt" });
    writer.appendEvent({ conversationId: conv.id, type: "x", payload: { a: 1 } });
    const exportDir = join(dir, "out");
    exportConversation(catalog, conv.id, exportDir);
    catalog.close();
    writeFileSync(join(exportDir, "events.jsonl"), "tampered\n");
    const v = verifyExport(exportDir);
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.includes("checksum mismatch: events.jsonl"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
