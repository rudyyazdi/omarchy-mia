import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MCP_TOOL_TIMEOUT_MS, prepareLaunch } from "./launch.ts";

describe("launch plan", () => {
  it("gives a held approval prompt the 24h budget under both runtime timeouts (capability record F4)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mia-launch-"));
    const promptFile = join(dir, "agent.md");
    writeFileSync(promptFile, "prompt\n");
    const plan = prepareLaunch({
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
        env: {},
        extraSettings: {},
      },
      runtimeDir: join(dir, "runtime"),
      bridgeUrl: "http://127.0.0.1:2/mcp",
      sessionId: "s",
      resume: false,
      turnIndex: 1,
      agentPromptFile: promptFile,
    });
    const day = String(24 * 60 * 60 * 1000);
    expect(String(MCP_TOOL_TIMEOUT_MS)).toBe(day);
    expect(plan.env.MCP_TOOL_TIMEOUT).toBe(day);
    // 2.1.278 aborts a call with no response or progress for 300s regardless of MCP_TOOL_TIMEOUT.
    expect(plan.env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT).toBe(day);
  });
});
