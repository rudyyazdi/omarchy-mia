import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha256Hex } from "@mia/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Catalog } from "./catalog.ts";
import { exportConversationSync, verifyExportSync, type ExportManifest } from "./export.ts";
import { EXPORT_TABLES, SCHEMA_VERSION } from "./schema.ts";
import { RecordWriter } from "./writer.ts";

vi.mock("node:fs", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs")>();
  return {
    ...filesystem,
    readFileSync: vi.fn(filesystem.readFileSync),
    readdirSync: vi.fn(filesystem.readdirSync),
    lstatSync: vi.fn(filesystem.lstatSync),
  };
});

const live = () => ({ signal: new AbortController().signal });

const createExport = async (root: string) => {
  const catalog = Catalog.openSync(join(root, "catalog"));
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
      stored: await writer.objects.put(Buffer.from("retained result"), live()),
    });
    const dependency = writer.registerArtifact({
      kind: "tool_output",
      logicalName: "source.txt",
      stored: await writer.objects.put(Buffer.from("retained source"), live()),
    });
    writer.addDependency(artifact.artifactId, dependency.artifactId, "local_changes");
    writer.linkArtifact({
      conversationId: conversation.id,
      artifactId: artifact.artifactId,
      relation: "event_payload",
      eventId: event.id,
    });
    return exportConversationSync(catalog, conversation.id, join(root, "export"));
  } finally {
    catalog.close();
  }
};

