import { mkdtempDisposableSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MCP_TOOL_TIMEOUT_MS, prepareLaunch } from "./launch.ts";

/** A launch plan for a minimal config in `dir`, inheriting `env`; `configEnv` is the profile's own. */
const planIn = (
  dir: string,
  env: NodeJS.ProcessEnv,
  configEnv: Record<string, string> = {},
): ReturnType<typeof prepareLaunch> => {
  const promptFile = join(dir, "agent.md");
  writeFileSync(promptFile, "prompt\n");
  return prepareLaunch({
    config: {
      kind: "claude-code",
      executable: "claude",
      model: "m",
      effort: "medium",
      workingDirectory: join(dir, "work"),
      builtinTools: [],
      mcpServers: { d1: { type: "http", url: "http://127.0.0.1:1/mcp" } },
      toolPolicy: { mcp__d1__slow: "ask" },
      agentPromptFile: promptFile,
      outputDirectories: [],
      env: configEnv,
      extraSettings: {},
    },
    runtimeDir: join(dir, "runtime"),
    bridgeUrl: "http://127.0.0.1:2/mcp",
    sessionId: "s",
    resume: false,
    turnIndex: 1,
    agentPromptFile: promptFile,
    env,
  });
};

describe("launch plan", () => {
  it("gives a held approval prompt the 24h budget under both runtime timeouts (capability record F4)", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-launch-"));
    const plan = planIn(directory.path, {});
    const day = String(24 * 60 * 60 * 1000);
    expect(String(MCP_TOOL_TIMEOUT_MS)).toBe(day);
    expect(plan.env.MCP_TOOL_TIMEOUT).toBe(day);
    // 2.1.278 aborts a call with no response or progress for 300s regardless of MCP_TOOL_TIMEOUT.
    expect(plan.env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT).toBe(day);
  });

  it("inherits only the environment it is given, with the profile's env on top", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-launch-"));
    const plan = planIn(
      directory.path,
      { LANG: "C", SHARED: "inherited", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" },
      { SHARED: "profile" },
    );
    expect(plan.env).toEqual({
      LANG: "C",
      SHARED: "profile",
      MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS),
      CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS),
    });
  });

  it("turns on runtime debug logging only when the given environment sets MIA_RUNTIME_DEBUG", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-launch-"));
    expect(planIn(directory.path, {}).args).not.toContain("--debug");
    const plan = planIn(directory.path, { MIA_RUNTIME_DEBUG: "mcp" });
    const at = plan.args.indexOf("--debug");
    expect(plan.args.slice(at, at + 4)).toEqual([
      "--debug",
      "mcp",
      "--debug-file",
      join(directory.path, "runtime", "runtime-debug.log"),
    ]);
  });
});
