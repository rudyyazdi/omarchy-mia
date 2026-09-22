import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { sha256Hex } from "@mia/protocol";
import { z } from "zod";
import { parseJson, type Catalog } from "./catalog.ts";
import { ObjectStore } from "./objects.ts";
import { snapshotConversation, UnresolvedReferenceSchema } from "./queries.ts";
import { renderReport } from "./report.ts";
import { CaptureStatusSchema, EXPORT_TABLES, SCHEMA_VERSION, type ExportTable } from "./schema.ts";

export const EXPORT_VERSION = 1;

const ExportedFileSchema = z.object({ sha256: z.string(), bytes: z.number() });
export type ExportedFile = z.infer<typeof ExportedFileSchema>;

const ManifestVersionsSchema = z.object({
  export_version: z.number(),
  schema_version: z.number(),
});

export const ExportManifestSchema = ManifestVersionsSchema.extend({
  root_conversation_id: z.string(),
  captured_at: z.string(),
  cutoff_sequence: z.number(),
  complete: z.boolean(),
  partial_reasons: z.array(z.string()),
  record_counts: z.record(z.string(), z.number()),
  artifact_count: z.number(),
  coverage: z.record(z.string(), z.number()),
  objects: z.object({
    included: z.number(),
    missing: z.array(z.string()),
    corrupt: z.array(z.string()),
    external_only: z.number(),
    pending: z.number(),
  }),
  unresolved_references: z.array(UnresolvedReferenceSchema),
  ongoing_tasks: z.array(z.string()),
  redaction: z.string(),
  files: z.record(z.string(), ExportedFileSchema),
});

export type ExportManifest = z.infer<typeof ExportManifestSchema>;

/** Where a table's rows live inside an export directory. */
const tableFile = (table: ExportTable): string =>
  table === "events" ? "events.jsonl" : join("records", `${table}.jsonl`);

const toJsonl = (rows: unknown[]): string =>
  rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");

/**
 * Export one conversation into a self-contained directory: records, events, report, referenced objects, manifest.
 * Written to <out>.partial and renamed only after verification passes; a failed export is left labelled partial.
 */
export const exportConversation = (
  catalog: Catalog,
  conversationId: string,
  outDir: string,
): { manifest: ExportManifest; directory: string } => {
  if (existsSync(outDir)) throw new Error(`export target ${outDir} already exists`);
  const staging = `${outDir}.partial`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(staging, "records"), { recursive: true, mode: 0o700 });
  const snapshot = snapshotConversation(catalog, conversationId);
  const store = new ObjectStore(catalog.paths);
  const files: Record<string, ExportedFile> = {};
  const write = (rel: string, bytes: Uint8Array | string) => {
    const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
    const path = join(staging, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, buf, { mode: 0o600 });
    files[rel] = { sha256: sha256Hex(buf), bytes: buf.byteLength };
  };

  const counts: Record<string, number> = {};
  for (const table of EXPORT_TABLES) {
    const rows = snapshot.tables[table];
    counts[table] = rows.length;
    write(tableFile(table), toJsonl(rows));
  }
  write(
    "conversation.json",
    JSON.stringify(
      {
        conversation: snapshot.tables.conversations[0],
        tasks: snapshot.tables.tasks,
        executions: snapshot.tables.executions,
        provenance_sets: snapshot.tables.provenance_sets,
        provenance_entries: snapshot.tables.provenance_entries,
        cutoff_sequence: snapshot.cutoff_sequence,
        captured_at: snapshot.captured_at,
      },
      null,
      2,
    ),
  );

  const missing: string[] = [];
  const corrupt: string[] = [];
  const objectStatus: Record<string, string> = {};
  let included = 0;
  for (const object of snapshot.tables.objects) {
    const digest = object.digest;
    const status = store.verify(digest, object.byte_count);
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
    if (sha256Hex(copied) !== digest) {
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
  for (const event of snapshot.tables.events)
    coverage[event.type] = (coverage[event.type] ?? 0) + 1;
  const partialReasons: string[] = [];
  if (missing.length) partialReasons.push(`${missing.length} referenced object(s) missing`);
  if (corrupt.length) partialReasons.push(`${corrupt.length} referenced object(s) corrupt`);
  if (snapshot.unresolved_references.length)
    partialReasons.push(`${snapshot.unresolved_references.length} unresolved reference(s)`);
  const failedCaptures = artifacts.filter(
    (artifact) => artifact.capture_status === "missing" || artifact.capture_status === "failed",
  ).length;
  if (failedCaptures)
    partialReasons.push(`${failedCaptures} artifact capture(s) missing or failed`);
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
    objects: {
      included,
      missing,
      corrupt,
      external_only: artifacts.filter((artifact) => artifact.capture_status === "external_only")
        .length,
      pending: artifacts.filter((artifact) => artifact.capture_status === "pending").length,
    },
    unresolved_references: snapshot.unresolved_references,
    ongoing_tasks: snapshot.ongoing_tasks,
    redaction:
      "credentials and secret-shaped values were redacted before persistence; conversation content is not redacted",
  };
  const manifest: ExportManifest = { ...manifestWithoutFiles, files };
  writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  const verification = verifyExport(staging);
  if (!verification.ok) {
    writeFileSync(
      join(staging, "VERIFICATION-FAILED.txt"),
      verification.problems.join("\n") + "\n",
    );
    throw new Error(
      `export verification failed; left at ${staging}: ${verification.problems.slice(0, 5).join("; ")}`,
    );
  }
  renameSync(staging, outDir);
  return { manifest, directory: outDir };
};

