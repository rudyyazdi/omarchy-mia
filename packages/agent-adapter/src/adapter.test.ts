import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempDisposableSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  boundedRuntimeFileReader,
  hookEvidenceFrom,
  probeStaticCapabilities,
  readRuntimeFile,
  writeLaunchFiles,
  type RuntimeFileRead,
} from "./adapter.ts";

describe("writeLaunchFiles", () => {
  it("creates the planned directories and files, owner-only, with the planned contents", async () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-launch-files-"));
    const runtimeDir = join(directory.path, "conversation", "runtime");
    const workingDirectory = join(directory.path, "work");
    const settings = join(runtimeDir, "settings.json");
    await writeLaunchFiles({
      directories: [runtimeDir, workingDirectory],
      files: [{ path: settings, content: "{}" }],
    });
    for (const created of [runtimeDir, workingDirectory]) {
      expect(statSync(created).isDirectory()).toBe(true);
      expect(statSync(created).mode & 0o077).toBe(0);
    }
    expect(readFileSync(settings, "utf8")).toBe("{}");
    expect(statSync(settings).mode & 0o077).toBe(0);
  });
});

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

describe("boundedRuntimeFileReader", () => {
  const blocked = { status: "unreadable", reason: "an earlier abandoned read is still blocked" };

  /** An injected read that settles only when the test settles it, recording every path it starts on. */
  const heldReads = () => {
    const started: string[] = [];
    const pending: PromiseWithResolvers<RuntimeFileRead>[] = [];
    const read = (path: string) => {
      started.push(path);
      const held = Promise.withResolvers<RuntimeFileRead>();
      pending.push(held);
      return held.promise;
    };
    return { started, pending, read };
  };

  const abandonRead = async (reader: ReturnType<typeof boundedRuntimeFileReader>, path: string) => {
    const controller = new AbortController();
    const result = reader(path, { signal: controller.signal });
    controller.abort(new DOMException("deadline", "TimeoutError"));
    expect(await result).toEqual({ status: "unreadable", reason: "timed out" });
  };

  it("refuses a read without starting it while the cap of abandoned reads is still blocked", async () => {
    const reads = heldReads();
    const reader = boundedRuntimeFileReader({ read: reads.read, maxStuckReads: 2 });
    await abandonRead(reader, "first");
    await abandonRead(reader, "second");
    expect(await reader("third")).toEqual(blocked);
    expect(await reader("fourth", { signal: new AbortController().signal })).toEqual(blocked);
    expect(reads.started).toEqual(["first", "second"]);
  });

  it("frees an abandoned read's slot once it finally returns", async () => {
    const reads = heldReads();
    const reader = boundedRuntimeFileReader({ read: reads.read, maxStuckReads: 1 });
    await abandonRead(reader, "stuck");
    expect(await reader("refused")).toEqual(blocked);
    const [stuck] = reads.pending;
    if (!stuck) throw new Error("the stuck read never started");
    stuck.resolve({ status: "absent" });
    await stuck.promise;
    const next = reader("next");
    const [, pendingNext] = reads.pending;
    if (!pendingNext) throw new Error("the next read never started");
    pendingNext.resolve({ status: "read", bytes: Buffer.from("{}\n") });
    expect(await next).toEqual({ status: "read", bytes: Buffer.from("{}\n") });
    expect(reads.started).toEqual(["stuck", "next"]);
  });

  it("frees an abandoned read's slot when it finally rejects", async () => {
    const reads = heldReads();
    const reader = boundedRuntimeFileReader({ read: reads.read, maxStuckReads: 1 });
    await abandonRead(reader, "stuck");
    const [stuck] = reads.pending;
    if (!stuck) throw new Error("the stuck read never started");
    stuck.reject(new Error("EIO"));
    await expect(stuck.promise).rejects.toThrow("EIO");
    await abandonRead(reader, "next");
    expect(reads.started).toEqual(["stuck", "next"]);
  });

  it("reports an already-aborted signal's own reason even at the cap", async () => {
    const reads = heldReads();
    const reader = boundedRuntimeFileReader({ read: reads.read, maxStuckReads: 1 });
    await abandonRead(reader, "stuck");
    const signal = AbortSignal.abort(new Error("abandoned at shutdown"));
    expect(await reader("late", { signal })).toEqual({
      status: "unreadable",
      reason: "abandoned at shutdown",
    });
    expect(reads.started).toEqual(["stuck"]);
  });

  it("counts only abandoned reads, not reads that return in time", async () => {
    const reads = heldReads();
    const reader = boundedRuntimeFileReader({ read: reads.read, maxStuckReads: 1 });
    const inFlight = [reader("first"), reader("second", { signal: new AbortController().signal })];
    for (const held of reads.pending) held.resolve({ status: "absent" });
    expect(await Promise.all(inFlight)).toEqual([{ status: "absent" }, { status: "absent" }]);
    await abandonRead(reader, "third");
    expect(reads.started).toEqual(["first", "second", "third"]);
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
