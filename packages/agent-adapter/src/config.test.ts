import { describe, expect, it } from "vitest";
import { REDACTED, redactValue } from "@mia/protocol";
import {
  bodyLogFor,
  ConfigurationError,
  policyFor,
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

  it.each(["mcp__fixture__write", "constructor", "__proto__"])(
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

  it.each(["mcp__local__read", "mcp__constructor__read", "fixture"])(
    "is null for %s, whose server writes no body log",
    (identity) => {
      expect(bodyLogFor(withBodyLog(), identity)).toBe(null);
    },
  );
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
    ...["constructor", "__proto__"].map((server) => ({
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

  // The env check shares redaction's key rule (redact.test.ts covers its spellings); a weaker check once let
  // SESSION_COOKIE through.
  it.each(["SESSION_COOKIE", "API_KEY"])(
    "rejects %s, which redaction treats as sensitive",
    (key) => {
      expect(redactValue({ [key]: "value" })).toEqual({ [key]: REDACTED });
      const validate = () => validateRuntimeConfig({ ...validRuntime(), env: { [key]: "value" } });
      expect(validate).toThrow(`found key ${key}`);
    },
  );

  it("accepts a token count written in digits", () => {
    expect(() =>
      validateRuntimeConfig({ ...validRuntime(), env: { MAX_THINKING_TOKENS: "8000" } }),
    ).not.toThrow();
  });

  it.each([
    ["GITHUB_TOKEN", "8000"],
    ["API_TOKENS", "abc"],
    ["MAX_THINKING_TOKENS", ""],
    ["MAX_THINKING_TOKENS", "8000 abc"],
    ["SECRET_TOKENS", "12345678"],
  ])("rejects %s=%j, which is not a token count", (key, value) => {
    const validate = () => validateRuntimeConfig({ ...validRuntime(), env: { [key]: value } });
    expect(validate).toThrow(`found key ${key}`);
  });
});
