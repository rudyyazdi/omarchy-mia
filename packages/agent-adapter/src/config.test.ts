import { describe, expect, it } from "vitest";
import { REDACTED, redactValue } from "@mia/protocol";
import {
  bodyLogFor,
  ConfigurationError,
  policyFor,
  runtimeMcpServer,
  validateRuntimeConfig,
  type RuntimeConfig,
} from "./config.ts";

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

describe("policyFor", () => {
  it("returns the listed policy for a listed tool", () => {
    expect(policyFor(validRuntime(), "mcp__fixture__read")).toBe("allow");
  });

  it.each(["mcp__fixture__write", "constructor", "toString", "hasOwnProperty", "__proto__"])(
    "returns unlisted for %s, which the profile does not list",
    (identity) => {
      expect(policyFor(validRuntime(), identity)).toBe("unlisted");
    },
  );
});

describe("bodyLogFor", () => {
  const withBodyLog = (): RuntimeConfig => ({
    ...validRuntime(),
    mcpServers: {
      fixture: { type: "http", url: "http://127.0.0.1:1/mcp", bodyLog: "/fixture/bodies.jsonl" },
      plain: { type: "http", url: "http://127.0.0.1:2/mcp" },
      local: { type: "stdio", command: "local", args: [] },
    },
  });

  it("names the body log of the server a tool identity names", () => {
    expect(bodyLogFor(withBodyLog(), "mcp__fixture__read")).toBe("/fixture/bodies.jsonl");
  });

  it.each([
    "mcp__plain__read",
    "mcp__local__read",
    "mcp__missing__read",
    "mcp__constructor__read",
    "fixture",
  ])("is null for %s, whose server writes no body log", (identity) => {
    expect(bodyLogFor(withBodyLog(), identity)).toBe(null);
  });
});

describe("runtimeMcpServer", () => {
  it("leaves out the body log, which only Mia reads", () => {
    expect(
      runtimeMcpServer({ type: "http", url: "http://127.0.0.1:1/mcp", bodyLog: "/bodies.jsonl" }),
    ).toEqual({ type: "http", url: "http://127.0.0.1:1/mcp" });
    const stdio = { type: "stdio" as const, command: "local", args: ["-v"] };
    expect(runtimeMcpServer(stdio)).toEqual(stdio);
  });
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
    ...["constructor", "toString", "hasOwnProperty", "__proto__"].map((server) => ({
      name: `policy for inherited name ${server}`,
      overrides: { toolPolicy: { [`mcp__${server}__x`]: "allow" as const } },
      message: `no MCP server "${server}"`,
    })),
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
