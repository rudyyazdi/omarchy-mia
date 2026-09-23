import { describe, expect, it } from "vitest";
import { REDACTED, redactValue } from "@mia/protocol";
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
  ];
  it.each(invalidCases)("rejects $name", ({ overrides, message }) => {
    const validate = () => validateRuntimeConfig({ ...validRuntime(), ...overrides });
    expect(validate).toThrow(ConfigurationError);
    expect(validate).toThrow(message);
  });

  // Each spelling the redaction pattern covers; a weaker env check once let SESSION_COOKIE through.
  const redactedKeys = [
    "TOKEN",
    "client_secret",
    "Password",
    "DB_PASSWD",
    "API_KEY",
    "Authorization",
    "AWS_CREDENTIALS",
    "SESSION_COOKIE",
    "PRIVATE_KEY",
    "BEARER_HEADER",
  ];
  it.each(redactedKeys)("rejects %s, which redaction treats as sensitive", (key) => {
    expect(redactValue({ [key]: "value" })).toEqual({ [key]: REDACTED });
    const validate = () => validateRuntimeConfig({ ...validRuntime(), env: { [key]: "value" } });
    expect(validate).toThrow(`found key ${key}`);
  });

  it.each(["MAX_THINKING_TOKENS", "CLAUDE_CODE_MAX_OUTPUT_TOKENS"])(
    "accepts %s, a token count written in digits",
    (key) => {
      expect(() =>
        validateRuntimeConfig({ ...validRuntime(), env: { [key]: "8000" } }),
      ).not.toThrow();
    },
  );

  it.each([
    ["GITHUB_TOKEN", "8000"],
    ["API_TOKENS", "abc"],
    ["MAX_THINKING_TOKENS", ""],
    ["MAX_THINKING_TOKENS", "8000 abc"],
    ["MAX_THINKING_TOKENS", "1234567890"],
    ["SECRET_TOKENS", "12345678"],
    ["DB_PASSWORD_TOKENS", "424242"],
  ])("rejects %s=%j, which is not a token count", (key, value) => {
    const validate = () => validateRuntimeConfig({ ...validRuntime(), env: { [key]: value } });
    expect(validate).toThrow(`found key ${key}`);
  });
});
