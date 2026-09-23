import { mkdtempDisposableSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigurationError } from "./config.ts";
import { loadProfileSync, type Profile } from "./profile.ts";

const profileInput = (): Profile => ({
  profile: "unit",
  stateDirectory: "state",
  server: { host: "127.0.0.1", port: 0, secretFile: "secret" },
  architectureDocument: "architecture.md",
  notes: [],
  runtime: {
    kind: "claude-code",
    executable: "claude",
    model: "${MODEL}",
    effort: "low",
    workingDirectory: "work",
    builtinTools: [],
    mcpServers: {},
    toolPolicy: {},
    agentPromptFile: "prompt.md",
    outputDirectories: ["out", "/absolute/output"],
    env: {},
    extraSettings: {},
  },
});

const withProfileFile = (contents: string, check: (path: string) => void) => {
  using directory = mkdtempDisposableSync(join(tmpdir(), "mia-profile-"));
  const path = join(directory.path, "profile.json");
  writeFileSync(path, contents);
  check(path);
};

describe("loadProfileSync", () => {
  it("resolves paths against the profile directory and substitutes the supplied environment", () => {
    withProfileFile(JSON.stringify(profileInput()), (path) => {
      const profile = loadProfileSync(path, { MODEL: "selected-model" });
      const resolved = (name: string) => join(path, "..", name);
      expect(profile).toMatchObject({
        stateDirectory: resolved("state"),
        architectureDocument: resolved("architecture.md"),
        server: { secretFile: resolved("secret") },
        runtime: {
          model: "selected-model",
          executable: "claude",
          workingDirectory: resolved("work"),
          agentPromptFile: resolved("prompt.md"),
          outputDirectories: [resolved("out"), "/absolute/output"],
        },
      });
    });
  });

  // Each value would break or rewrite the profile if it were pasted into the raw JSON text.
  it.each([
    { name: "a quote", value: 'x","executable":"injected' },
    { name: "a backslash", value: "C:\\models\\" },
    { name: "a brace", value: '}{"executable":"injected"}' },
  ])("keeps a substituted value holding $name as the literal string", ({ value }) => {
    withProfileFile(JSON.stringify(profileInput()), (path) => {
      const { runtime } = loadProfileSync(path, { MODEL: value });
      expect(runtime.model).toBe(value);
      expect(runtime.executable).toBe("claude");
    });
  });

  it("substitutes placeholders inside arrays and nested values", () => {
    const input = profileInput();
    input.notes = ["model ${MODEL}"];
    input.runtime.env = { SELECTED: "${MODEL}" };
    withProfileFile(JSON.stringify(input), (path) => {
      const profile = loadProfileSync(path, { MODEL: "m" });
      expect(profile.notes).toEqual(["model m"]);
      expect(profile.runtime.env).toEqual({ SELECTED: "m" });
    });
  });

  it("reports missing files as configuration errors", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-missing-profile-"));
    expect(() => loadProfileSync(join(directory.path, "absent.json"), {})).toThrow(
      ConfigurationError,
    );
  });

  it.each([
    { name: "invalid JSON", contents: "{", message: "not valid JSON" },
    { name: "missing required fields", contents: "{}", message: "is invalid" },
    {
      name: "unresolved environment",
      env: {},
      contents: JSON.stringify(profileInput()),
      message: "runtime.model references ${MODEL} but it is not set",
    },
    {
      name: "a placeholder in a key",
      contents: JSON.stringify({
        ...profileInput(),
        runtime: { ...profileInput().runtime, env: { ["${MODEL}"]: "x" } },
      }),
      message: "runtime.env.${MODEL} has a placeholder in its key",
    },
    {
      name: "non-loopback host",
      contents: JSON.stringify({
        ...profileInput(),
        server: { host: "0.0.0.0", port: 0, secretFile: "secret" },
      }),
      message: "server.host",
    },
    {
      name: "runtime policy violation",
      contents: JSON.stringify({
        ...profileInput(),
        runtime: { ...profileInput().runtime, builtinTools: ["Bash"] },
      }),
      message: "builtinTools",
    },
    {
      name: "unknown field",
      contents: JSON.stringify({ ...profileInput(), extra: true }),
      message: "is invalid",
    },
  ])("rejects $name", ({ contents, message, env = { MODEL: "fixture" } }) => {
    withProfileFile(contents, (path) => {
      const load = () => loadProfileSync(path, env);
      expect(load).toThrow(ConfigurationError);
      expect(load).toThrow(message);
    });
  });
});
