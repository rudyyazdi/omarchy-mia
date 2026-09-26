import { existsSync, mkdtempDisposableSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MCP_TOOL_TIMEOUT_MS, prepareLaunch } from "./launch.ts";

/**
 * A launch plan for a minimal config in `dir`, inheriting `env`; `configEnv` is the profile's own, and
 * `agentPromptFile` replaces the prompt file written into `dir`.
 */
const planIn = (
  dir: string,
  env: NodeJS.ProcessEnv,
  overrides: { configEnv?: Record<string, string>; agentPromptFile?: string | null } = {},
): ReturnType<typeof prepareLaunch> => {
  const { configEnv = {} } = overrides;
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
      mcpServers: {
        d1: { type: "http", url: "http://127.0.0.1:1/mcp", bodyLog: join(dir, "bodies.jsonl") },
      },
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
    agentPromptFile:
      overrides.agentPromptFile === undefined ? promptFile : overrides.agentPromptFile,
    env,
  });
};

describe("launch plan", () => {
  it("inherits only the environment it is given, with the profile's env on top", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-launch-"));
    const plan = planIn(
      directory.path,
      { LANG: "C", SHARED: "inherited", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" },
      { configEnv: { SHARED: "profile" } },
    );
    expect(plan.env).toEqual({
      LANG: "C",
      SHARED: "profile",
      MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS),
      CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS),
    });
    // A held approval prompt gets the 24h budget under both runtime timeouts (capability record F4): 2.1.278
    // aborts a call with no response or progress for 300s regardless of MCP_TOOL_TIMEOUT.
    expect(MCP_TOOL_TIMEOUT_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("writes nothing itself, and plans the directories and files its arguments refer to", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-launch-"));
    const plan = planIn(directory.path, {});
    const runtimeDir = join(directory.path, "runtime");
    const workingDirectory = join(directory.path, "work");
    expect(existsSync(runtimeDir)).toBe(false);
    expect(existsSync(workingDirectory)).toBe(false);

    expect(plan.cwd).toBe(workingDirectory);
    expect(plan.setup.directories).toEqual([runtimeDir, workingDirectory]);
    const argAfter = (flag: string): string => plan.args[plan.args.indexOf(flag) + 1] ?? "";
    const planned = new Map(plan.setup.files.map((file) => [file.path, JSON.parse(file.content)]));
    expect(planned.get(argAfter("--mcp-config"))).toEqual(plan.description.mcp_config);
    expect(planned.get(argAfter("--settings"))).toEqual(plan.description.settings);
  });

  it("hands the runtime each MCP server without the body log only Mia reads", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-launch-"));
    const plan = planIn(directory.path, {});
    const [written] = plan.setup.files;
    expect(JSON.parse(written?.content ?? "{}")).toMatchObject({
      mcpServers: { d1: { type: "http", url: "http://127.0.0.1:1/mcp" } },
    });
    expect(written?.content).not.toContain("bodyLog");
  });

  it("appends the prompt file it is given, and no prompt when given none", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-launch-"));
    const retained = join(directory.path, "objects", "digest");
    const withPrompt = planIn(directory.path, {}, { agentPromptFile: retained });
    const at = withPrompt.args.indexOf("--append-system-prompt-file");
    expect(withPrompt.args.slice(at, at + 2)).toEqual(["--append-system-prompt-file", retained]);
    const withoutPrompt = planIn(directory.path, {}, { agentPromptFile: null });
    expect(withoutPrompt.args).not.toContain("--append-system-prompt-file");
    expect(withoutPrompt.args).toContain("--session-id");
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
