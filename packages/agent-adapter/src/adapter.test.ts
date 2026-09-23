import { existsSync, mkdirSync, mkdtempDisposableSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeStaticCapabilities, readHookEvidence } from "./adapter.ts";

describe("readHookEvidence", () => {
  it("returns no evidence when the hook never wrote a file", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-hooks-"));
    expect(readHookEvidence(join(directory.path, "absent.jsonl"))).toEqual({
      records: [],
      malformedLines: 0,
      readError: null,
    });
  });

  it("keeps every object line and counts the lines that are not one", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-hooks-"));
    const path = join(directory.path, "hook-evidence.jsonl");
    writeFileSync(path, '{"effort":"low"}\n42\n\n{"effort":"high"}\n{"effort":"me');
    expect(readHookEvidence(path)).toEqual({
      records: [{ effort: "low" }, { effort: "high" }],
      malformedLines: 2,
      readError: null,
    });
  });

  it("reports a file it cannot read instead of throwing", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-hooks-"));
    const path = join(directory.path, "hook-evidence.jsonl");
    mkdirSync(path);
    expect(readHookEvidence(path)).toEqual({
      records: [],
      malformedLines: 0,
      readError: expect.stringContaining("EISDIR"),
    });
  });

  it("reports a path it cannot reach instead of treating it as absent", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-hooks-"));
    const notADirectory = join(directory.path, "runtime");
    writeFileSync(notADirectory, "");
    expect(readHookEvidence(join(notADirectory, "hook-evidence.jsonl"))).toEqual({
      records: [],
      malformedLines: 0,
      readError: expect.stringContaining("ENOTDIR"),
    });
  });
});

describe("probeStaticCapabilities", () => {
  const probe = (env: NodeJS.ProcessEnv, executable = "mia-test-runtime-that-is-not-installed") =>
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
        env: {},
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

  it("never runs the executable name as shell code", () => {
    using bin = mkdtempDisposableSync(join(tmpdir(), "mia-bin-"));
    const marker = join(bin.path, "ran");
    const found = probe({ PATH: `${bin.path}${delimiter}/bin` }, `$(touch ${marker})`);
    expect(found.executable_resolved).toBeNull();
    expect(existsSync(marker)).toBe(false);
  });
});
