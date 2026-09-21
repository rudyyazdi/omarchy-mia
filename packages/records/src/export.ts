import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Catalog } from "./catalog.ts";
import { ObjectStore } from "./objects.ts";
import { snapshotConversation, type ConversationSnapshot } from "./queries.ts";
import { renderReport } from "./report.ts";
import { EXPORT_TABLES, SCHEMA_VERSION } from "./schema.ts";

export const EXPORT_VERSION = 1;

export interface ExportManifest {
  export_version: number;
  schema_version: number;
  root_conversation_id: string;
  captured_at: string;
  cutoff_sequence: number;
  complete: boolean;
  partial_reasons: string[];
  record_counts: Record<string, number>;
  artifact_count: number;
  coverage: Record<string, number>;
  objects: { included: number; missing: string[]; corrupt: string[]; external_only: number; pending: number };
  unresolved_references: ConversationSnapshot["unresolved_references"];
  ongoing_tasks: string[];
  redaction: string;
  files: Record<string, { sha256: string; bytes: number }>;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Export one conversation into a self-contained directory: records, events, report, referenced objects, manifest.
 * Written to <out>.partial and renamed only after verification passes; a failed export is left labelled partial.
 */
export function exportConversation(catalog: Catalog, conversationId: string, outDir: string): { manifest: ExportManifest; directory: string } {
  if (existsSync(outDir)) throw new Error(`export target ${outDir} already exists`);
  const staging = `${outDir}.partial`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(staging, "records"), { recursive: true, mode: 0o700 });
  const snapshot = snapshotConversation(catalog, conversationId);
  const store = new ObjectStore(catalog.paths);
  const files: Record<string, { sha256: string; bytes: number }> = {};
  const write = (rel: string, bytes: Uint8Array | string) => {
    const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
    const path = join(staging, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, buf, { mode: 0o600 });
    files[rel] = { sha256: sha256(buf), bytes: buf.byteLength };
  };

