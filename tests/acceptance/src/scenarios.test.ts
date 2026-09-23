import { describe, expect, it } from "vitest";
import { parseScenarioName, SCENARIOS, ScenarioNameSchema } from "../promptfoo/scenarios.ts";

describe("live scenario names", () => {
  it("defines every declared scenario exactly once", () => {
    expect(SCENARIOS.map((scenario) => scenario.name).toSorted()).toEqual(
      [...ScenarioNameSchema.options].toSorted(),
    );
  });

  it("rejects an unknown scenario by name", () => {
    expect(parseScenarioName("allowed")).toBe("allowed");
    expect(() => parseScenarioName("alowed")).toThrow("unknown scenario alowed");
  });
});
