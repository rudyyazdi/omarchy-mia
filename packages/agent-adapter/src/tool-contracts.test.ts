import { describe, expect, it } from "vitest";
import { bodyLogServersIn, toolContracts, writesBodyLog } from "./tool-contracts.ts";
import type { RuntimeConfig } from "./config.ts";

const runtime = (mcpServers: RuntimeConfig["mcpServers"]): RuntimeConfig => ({
  kind: "claude-code",
  executable: "claude",
  model: "m",
  effort: "low",
  workingDirectory: "/work",
  builtinTools: [],
  mcpServers,
  toolPolicy: {},
  agentPromptFile: "/prompt.md",
  outputDirectories: [],
  env: {},
  extraSettings: {},
});

/** The tool contracts as a conversation's provenance retains them: written to JSON and read back. */
const retained = (config: RuntimeConfig): unknown =>
  JSON.parse(JSON.stringify(toolContracts(config)));

describe("bodyLogServersIn", () => {
  it("finds exactly the servers whose retained entry names a body log", () => {
    const contracts = retained(
      runtime({
        fixture: { type: "http", url: "http://127.0.0.1:1/mcp", bodyLog: "/fixture/bodies.jsonl" },
        real: {
          type: "http",
          url: "https://example.test/mcp",
          headers: { authorization: "Bearer abc" },
        },
        local: { type: "stdio", command: "server", args: [] },
      }),
    );
    expect(bodyLogServersIn(contracts)).toEqual({ status: "known", servers: new Set(["fixture"]) });
  });

  it("reads a server whose entry redaction replaced whole as one with no body log", () => {
    const contracts = { mcpServers: { secret_server: "[REDACTED]" } };
    expect(bodyLogServersIn(contracts)).toEqual({ status: "known", servers: new Set() });
  });

  it("leaves the servers unknown for contracts that list none", () => {
    expect(bodyLogServersIn({ toolPolicy: {} })).toMatchObject({ status: "unknown" });
    expect(bodyLogServersIn(null)).toMatchObject({ status: "unknown" });
  });
});

describe("writesBodyLog", () => {
  const servers = new Set(["fixture"]);
  it("answers by the server a tool identity names, by its whole name", () => {
    expect(writesBodyLog(servers, "mcp__fixture__read")).toBe(true);
    expect(writesBodyLog(servers, "mcp__fixture2__read")).toBe(false);
    expect(writesBodyLog(servers, "fixture")).toBe(false);
  });
});