  const counts: Record<string, number> = {};
  for (const table of EXPORT_TABLES) {
    const rows = snapshot.tables[table];
    counts[table] = rows.length;
    if (table === "events") write("events.jsonl", rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
    else write(`records/${table}.jsonl`, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  }
  write("conversation.json", JSON.stringify({ conversation: snapshot.tables.conversations[0], tasks: snapshot.tables.tasks, executions: snapshot.tables.executions, provenance_sets: snapshot.tables.provenance_sets, provenance_entries: snapshot.tables.provenance_entries, cutoff_sequence: snapshot.cutoff_sequence, captured_at: snapshot.captured_at }, null, 2));

  const missing: string[] = [];
  const corrupt: string[] = [];
  const objectStatus: Record<string, string> = {};
  let included = 0;
  for (const obj of snapshot.tables.objects) {
    const digest = obj.digest as string;
    const status = store.verify(digest, obj.byte_count as number);
    objectStatus[digest] = status;
    if (status === "missing") {
      missing.push(digest);
      continue;
    }
    if (status === "corrupt") {
      corrupt.push(digest);
      continue;
    }
    const rel = join("objects", "sha256", digest.slice(0, 2), digest);
    const target = join(staging, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(store.pathFor(digest), target);
    const copied = readFileSync(target);
    if (sha256(copied) !== digest) {
      corrupt.push(digest);
      objectStatus[digest] = "corrupt";
      continue;
    }
    files[rel] = { sha256: digest, bytes: copied.byteLength };
    included++;
  }
  write("report.html", renderReport(snapshot, { objectStatus }));

  const artifacts = snapshot.tables.artifacts;
  const coverage: Record<string, number> = {};
  for (const type of new Set(snapshot.tables.events.map((e) => e.type as string))) coverage[type] = snapshot.tables.events.filter((e) => e.type === type).length;
  const partialReasons: string[] = [];
  if (missing.length) partialReasons.push(`${missing.length} referenced object(s) missing`);
  if (corrupt.length) partialReasons.push(`${corrupt.length} referenced object(s) corrupt`);
  if (snapshot.unresolved_references.length) partialReasons.push(`${snapshot.unresolved_references.length} unresolved reference(s)`);
  const failedCaptures = artifacts.filter((a) => a.capture_status === "missing" || a.capture_status === "failed").length;
  if (failedCaptures) partialReasons.push(`${failedCaptures} artifact capture(s) missing or failed`);
  const manifestWithoutFiles: Omit<ExportManifest, "files"> = {
    export_version: EXPORT_VERSION,
    schema_version: SCHEMA_VERSION,
    root_conversation_id: conversationId,
    captured_at: snapshot.captured_at,
    cutoff_sequence: snapshot.cutoff_sequence,
    complete: partialReasons.length === 0,
    partial_reasons: partialReasons,
    record_counts: counts,
    artifact_count: artifacts.length,
    coverage,
    objects: { included, missing, corrupt, external_only: artifacts.filter((a) => a.capture_status === "external_only").length, pending: artifacts.filter((a) => a.capture_status === "pending").length },
    unresolved_references: snapshot.unresolved_references,
    ongoing_tasks: snapshot.ongoing_tasks,
    redaction: "credentials and secret-shaped values were redacted before persistence; conversation content is not redacted",
  };
  const manifest: ExportManifest = { ...manifestWithoutFiles, files };
  writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  const verification = verifyExport(staging);
  if (!verification.ok) {
    writeFileSync(join(staging, "VERIFICATION-FAILED.txt"), verification.problems.join("\n") + "\n");
    throw new Error(`export verification failed; left at ${staging}: ${verification.problems.slice(0, 5).join("; ")}`);
  }
  renameSync(staging, outDir);
  return { manifest, directory: outDir };
}

export interface VerificationResult {
  ok: boolean;
  complete: boolean;
  problems: string[];
  checked_files: number;
  checked_objects: number;
}

/** Verify an export offline: file checksums, object digests, referential integrity, report safety. */
export function verifyExport(dir: string): VerificationResult {
  const problems: string[] = [];
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return { ok: false, complete: false, problems: ["manifest.json missing"], checked_files: 0, checked_objects: 0 };
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ExportManifest;
  let checkedFiles = 0;
  for (const [rel, expected] of Object.entries(manifest.files)) {
    const path = join(dir, rel);
    if (!existsSync(path)) {
      problems.push(`file missing: ${rel}`);
      continue;
    }
    const bytes = readFileSync(path);
    if (bytes.byteLength !== expected.bytes || sha256(bytes) !== expected.sha256) problems.push(`checksum mismatch: ${rel}`);
    checkedFiles++;
  }
  // Every file present must be listed (except manifest itself).
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  for (const f of walk(dir)) {
    const rel = relative(dir, f);
    if (rel !== "manifest.json" && !manifest.files[rel]) problems.push(`unlisted file: ${rel}`);
  }
  const readTable = (name: string): Record<string, unknown>[] => {
    const path = name === "events" ? join(dir, "events.jsonl") : join(dir, "records", `${name}.jsonl`);
    if (!existsSync(path)) return [];
    const rows: Record<string, unknown>[] = [];
    for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
      try {
        rows.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        problems.push(`unparsable record in ${name}`);
      }
    }
    return rows;
  };
  const t = Object.fromEntries(EXPORT_TABLES.map((n) => [n, readTable(n)]));
  for (const [name, rows] of Object.entries(t)) if (manifest.record_counts[name] !== rows.length) problems.push(`record count mismatch for ${name}: manifest ${manifest.record_counts[name]} vs ${rows.length}`);
  const ids = (name: string) => new Set(t[name]!.map((r) => r.id as string));
  const conv = t.conversations![0];
  if (!conv || conv.id !== manifest.root_conversation_id) problems.push("root conversation row missing or mismatched");
  const taskIds = ids("tasks");
  const eventIds = ids("events");
  const toolCallIds = ids("tool_calls");
  const artifactIds = ids("artifacts");
  const objectDigests = new Set(t.objects!.map((o) => o.digest as string));
  let lastSeq = 0;
  for (const e of t.events!) {
    const seq = e.sequence as number;
    if (seq <= lastSeq) problems.push(`event sequence not increasing at ${seq}`);
    lastSeq = seq;
    if (seq > manifest.cutoff_sequence) problems.push(`event ${e.id} beyond cutoff`);
    if (e.task_id && !taskIds.has(e.task_id as string)) problems.push(`event ${e.id} references unknown task ${e.task_id}`);
    if (e.caused_by_event_id && !eventIds.has(e.caused_by_event_id as string)) problems.push(`event ${e.id} caused_by unknown event`);
  }
  for (const c of t.tool_calls!) if (!taskIds.has(c.task_id as string)) problems.push(`tool call ${c.id} references unknown task`);
  for (const a of t.approvals!) if (!toolCallIds.has(a.tool_call_id as string)) problems.push(`approval ${a.id} references unknown tool call`);
  for (const l of t.artifact_links!) if (!artifactIds.has(l.artifact_id as string)) problems.push(`link ${l.id} references unknown artifact`);
  for (const p of t.provenance_entries!) if (p.artifact_id && !artifactIds.has(p.artifact_id as string)) problems.push(`provenance entry ${p.id} references unknown artifact`);
  let checkedObjects = 0;
  for (const a of t.artifacts!) {
    if (a.capture_status !== "retained") continue;
    const digest = a.object_digest as string | null;
    if (!digest) {
      problems.push(`retained artifact ${a.id} has no digest`);
      continue;
    }
    if (!objectDigests.has(digest)) problems.push(`artifact ${a.id} digest not in objects table`);
    const path = join(dir, "objects", "sha256", digest.slice(0, 2), digest);
    if (!existsSync(path)) {
      if (!manifest.objects.missing.includes(digest) && !manifest.objects.corrupt.includes(digest)) problems.push(`object bytes missing and not declared: ${digest}`);
      continue;
    }
    if (sha256(readFileSync(path)) !== digest) problems.push(`object corrupt: ${digest}`);
    checkedObjects++;
  }
  const report = existsSync(join(dir, "report.html")) ? readFileSync(join(dir, "report.html"), "utf8") : null;
  if (!report) problems.push("report.html missing");
  else {
    if (/<script\b/i.test(report)) problems.push("report contains a script tag");
    if (!/Content-Security-Policy/.test(report)) problems.push("report lacks a Content-Security-Policy");
    if (/\b(src|href)=["']https?:/i.test(report)) problems.push("report references remote content");
  }
  const complete = manifest.complete && problems.length === 0;
  return { ok: problems.length === 0, complete, problems, checked_files: checkedFiles, checked_objects: checkedObjects };
}

/** Find objects on disk that no catalog row references, and catalog objects whose bytes are missing/corrupt. */
export function reconcileObjects(catalog: Catalog): { orphans: string[]; missing: string[]; corrupt: string[] } {
  const store = new ObjectStore(catalog.paths);
  const known = new Set(catalog.all<{ digest: string; byte_count: number }>("SELECT digest, byte_count FROM objects").map((o) => o.digest));
  const orphans: string[] = [];
  const root = catalog.paths.objects;
  if (existsSync(root)) {
    for (const prefix of readdirSync(root)) for (const digest of readdirSync(join(root, prefix))) if (!known.has(digest)) orphans.push(digest);
  }
  const missing: string[] = [];
  const corrupt: string[] = [];
  for (const o of catalog.all<{ digest: string; byte_count: number }>("SELECT digest, byte_count FROM objects")) {
    const s = store.verify(o.digest, o.byte_count);
    if (s === "missing") missing.push(o.digest);
    if (s === "corrupt") corrupt.push(o.digest);
  }
  return { orphans, missing, corrupt };
}
