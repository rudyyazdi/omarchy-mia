import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@mia/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Catalog } from "./catalog.ts";
import { exportConversation, verifyExport, type ExportManifest } from "./export.ts";
import { EXPORT_TABLES, SCHEMA_VERSION } from "./schema.ts";
import { RecordWriter } from "./writer.ts";

const createExport = (root: string) => {
  const catalog = new Catalog(join(root, "catalog"));
  try {
    const writer = new RecordWriter(catalog);
    const provenanceSetId = writer.createProvenanceSet("export verification fixture");
    const conversation = writer.createConversation({
      provenanceSetId,
      runtimeConversationId: "runtime-export",
    });
    const taskId = writer.createTask({
      conversationId: conversation.id,
      text: "retain evidence",
      clientId: null,
    });
    const event = writer.appendEvent({
      conversationId: conversation.id,
      taskId,
      type: "task_started",
      payload: {},
    });
    const artifact = writer.registerArtifact({
      kind: "tool_output",
      logicalName: "result.txt",
      bytes: Buffer.from("retained result"),
    });
    const dependency = writer.registerArtifact({
      kind: "tool_output",
      logicalName: "source.txt",
      bytes: Buffer.from("retained source"),
    });
    writer.addDependency(artifact.artifactId, dependency.artifactId, "source");
    writer.linkArtifact({
      conversationId: conversation.id,
      artifactId: artifact.artifactId,
      relation: "event_payload",
      eventId: event.id,
    });
    return exportConversation(catalog, conversation.id, join(root, "export"));
  } finally {
    catalog.close();
  }
};

describe("verifyExport input validation", () => {
  let root: string;
  let directory: string;
  let manifest: ExportManifest;

  const writeManifest = (value: unknown) =>
    writeFileSync(join(directory, "manifest.json"), JSON.stringify(value));
  const replaceRecords = (file: string, contents: string) => {
    writeFileSync(join(directory, file), contents);
    manifest.files[file] = {
      sha256: sha256Hex(Buffer.from(contents)),
      bytes: Buffer.byteLength(contents),
    };
    writeManifest(manifest);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mia-export-validation-"));
    ({ directory, manifest } = createExport(root));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("verifies a valid export including digest and composite-key rows without id columns", () => {
    expect(manifest.record_counts.objects).toBe(2);
    expect(manifest.record_counts.artifact_dependencies).toBe(1);
    expect(verifyExport(directory)).toMatchObject({
      ok: true,
      complete: true,
      problems: [],
      checked_objects: 2,
    });
  });

  it.each([
    {
      export_version: 0,
      schema_version: SCHEMA_VERSION,
      problem: "export_version 0 is not supported (expected 1)",
    },
    {
      export_version: 1,
      schema_version: 0,
      problem: `schema_version 0 is not supported (expected ${SCHEMA_VERSION})`,
    },
  ])(
    "rejects unsupported versions before validating other fields or reading files: $problem",
    ({ problem, ...versions }) => {
      writeManifest(versions);
      writeFileSync(join(directory, "events.jsonl"), "not JSON");
      expect(verifyExport(directory)).toEqual({
        ok: false,
        complete: false,
        problems: [problem],
        checked_files: 0,
        checked_objects: 0,
      });
    },
  );

  it.each(["files", "record_counts", "objects", "export_version"])(
    "reports a manifest missing %s without throwing",
    (field) => {
      writeManifest(
        Object.fromEntries(Object.entries(manifest).filter(([name]) => name !== field)),
      );
      const result = verifyExport(directory);
      expect(result).toMatchObject({
        ok: false,
        complete: false,
        checked_files: 0,
        checked_objects: 0,
      });
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]).toContain("manifest.json invalid:");
    },
  );

  it.each(["{", "null", '"x"', "[]"])("reports invalid manifest JSON %s", (contents) => {
    writeFileSync(join(directory, "manifest.json"), contents);
    const result = verifyExport(directory);
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("manifest.json invalid:");
  });

  it.each(EXPORT_TABLES)("rejects primitive rows in %s even when checksums match", (table) => {
    const file = table === "events" ? "events.jsonl" : `records/${table}.jsonl`;
    replaceRecords(file, '"x"\n');
    const result = verifyExport(directory);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain(`unparsable record in ${table}`);
    expect(result.problems).not.toContain(`checksum mismatch: ${file}`);
  });

  it.each(["{", "null", "[]", "{}", '{"id":12}'])(
    "rejects malformed or missing record identities: %s",
    (line) => {
      replaceRecords("records/tasks.jsonl", `${line}\n`);
      expect(verifyExport(directory).problems).toContain("unparsable record in tasks");
    },
  );

  it.each([
    {
      file: "records/artifacts.jsonl",
      table: "artifacts",
      row: { id: "artifact", capture_status: "retained", object_digest: 12 },
    },
    {
      file: "events.jsonl",
      table: "events",
      row: { id: "event", sequence: "1", task_id: null, caused_by_event_id: null },
    },
    { file: "records/objects.jsonl", table: "objects", row: { id: "object", digest: null } },
    {
      file: "records/artifact_dependencies.jsonl",
      table: "artifact_dependencies",
      row: { id: "dependency" },
    },
  ])("validates verifier fields and actual keys in $table", ({ file, table, row }) => {
    replaceRecords(file, `${JSON.stringify(row)}\n`);
    const result = verifyExport(directory);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain(`unparsable record in ${table}`);
  });

  it("still reports checksum tampering", () => {
    const file = "events.jsonl";
    writeFileSync(join(directory, file), `${readFileSync(join(directory, file), "utf8")}\n`);
    expect(verifyExport(directory).problems).toContain(`checksum mismatch: ${file}`);
  });
});
