import { describe, expect, it } from "vitest";
import { bodyLogServersIn, serverBodyLog, toolContracts } from "./tool-contracts.ts";
import type { RuntimeConfig } from "./config.ts";

const runtime = (mcpServers: RuntimeConfig["mcpServers"]): RuntimeConfig => ({
  kind: "claude-code",
  executable: "claude",
  model: "m",
  effort: "low",
  workingDirectory: "/work",
  builtinTools: [],
  mcpServers,
  toolPolicy: { mcp__fixture__read: "allow" },
  agentPromptFile: "/prompt.md",
  outputDirectories: [],
  env: {},
  extraSettings: {},
});

type McpServer = RuntimeConfig["mcpServers"][string];
const FIXTURE: McpServer = {
  type: "http",
  url: "http://127.0.0.1:1/mcp",
  bodyLog: "/fixture/bodies.jsonl",
};
const REAL: McpServer = {
  type: "http",
  url: "https://example.test/mcp",
  headers: { authorization: "Bearer abc" },
};
const SERVERS: RuntimeConfig["mcpServers"] = {
  fixture: FIXTURE,
  real: REAL,
  local: { type: "stdio", command: "server", args: [] },
  "token-fixture": { type: "http", url: "http://127.0.0.1:2/mcp", bodyLog: "/t/bodies.jsonl" },
};

/** The tool contracts as a conversation's provenance retains them: written to JSON and read back. */
const retained = (config: RuntimeConfig): unknown =>
  JSON.parse(JSON.stringify(toolContracts(config)));

describe("toolContracts", () => {
  it("keeps the retained d1 format: its fields in order, the servers redacted", () => {
    // Pinned: provenance retains these bytes (`JSON.stringify(…, null, 2)`), so a change here changes the records.
    expect(JSON.stringify(toolContracts(runtime({ fixture: FIXTURE, real: REAL })), null, 2))
      .toBe(`{
  "mcpServers": {
    "fixture": {
      "type": "http",
      "url": "http://127.0.0.1:1/mcp",
      "bodyLog": "/fixture/bodies.jsonl"
    },
    "real": {
      "type": "http",
      "url": "https://example.test/mcp",
      "headers": {
        "authorization": "[REDACTED]"
      }
    }
  },
  "toolPolicy": {
    "mcp__fixture__read": "allow"
  },
  "builtinTools": []
}`);
  });
});

describe("bodyLogServersIn and serverBodyLog", () => {
  const servers = bodyLogServersIn(retained(runtime(SERVERS)));

  it("tells a server that writes a body log from one that does not", () => {
    expect(serverBodyLog(servers, "mcp__fixture__read")).toEqual({ kind: "writes" });
    expect(serverBodyLog(servers, "mcp__real__read")).toEqual({ kind: "none" });
    expect(serverBodyLog(servers, "mcp__local__read")).toEqual({ kind: "none" });
  });

  it("cannot tell for a server whose entry redaction replaced whole, or one the contracts do not list", () => {
    expect(serverBodyLog(servers, "mcp__token-fixture__read")).toEqual({
      kind: "unknown",
      reason: "its server's retained entry was redacted",
    });
    expect(serverBodyLog(servers, "mcp__fixture2__read")).toMatchObject({ kind: "unknown" });
    expect(serverBodyLog(servers, "fixture")).toMatchObject({ kind: "unknown" });
  });

  it("leaves every server unknown for contracts that list none", () => {
    for (const contracts of [{ toolPolicy: {} }, null]) {
      const unknown = bodyLogServersIn(contracts);
      expect(unknown).toMatchObject({ status: "unknown" });
      expect(serverBodyLog(unknown, "mcp__fixture__read")).toMatchObject({ kind: "unknown" });
    }
  });
});