export interface VerificationResult {
  ok: boolean;
  complete: boolean;
  problems: string[];
  checked_files: number;
  checked_objects: number;
}

/** Every regular file below dir, as absolute paths. */
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const idsOf = (rows: { id: string }[]): Set<string> => new Set(rows.map((row) => row.id));

const failedVerification = (problem: string): VerificationResult => ({
  ok: false,
  complete: false,
  problems: [problem],
  checked_files: 0,
  checked_objects: 0,
});

const invalidManifest = (error: z.ZodError): VerificationResult =>
  failedVerification(`manifest.json invalid: ${z.prettifyError(error).replaceAll("\n", "; ")}`);

const RecordIdSchema = z.object({ id: z.string() });

/** Verify an export offline: file checksums, object digests, referential integrity, report safety. */
export const verifyExport = (dir: string): VerificationResult => {
  const problems: string[] = [];
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return failedVerification("manifest.json missing");
  let manifestJson: unknown;
  try {
    manifestJson = parseJson(readFileSync(manifestPath, "utf8"));
  } catch {
    return failedVerification("manifest.json invalid: unable to read JSON");
  }
  // Other versions may have different manifest and row shapes; inspect only the header first.
  const versions = ManifestVersionsSchema.safeParse(manifestJson);
  if (!versions.success) return invalidManifest(versions.error);
  const { export_version: exportVersion, schema_version: schemaVersion } = versions.data;
  if (exportVersion !== EXPORT_VERSION)
    return failedVerification(
      `export_version ${exportVersion} is not supported (expected ${EXPORT_VERSION})`,
    );
  if (schemaVersion !== SCHEMA_VERSION)
    return failedVerification(
      `schema_version ${schemaVersion} is not supported (expected ${SCHEMA_VERSION})`,
    );
  const parsed = ExportManifestSchema.safeParse(manifestJson);
  if (!parsed.success) return invalidManifest(parsed.error);
  const manifest = parsed.data;
  let checkedFiles = 0;
  for (const [rel, expected] of Object.entries(manifest.files)) {
    const path = join(dir, rel);
    if (!existsSync(path)) {
      problems.push(`file missing: ${rel}`);
      continue;
    }
    const bytes = readFileSync(path);
    if (bytes.byteLength !== expected.bytes || sha256Hex(bytes) !== expected.sha256)
      problems.push(`checksum mismatch: ${rel}`);
    checkedFiles++;
  }
  // Every file present must be listed (except manifest itself).
  for (const file of walk(dir)) {
    const rel = relative(dir, file);
    if (rel !== "manifest.json" && !manifest.files[rel]) problems.push(`unlisted file: ${rel}`);
  }
  // Validate only row identities and fields used below, not the full catalog schemas.
  const readTable = <Row>(table: ExportTable, schema: z.ZodType<Row>): Row[] => {
    const path = join(dir, tableFile(table));
    const rows: Row[] = [];
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
        try {
          const parsedRow = schema.safeParse(parseJson(line));
          if (parsedRow.success) rows.push(parsedRow.data);
          else problems.push(`unparsable record in ${table}`);
        } catch {
          problems.push(`unparsable record in ${table}`);
        }
      }
    }
    return rows;
  };
  const tables = {
    objects: readTable("objects", z.object({ digest: z.string() })),
    provenance_sets: readTable("provenance_sets", RecordIdSchema),
    artifacts: readTable(
      "artifacts",
      RecordIdSchema.extend({
        capture_status: CaptureStatusSchema,
        object_digest: z.string().nullable(),
      }),
    ),
    provenance_entries: readTable(
      "provenance_entries",
      RecordIdSchema.extend({
        artifact_id: z.string().nullable(),
      }),
    ),
    conversations: readTable("conversations", RecordIdSchema),
    clients: readTable("clients", RecordIdSchema),
    client_connections: readTable("client_connections", RecordIdSchema),
    tasks: readTable("tasks", RecordIdSchema),
    executions: readTable("executions", RecordIdSchema),
    events: readTable(
      "events",
      RecordIdSchema.extend({
        sequence: z.number(),
        task_id: z.string().nullable(),
        caused_by_event_id: z.string().nullable(),
      }),
    ),
    commands: readTable("commands", RecordIdSchema),
    tool_calls: readTable("tool_calls", RecordIdSchema.extend({ task_id: z.string() })),
    approvals: readTable("approvals", RecordIdSchema.extend({ tool_call_id: z.string() })),
    diagnostics: readTable("diagnostics", RecordIdSchema),
    artifact_links: readTable("artifact_links", RecordIdSchema.extend({ artifact_id: z.string() })),
    // These two tables use a digest or composite key rather than an id column.
    artifact_dependencies: readTable(
      "artifact_dependencies",
      z.object({
        parent_artifact_id: z.string(),
        required_artifact_id: z.string(),
        relation: z.string(),
      }),
    ),
  };
  for (const table of EXPORT_TABLES) {
    const count = tables[table].length;
    if (manifest.record_counts[table] !== count)
      problems.push(
        `record count mismatch for ${table}: manifest ${manifest.record_counts[table]} vs ${count}`,
      );
  }
  const conversation = tables.conversations[0];
  if (!conversation || conversation.id !== manifest.root_conversation_id)
    problems.push("root conversation row missing or mismatched");
  const taskIds = idsOf(tables.tasks);
  const eventIds = idsOf(tables.events);
  const toolCallIds = idsOf(tables.tool_calls);
  const artifactIds = idsOf(tables.artifacts);
  const objectDigests = new Set(tables.objects.map((object) => object.digest));
  let lastSeq = 0;
  for (const event of tables.events) {
    const seq = event.sequence;
    if (seq <= lastSeq) problems.push(`event sequence not increasing at ${seq}`);
    lastSeq = seq;
    if (seq > manifest.cutoff_sequence) problems.push(`event ${event.id} beyond cutoff`);
    if (event.task_id && !taskIds.has(event.task_id))
      problems.push(`event ${event.id} references unknown task ${event.task_id}`);
    if (event.caused_by_event_id && !eventIds.has(event.caused_by_event_id))
      problems.push(`event ${event.id} caused_by unknown event`);
  }
  for (const call of tables.tool_calls)
    if (!taskIds.has(call.task_id)) problems.push(`tool call ${call.id} references unknown task`);
  for (const approval of tables.approvals)
    if (!toolCallIds.has(approval.tool_call_id))
      problems.push(`approval ${approval.id} references unknown tool call`);
  for (const link of tables.artifact_links)
    if (!artifactIds.has(link.artifact_id))
      problems.push(`link ${link.id} references unknown artifact`);
  for (const entry of tables.provenance_entries)
    if (entry.artifact_id && !artifactIds.has(entry.artifact_id))
      problems.push(`provenance entry ${entry.id} references unknown artifact`);
  let checkedObjects = 0;
  for (const artifact of tables.artifacts) {
    if (artifact.capture_status !== "retained") continue;
    const digest = artifact.object_digest;
    if (!digest) {
      problems.push(`retained artifact ${artifact.id} has no digest`);
      continue;
    }
    if (!objectDigests.has(digest))
      problems.push(`artifact ${artifact.id} digest not in objects table`);
    const path = join(dir, "objects", "sha256", digest.slice(0, 2), digest);
    if (!existsSync(path)) {
      if (!manifest.objects.missing.includes(digest) && !manifest.objects.corrupt.includes(digest))
        problems.push(`object bytes missing and not declared: ${digest}`);
      continue;
    }
    if (sha256Hex(readFileSync(path)) !== digest) problems.push(`object corrupt: ${digest}`);
    checkedObjects++;
  }
  const reportPath = join(dir, "report.html");
  const report = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : null;
  if (!report) problems.push("report.html missing");
  else {
    if (/<script\b/i.test(report)) problems.push("report contains a script tag");
    if (!/Content-Security-Policy/.test(report))
      problems.push("report lacks a Content-Security-Policy");
    if (/\b(src|href)=["']https?:/i.test(report)) problems.push("report references remote content");
  }
  const complete = manifest.complete && problems.length === 0;
  return {
    ok: problems.length === 0,
    complete,
    problems,
    checked_files: checkedFiles,
    checked_objects: checkedObjects,
  };
};

/** Find objects on disk that no catalog row references, and catalog objects whose bytes are missing/corrupt. */
export const reconcileObjects = (
  catalog: Catalog,
): {
  orphans: string[];
  missing: string[];
  corrupt: string[];
} => {
  const store = new ObjectStore(catalog.paths);
  const objects = catalog.all<{ digest: string; byte_count: number }>(
    "SELECT digest, byte_count FROM objects",
  );
  const known = new Set(objects.map((object) => object.digest));
  const orphans: string[] = [];
  const root = catalog.paths.objects;
  if (existsSync(root)) {
    for (const prefix of readdirSync(root))
      for (const digest of readdirSync(join(root, prefix)))
        if (!known.has(digest)) orphans.push(digest);
  }
  const missing: string[] = [];
  const corrupt: string[] = [];
  for (const object of objects) {
    const status = store.verify(object.digest, object.byte_count);
    if (status === "missing") missing.push(object.digest);
    if (status === "corrupt") corrupt.push(object.digest);
  }
  return { orphans, missing, corrupt };
};
