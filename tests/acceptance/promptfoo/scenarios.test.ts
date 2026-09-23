import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import assertScenario from "./assert.ts";
import { readScenarioName, SCENARIOS, ScenarioNameSchema } from "./scenarios.ts";

const declared = [...ScenarioNameSchema.options].toSorted();

describe("live scenario names", () => {
  it("defines every declared scenario exactly once", () => {
    expect(SCENARIOS.map((scenario) => scenario.name).toSorted()).toEqual(declared);
  });

  // promptfoo reads its test list from YAML, so the declared names are checked against it here.
  it("runs every declared scenario exactly once from the promptfoo config", () => {
    const config = readFileSync(join(import.meta.dirname, "promptfooconfig.yaml"), "utf8");
    const listed = [...config.matchAll(/vars: \{ scenario: ([\w-]+) \}/g)].map((found) => found[1]);
    expect(listed.toSorted()).toEqual(declared);
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
});
