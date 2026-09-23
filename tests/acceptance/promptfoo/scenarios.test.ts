import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import assertScenario from "./assert.ts";
import {
  decisionAckOf,
  readScenarioList,
  readScenarioName,
  SCENARIOS,
  ScenarioNameSchema,
} from "./scenarios.ts";

const declared = [...ScenarioNameSchema.options].toSorted();

describe("live scenario names", () => {
  it("defines every declared scenario exactly once", () => {
    expect(SCENARIOS.map((scenario) => scenario.name).toSorted()).toEqual(declared);
  });

  // promptfoo reads its test list from YAML, so the declared names are checked against it here.
  // `--filter-pattern` selects by description, so each description must be its scenario's name.
  it("runs every declared scenario exactly once from the promptfoo config, described by its name", () => {
    const config = readFileSync(join(import.meta.dirname, "promptfooconfig.yaml"), "utf8");
    const tests = [
      ...config.matchAll(/description: ([\w-]+)\n\s+vars: \{ scenario: ([\w-]+) \}/g),
    ].map((found) => ({ description: found[1], scenario: found[2] }));
    expect(tests.map((test) => test.scenario).toSorted()).toEqual(declared);
    for (const test of tests) expect(test.description).toBe(test.scenario);
  });

  it("reads a declared name and names an unknown one", () => {
    expect(readScenarioName("allowed")).toEqual({ ok: true, name: "allowed" });
    expect(readScenarioName("alowed")).toEqual({
      ok: false,
      error: 'unknown scenario "alowed"',
    });
  });

  it("fails an assertion for an unknown scenario before reading the output", () => {
    expect(assertScenario("", { vars: { scenario: "alowed" } })).toEqual({
      pass: false,
      score: 0,
      reason: 'unknown scenario "alowed"',
    });
  });

  it("reads a --scenarios list only when every entry is declared", () => {
    expect(readScenarioList("allowed,denied")).toEqual({ ok: true, names: ["allowed", "denied"] });
    const rejected: [value: string, entry: string][] = [
      ["alowed", "alowed"],
      ["allowed,", ""],
      ["", ""],
    ];
    for (const [value, entry] of rejected)
      expect(readScenarioList(value)).toEqual({
        ok: false,
        error: `unknown scenario ${JSON.stringify(entry)}; declared: ${ScenarioNameSchema.options.join(", ")}`,
      });
  });
});

describe("decision ack evidence", () => {
  it("records an accepted ack without a code and a refusal with its error code", () => {
    expect(decisionAckOf({ command_id: "command", disposition: "accepted" }, false)).toEqual({
      disposition: "accepted",
      after_reconnect: false,
    });
    expect(
      decisionAckOf(
        {
          command_id: "command",
          disposition: "failed",
          error: { code: "internal", message: "boom" },
        },
        true,
      ),
    ).toEqual({ disposition: "failed", code: "internal", after_reconnect: true });
  });
});
