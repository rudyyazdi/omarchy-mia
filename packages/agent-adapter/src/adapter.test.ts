import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempDisposableSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { hookEvidenceFrom, probeStaticCapabilities, readRuntimeFile } from "./adapter.ts";

describe("readRuntimeFile", () => {
  it("reports a FIFO as not a regular file without waiting for a writer, however many are read", async () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-runtime-file-"));
    // A blocking open of a FIFO waits for a writer, holding a libuv worker thread; there are 4 of them.
    const fifo = join(directory.path, "hook-evidence.jsonl");
    execFileSync("mkfifo", [fifo]);
    const reads = await Promise.all(Array.from({ length: 5 }, () => readRuntimeFile(fifo)));
    expect(reads).toEqual(
      Array.from({ length: 5 }, () => ({ status: "unreadable", reason: "not a regular file" })),
    );
    const file = join(directory.path, "transcript.jsonl");
    writeFileSync(file, "{}\n");
    expect(await readRuntimeFile(file)).toEqual({ status: "read", bytes: Buffer.from("{}\n") });
  });

  it("reports why a read was abandoned before it started", async () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-runtime-file-"));
    const path = join(directory.path, "transcript.jsonl");
    writeFileSync(path, "{}\n");
    const signal = AbortSignal.abort(new Error("abandoned at shutdown"));
    expect(await readRuntimeFile(path, { signal })).toEqual({
      status: "unreadable",
      reason: "abandoned at shutdown",
    });
  });

  it("reports a read abandoned at its deadline as timed out", async () => {
    const signal = AbortSignal.abort(new DOMException("deadline", "TimeoutError"));
    expect(await readRuntimeFile("/nonexistent", { signal })).toEqual({
      status: "unreadable",
      reason: "timed out",
    });
  });
});

describe("hookEvidenceFrom", () => {
  it("returns no evidence when the hook never wrote a file", async () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-hooks-"));
    expect(hookEvidenceFrom(await readRuntimeFile(join(directory.path, "absent.jsonl")))).toEqual({
      records: [],
      malformedLines: 0,
      readError: null,
    });
  });

  it("keeps every object line and counts the lines that are not one", async () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-hooks-"));
    const path = join(directory.path, "hook-evidence.jsonl");
    writeFileSync(path, '{"effort":"low"}\n42\n\n{"effort":"high"}\n{"effort":"me');
    expect(hookEvidenceFrom(await readRuntimeFile(path))).toEqual({
      records: [{ effort: "low" }, { effort: "high" }],
      malformedLines: 2,
      readError: null,
    });
  });

  it("reports a file it cannot read instead of throwing", async () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-hooks-"));
    const path = join(directory.path, "hook-evidence.jsonl");
    mkdirSync(path);
    expect(hookEvidenceFrom(await readRuntimeFile(path))).toEqual({
      records: [],
      malformedLines: 0,
      readError: "not a regular file",
    });
  });

  it("reports a path it cannot reach instead of treating it as absent", async () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-hooks-"));
    const notADirectory = join(directory.path, "runtime");
    writeFileSync(notADirectory, "");
    expect(
      hookEvidenceFrom(await readRuntimeFile(join(notADirectory, "hook-evidence.jsonl"))),
    ).toEqual({
      records: [],
      malformedLines: 0,
      readError: expect.stringContaining("ENOTDIR"),
    });
  });
});

describe("probeStaticCapabilities", () => {
  const probe = (
    env: NodeJS.ProcessEnv,
    executable = "mia-test-runtime-that-is-not-installed",
    configEnv: Record<string, string> = {},
  ) =>
    probeStaticCapabilities(
      {
        kind: "claude-code",
        executable,
        model: "m",
        effort: "medium",
        workingDirectory: "/work",
        builtinTools: [],
        mcpServers: {},
        toolPolicy: {},
        agentPromptFile: "/prompt.md",
        outputDirectories: [],
        env: configEnv,
        extraSettings: {},
      },
      env,
    );

  it("detects the runtime credential from the environment it is given", () => {
    using home = mkdtempDisposableSync(join(tmpdir(), "mia-home-"));
    expect(probe({ ANTHROPIC_API_KEY: "key", HOME: home.path }).credential_source).toBe(
      "ANTHROPIC_API_KEY",
    );
    expect(probe({ HOME: home.path }).credential_source).toBe("none_detected");
    mkdirSync(join(home.path, ".claude"));
    writeFileSync(join(home.path, ".claude", ".credentials.json"), "{}");
    expect(probe({ HOME: home.path }).credential_source).toBe("claude_credentials_file");
  });

  it("looks the runtime up on the given environment's PATH and runs it with that environment", () => {
    using bin = mkdtempDisposableSync(join(tmpdir(), "mia-bin-"));
    using empty = mkdtempDisposableSync(join(tmpdir(), "mia-bin-"));
    // Prints the version only when the environment it runs with carries the marker. /bin stays on
    // PATH for the script's shebang.
    writeFileSync(join(bin.path, "mia-fake-runtime"), '#!/bin/sh\necho "v-$MIA_MARKER"\n', {
      mode: 0o755,
    });
    const found = probe(
      { PATH: `${bin.path}${delimiter}/bin`, MIA_MARKER: "given" },
      "mia-fake-runtime",
    );
    expect(found.executable_resolved).toBe(join(bin.path, "mia-fake-runtime"));
    expect(found.runtime_version).toBe("v-given");
    expect(
      probe({ PATH: `${empty.path}${delimiter}/bin` }, "mia-fake-runtime").executable_resolved,
    ).toBeNull();
  });

  it("reports a runtime missing from PATH", () => {
    using empty = mkdtempDisposableSync(join(tmpdir(), "mia-bin-"));
    const missing = probe({ PATH: empty.path }, "mia-fake-runtime");
    expect(missing.executable_resolved).toBeNull();
    expect(missing.errors).toContain('runtime executable "mia-fake-runtime" not found on PATH');
  });

  it("looks the runtime up on the PATH the profile's env gives the launch", () => {
    using bin = mkdtempDisposableSync(join(tmpdir(), "mia-bin-"));
    using empty = mkdtempDisposableSync(join(tmpdir(), "mia-bin-"));
    writeFileSync(join(bin.path, "mia-fake-runtime"), "#!/bin/sh\necho v\n", { mode: 0o755 });
    const found = probe({ PATH: empty.path }, "mia-fake-runtime", {
      PATH: `${bin.path}${delimiter}/bin`,
    });
    expect(found.executable_resolved).toBe(join(bin.path, "mia-fake-runtime"));
    expect(found.runtime_version).toBe("v");
  });

  it("never runs the executable name as shell code", () => {
    using bin = mkdtempDisposableSync(join(tmpdir(), "mia-bin-"));
    const marker = join(bin.path, "ran");
    const found = probe({ PATH: `${bin.path}${delimiter}/bin` }, `$(touch ${marker})`);
    expect(found.executable_resolved).toBeNull();
    expect(existsSync(marker)).toBe(false);
  });
});