describe("verifyExportSync input validation", () => {
  let root: string;
  let directory: string;
  let manifest: ExportManifest;

  const writeManifest = (value: unknown) =>
    writeFileSync(join(directory, "manifest.json"), JSON.stringify(value));
  const omitListedFile = (name: string) => {
    manifest.files = Object.fromEntries(
      Object.entries(manifest.files).filter(([file]) => file !== name),
    );
    writeManifest(manifest);
  };
  const replaceRecords = (file: string, contents: string) => {
    writeFileSync(join(directory, file), contents);
    manifest.files[file] = {
      sha256: sha256Hex(Buffer.from(contents)),
      bytes: Buffer.byteLength(contents),
    };
    writeManifest(manifest);
  };

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "mia-export-validation-")));
    ({ directory, manifest } = await createExport(root));
  });
  afterEach(() => {
    vi.mocked(readFileSync).mockReset();
    vi.mocked(readdirSync).mockReset();
    vi.mocked(lstatSync).mockReset();
    rmSync(root, { recursive: true, force: true });
  });

  const verifyWithObservedReads = () => {
    vi.mocked(readFileSync).mockClear();
    vi.mocked(readdirSync).mockClear();
    const result = verifyExportSync(directory);
    return {
      result,
      reads: vi.mocked(readFileSync).mock.calls.map(([path]) => path),
      traversals: vi.mocked(readdirSync).mock.calls.map(([path]) => path),
    };
  };

  it("verifies a valid export including digest and composite-key rows without id columns", () => {
    expect(manifest.record_counts.objects).toBe(2);
    expect(manifest.record_counts.artifact_dependencies).toBe(1);
    expect(verifyExportSync(directory)).toMatchObject({
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
      expect(verifyExportSync(directory)).toEqual({
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
      const result = verifyExportSync(directory);
      expect(result).toMatchObject({
        ok: false,
        complete: false,
        checked_files: 0,
        checked_objects: 0,
      });
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]).toContain("manifest.json invalid:");
      expect(result.problems[0]).not.toContain("\n");
    },
  );

  it.each(["{", "null", '"x"', "[]"])("reports invalid manifest JSON %s", (contents) => {
    writeFileSync(join(directory, "manifest.json"), contents);
    const result = verifyExportSync(directory);
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("manifest.json invalid:");
  });

  it.each(EXPORT_TABLES)("rejects primitive rows in %s even when checksums match", (table) => {
    const file = table === "events" ? "events.jsonl" : `records/${table}.jsonl`;
    replaceRecords(file, '"x"\n');
    const result = verifyExportSync(directory);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain(`unparsable record in ${table}`);
    expect(result.problems).not.toContain(`checksum mismatch: ${file}`);
  });

  it.each(["{", "null", "[]", "{}", '{"id":12}'])(
    "rejects malformed or missing record identities: %s",
    (line) => {
      replaceRecords("records/tasks.jsonl", `${line}\n`);
      expect(verifyExportSync(directory).problems).toContain("unparsable record in tasks");
    },
  );

  it("rejects unknown capture status instead of skipping retained-object verification", () => {
    replaceRecords(
      "records/artifacts.jsonl",
      `${JSON.stringify({ id: "artifact", capture_status: "retaind", object_digest: null })}\n`,
    );
    const result = verifyExportSync(directory);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain("unparsable record in artifacts");
  });

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
    const result = verifyExportSync(directory);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain(`unparsable record in ${table}`);
  });

  it("still reports checksum tampering", () => {
    const file = "events.jsonl";
    writeFileSync(join(directory, file), `${readFileSync(join(directory, file), "utf8")}\n`);
    expect(verifyExportSync(directory).problems).toContain(`checksum mismatch: ${file}`);
  });

  it.each(["stray.txt", "constructor", "toString", "hasOwnProperty", "__proto__"])(
    "reports an unlisted file named %s",
    (name) => {
      writeFileSync(join(directory, name), "stray");
      expect(verifyExportSync(directory)).toMatchObject({
        ok: false,
        problems: [`unlisted file: ${name}`],
      });
    },
  );

  it.each([false, true])(
    "rejects a manifest listing the reserved name __proto__ (file present: %s)",
    (present) => {
      const files = { ...manifest.files };
      // JSON.parse keeps an own `__proto__` key, which an assignment would not create.
      Object.defineProperty(files, "__proto__", {
        value: { sha256: sha256Hex(Buffer.from("expected")), bytes: 8 },
        enumerable: true,
      });
      writeManifest({ ...manifest, files });
      if (present) writeFileSync(join(directory, "__proto__"), "wrong checksum");
      expect(verifyExportSync(directory)).toEqual({
        ok: false,
        complete: false,
        problems: ["manifest.json invalid: reserved file name __proto__"],
        checked_files: 0,
        checked_objects: 0,
      });
    },
  );

  it.each(["../secret", "nested/../../secret", "/absolute/secret", "C:\\secret"])(
    "rejects manifest filename %s before reading it",
    (name) => {
      writeFileSync(join(root, "secret"), "secret");
      manifest.files[name] = { sha256: sha256Hex(Buffer.from("secret")), bytes: 6 };
      writeManifest(manifest);
      const { result, reads } = verifyWithObservedReads();
      expect(result.ok).toBe(false);
      expect(result.problems).toContain(`invalid file path: ${name}`);
      expect(reads).not.toContain(join(directory, name));
      expect(
        reads.every((path) => typeof path === "string" && path.startsWith(`${directory}/`)),
      ).toBe(true);
    },
  );

  it.each(["manifest.json", "events.jsonl", "report.html", "records/tasks.jsonl"])(
    "does not read a symlink at %s, including paths omitted from manifest.files",
    (name) => {
      const outside = join(root, "outside");
      renameSync(join(directory, name), outside);
      symlinkSync(outside, join(directory, name));
      if (name !== "manifest.json") {
        omitListedFile(name);
      }
      const { result, reads } = verifyWithObservedReads();
      expect(result.ok).toBe(false);
      expect(result.problems).toContain(`symlink not allowed: ${name}`);
      if (name === "report.html") expect(result.problems).not.toContain("report.html missing");
      expect(reads).not.toContain(join(directory, name));
      expect(reads).not.toContain(outside);
    },
  );

  it.each(["records", "objects"])("does not enter symlinked %s directories", (name) => {
    const outside = join(root, name);
    renameSync(join(directory, name), outside);
    symlinkSync(outside, join(directory, name));
    const { result, reads, traversals } = verifyWithObservedReads();
    expect(result.ok).toBe(false);
    expect(result.problems).toContain(`symlink not allowed: ${name}`);
    expect(reads.some((path) => String(path).startsWith(`${directory}/${name}/`))).toBe(false);
    expect(traversals).not.toContain(join(directory, name));
    expect(traversals).not.toContain(outside);
  });

  it("rejects a retained object symlink even when omitted from manifest.files", () => {
    const name = Object.keys(manifest.files).find((file) => file.startsWith("objects/"));
    if (!name) throw new Error("fixture must contain a retained object");
    const outside = join(root, "outside-object");
    renameSync(join(directory, name), outside);
    symlinkSync(outside, join(directory, name));
    omitListedFile(name);
    const { result, reads } = verifyWithObservedReads();
    expect(result.problems).toContain(`symlink not allowed: ${name}`);
    expect(reads).not.toContain(join(directory, name));
    expect(reads).not.toContain(outside);
  });

  it("never follows unlisted directory symlinks, including loops", () => {
    symlinkSync(directory, join(directory, "loop"));
    symlinkSync(root, join(directory, "outside"));
    const { result, traversals } = verifyWithObservedReads();
    expect(result.ok).toBe(false);
    expect(result.problems).toContain("symlink not allowed: loop");
    expect(result.problems).toContain("symlink not allowed: outside");
    expect(traversals).not.toContain(join(directory, "loop"));
    expect(traversals).not.toContain(join(directory, "outside"));
    expect(traversals).not.toContain(root);
  });

  it("rejects traversal in retained object digests before normalizing the path", () => {
    const digest = "../../secret";
    writeFileSync(join(root, "secret"), "secret");
    replaceRecords(
      "records/artifacts.jsonl",
      `${JSON.stringify({ id: "artifact", capture_status: "retained", object_digest: digest })}\n`,
    );
    const { result, reads } = verifyWithObservedReads();
    expect(result.ok).toBe(false);
    expect(result.problems).toContain(`invalid file path: objects/sha256/../${digest}`);
    expect(reads).not.toContain(join(root, "secret"));
  });

  it.each(["manifest.json", "events.jsonl", "report.html"])(
    "reports a directory replacing %s without reading it",
    (name) => {
      rmSync(join(directory, name));
      mkdirSync(join(directory, name));
      const { result, reads } = verifyWithObservedReads();
      expect(result.ok).toBe(false);
      expect(result.problems).toContain(`not a regular file: ${name}`);
      expect(reads).not.toContain(join(directory, name));
    },
  );

  it("reports a non-directory parent without attempting a descendant read", () => {
    rmSync(join(directory, "records"), { recursive: true });
    writeFileSync(join(directory, "records"), "not a directory");
    const { result, reads } = verifyWithObservedReads();
    expect(result.ok).toBe(false);
    expect(result.problems).toContain("not a directory: records");
    expect(reads).not.toContain(join(directory, "records/tasks.jsonl"));
  });

  it("rejects a FIFO before reading it and reports nonregular inventory entries", () => {
    const name = "events.jsonl";
    rmSync(join(directory, name));
    execFileSync("mkfifo", [join(directory, name)]);
    const { result, reads } = verifyWithObservedReads();
    expect(result.ok).toBe(false);
    expect(result.problems.filter((problem) => problem === `not a regular file: ${name}`)).toEqual([
      `not a regular file: ${name}`,
    ]);
    expect(reads).not.toContain(join(directory, name));
  });

  it("reports missing files", () => {
    rmSync(join(directory, "events.jsonl"));
    expect(verifyExportSync(directory).problems).toContain("file missing: events.jsonl");
  });

  it("returns filesystem failures through problems", () => {
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("read denied");
    });
    expect(verifyExportSync(directory).problems).toContain("file unreadable: manifest.json");
    vi.mocked(lstatSync).mockImplementationOnce(() => {
      throw new Error("stat denied");
    });
    expect(verifyExportSync(directory).problems).toContain("export directory unreadable");
    vi.mocked(readdirSync).mockImplementationOnce(() => {
      throw new Error("inventory denied");
    });
    expect(verifyExportSync(directory).problems).toContain("directory unreadable: .");
  });

  it("verifies listed regular files in nested directories", () => {
    const name = "extra/nested/evidence.txt";
    mkdirSync(dirname(join(directory, name)), { recursive: true });
    replaceRecords(name, "evidence");
    expect(verifyExportSync(directory).ok).toBe(true);
  });

  it("checks unsupported versions before reading or traversing other entries", () => {
    writeManifest({ export_version: 0, schema_version: SCHEMA_VERSION });
    symlinkSync(root, join(directory, "outside"));
    const { result, reads, traversals } = verifyWithObservedReads();
    expect(result.problems).toEqual(["export_version 0 is not supported (expected 1)"]);
    expect(reads).toEqual([join(directory, "manifest.json")]);
    expect(traversals).toEqual([]);
  });
});
