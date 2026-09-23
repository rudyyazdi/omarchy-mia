import { mkdtempDisposableSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveCallBudget } from "./budget.ts";

afterEach(() => vi.unstubAllEnvs());

describe("live call budget", () => {
  it("appends one ledger entry per reservation and refuses the cap without writing", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-budget-"));
    const file = join(directory.path, "nested", "calls.jsonl");
    const budget = new LiveCallBudget(file, 2);
    expect(budget.used()).toBe(0);
    expect(budget.take("first", "model-one")).toBe(1);
    const first = readFileSync(file, "utf8");
    writeFileSync(file, `${first}\n  \n`);
    expect(budget.used()).toBe(1);
    expect(budget.take("second", "model-two")).toBe(2);
    const contents = readFileSync(file, "utf8");
    expect(contents.startsWith(first)).toBe(true);
    expect(
      contents
        .split("\n")
        .filter((line) => line.trim())
        .map((line): unknown => JSON.parse(line)),
    ).toEqual([
      { at: expect.any(String), label: "first", model: "model-one" },
      { at: expect.any(String), label: "second", model: "model-two" },
    ]);
    expect(() => budget.take("third", "model-three")).toThrow("live call cap reached (2/2)");
    expect(readFileSync(file, "utf8")).toBe(contents);
  });

  it("uses environment overrides and the documented defaults when absent", () => {
    vi.stubEnv("MIA_LIVE_BUDGET_FILE", undefined);
    vi.stubEnv("MIA_LIVE_CALL_CAP", undefined);
    expect(LiveCallBudget.fromEnv("fallback")).toMatchObject({ file: "fallback", cap: 50 });
    vi.stubEnv("MIA_LIVE_BUDGET_FILE", "override");
    vi.stubEnv("MIA_LIVE_CALL_CAP", "3");
    expect(LiveCallBudget.fromEnv("fallback")).toMatchObject({ file: "override", cap: 3 });
  });

  it.each(["abc", "", "-1", "2.5", "1e3", " 3"])(
    "refuses a call cap that is not a non-negative integer: %j",
    (cap) => {
      vi.stubEnv("MIA_LIVE_CALL_CAP", cap);
      expect(() => LiveCallBudget.fromEnv("fallback")).toThrow(
        "MIA_LIVE_CALL_CAP must be a non-negative integer",
      );
    },
  );
});
