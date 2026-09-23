import { mkdirSync, mkdtempDisposableSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const probeCredential = (env: Parameters<typeof probeStaticCapabilities>[1]) =>
    probeStaticCapabilities(
      {
        kind: "claude-code",
        executable: "mia-test-runtime-that-is-not-installed",
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
    ).credential_source;

  it("detects the runtime credential from the environment it is given", () => {
    using home = mkdtempDisposableSync(join(tmpdir(), "mia-home-"));
    expect(probeCredential({ ANTHROPIC_API_KEY: "key", HOME: home.path })).toBe(
      "ANTHROPIC_API_KEY",
    );
    expect(probeCredential({ HOME: home.path })).toBe("none_detected");
    mkdirSync(join(home.path, ".claude"));
    writeFileSync(join(home.path, ".claude", ".credentials.json"), "{}");
    expect(probeCredential({ HOME: home.path })).toBe("claude_credentials_file");
  });
});
