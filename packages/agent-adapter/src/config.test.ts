import { describe, expect, it } from "vitest";
import { ConfigurationError, validateRuntimeConfig, type RuntimeConfig } from "./config.ts";

const validRuntime = (): RuntimeConfig => ({
  kind: "claude-code",
  executable: "claude",
  model: "fixture",
  effort: "medium",
  workingDirectory: "/work",
  builtinTools: [],
  mcpServers: { fixture: { type: "stdio", command: "fixture", args: [] } },
  toolPolicy: { mcp__fixture__read: "allow" },
  agentPromptFile: "/prompt.md",
  outputDirectories: [],
  env: {},
  extraSettings: {},
});

describe("validateRuntimeConfig", () => {
  it("accepts policies for configured servers and ordinary environment variables", () => {
    expect(() => validateRuntimeConfig({ ...validRuntime(), env: { LANG: "C" } })).not.toThrow();
  });

  const invalidCases: { name: string; overrides: Partial<RuntimeConfig>; message: string }[] = [
    {
      name: "policy for absent server",
      overrides: { toolPolicy: { mcp__missing__read: "allow" } },
      message: 'no MCP server "missing"',
    },
    {
      name: "malformed policy identity",
      overrides: { toolPolicy: { invalid: "ask" } },
      message: "toolPolicy names invalid",
    },
    {
      name: "reserved bridge name",
      overrides: {
        mcpServers: { mia_approval: { type: "stdio", command: "fixture", args: [] } },
        toolPolicy: {},
      },
      message: "name is reserved",
    },
    {
      name: "built-in tools",
      overrides: { builtinTools: ["Bash"] },
      message: 'builtinTools includes "Bash"',
    },
    ...["TOKEN", "client_secret", "Password", "API_KEY", "Authorization"].map((key) => ({
      name: `credential ${key}`,
      overrides: { env: { [key]: "credential" } },
      message: `found key ${key}`,
    })),
  ];
  it.each(invalidCases)("rejects $name", ({ overrides, message }) => {
    const validate = () => validateRuntimeConfig({ ...validRuntime(), ...overrides });
    expect(validate).toThrow(ConfigurationError);
    expect(validate).toThrow(message);
  });
});
