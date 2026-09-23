import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BRIDGE_SERVER_NAME, BRIDGE_TOOL_IDENTITY } from "./bridge.ts";
import type { Effort } from "@mia/protocol";
import type { RuntimeConfig } from "./config.ts";

export interface LaunchPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  files: { mcpConfig: string; settings: string; hookEvidence: string };
  /** Redacted, retained description of what was launched (no secrets, no argv prompt). */
  description: {
    model: string;
    effort: Effort;
    session_id: string;
    resume: boolean;
    builtin_tools: string[];
    mcp_servers: string[];
    permission_prompt_tool: string;
    settings: unknown;
    mcp_config: unknown;
  };
}

export const HOOK_SCRIPT_PATH = join(import.meta.dirname, "hook-capture.mjs");

/** Timeout for a held permission prompt or long tool call: 24h, so a human decision is never timed out by the runtime. */
export const MCP_TOOL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export interface LaunchInput {
  config: RuntimeConfig;
  runtimeDir: string;
  bridgeUrl: string;
  sessionId: string;
  resume: boolean;
  turnIndex: number;
  /** Prompt file to append; the engine passes the conversation's retained snapshot so every turn uses the same bytes. */
  agentPromptFile: string;
  /**
   * The environment the runtime inherits before `config.env` is applied; the entry point passes its own.
   * `MIA_RUNTIME_DEBUG` in it turns on the runtime's debug logging.
   */
  env: NodeJS.ProcessEnv;
}

/**
 * Build the exact runtime invocation. Mia decides everything explicitly: model, effort, tool surface,
 * MCP wiring, permission rules and the approval tool. The prompt text goes on stdin, never argv.
 */
export const prepareLaunch = (input: LaunchInput): LaunchPlan => {
  const { config, runtimeDir, bridgeUrl, sessionId, resume } = input;
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  mkdirSync(config.workingDirectory, { recursive: true, mode: 0o700 });

  const mcpConfig = {
    mcpServers: {
      ...config.mcpServers,
      [BRIDGE_SERVER_NAME]: { type: "http", url: bridgeUrl },
    },
  };
  const denyRules = Object.entries(config.toolPolicy)
    .filter(([, policy]) => policy === "deny")
    .map(([identity]) => identity);
  const askRules = Object.entries(config.toolPolicy)
    .filter(([, policy]) => policy !== "deny")
    .map(([identity]) => identity);
  const allowRules: string[] = [];
  const hookEvidence = join(
    runtimeDir,
    `turn-${String(input.turnIndex).padStart(3, "0")}.hooks.jsonl`,
  );
  const settings = {
    ...config.extraSettings,
    permissions: {
      // Mia's own layer: deny is enforced by the runtime before any prompt; everything else must prompt
      // (ask wins over any inherited allow) so the bridge sees every call and the action gate applies.
      deny: denyRules,
      ask: askRules,
      allow: allowRules,
    },
    hooks: {
      PreToolUse: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: `${JSON.stringify(process.execPath)} ${JSON.stringify(HOOK_SCRIPT_PATH)} ${JSON.stringify(hookEvidence)}`,
            },
          ],
        },
      ],
    },
  };
  const mcpConfigPath = join(runtimeDir, "mcp.json");
  const settingsPath = join(runtimeDir, "settings.json");
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });

  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    config.model,
    "--effort",
    config.effort,
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfigPath,
    "--settings",
    settingsPath,
    "--permission-mode",
    "default",
    "--permission-prompt-tool",
    BRIDGE_TOOL_IDENTITY,
    "--tools",
    config.builtinTools.length === 0 ? "" : config.builtinTools.join(","),
    "--append-system-prompt-file",
    resolve(input.agentPromptFile),
    resume ? "--resume" : "--session-id",
    sessionId,
  ];
  // Diagnostics only: MIA_RUNTIME_DEBUG=mcp adds the runtime's own debug logging (stderr) for that category.
  if (input.env.MIA_RUNTIME_DEBUG)
    args.push(
      "--debug",
      input.env.MIA_RUNTIME_DEBUG,
      "--debug-file",
      join(runtimeDir, "runtime-debug.log"),
    );
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.env)) if (value !== undefined) env[name] = value;
  Object.assign(env, config.env);
  env.MCP_TOOL_TIMEOUT = String(MCP_TOOL_TIMEOUT_MS);
  // Claude Code 2.1.278 adds a separate idle timeout: a call with "no response or progress" for 300s is aborted. A held
  // approval prompt is exactly that, so it gets the same 24h (capability record F4). 0 would disable it entirely.
  env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT = String(MCP_TOOL_TIMEOUT_MS);
  // Never let a nested Claude Code session inherit this process's session context.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  return {
    command: config.executable,
    args,
    env,
    cwd: config.workingDirectory,
    files: { mcpConfig: mcpConfigPath, settings: settingsPath, hookEvidence },
    description: {
      model: config.model,
      effort: config.effort,
      session_id: sessionId,
      resume,
      builtin_tools: config.builtinTools,
      mcp_servers: Object.keys(mcpConfig.mcpServers),
      permission_prompt_tool: BRIDGE_TOOL_IDENTITY,
      settings,
      mcp_config: mcpConfig,
    },
  };
};
