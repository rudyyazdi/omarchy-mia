import { mkdtempDisposableSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LiveCallBudget } from "./budget.ts";

describe("live call budget", () => {
  it("appends one ledger entry per reservation and refuses the cap without writing", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-budget-"));
    const file = join(directory.path, "nested", "calls.jsonl");
    const budget = new LiveCallBudget(file, 2);
    expect(budget.usedSync()).toBe(0);
    expect(budget.takeSync("first", "model-one")).toBe(1);
    const first = readFileSync(file, "utf8");
    writeFileSync(file, `${first}\n  \n`);
    expect(budget.usedSync()).toBe(1);
    expect(budget.takeSync("second", "model-two")).toBe(2);
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
    expect(() => budget.takeSync("third", "model-three")).toThrow("live call cap reached (2/2)");
    expect(readFileSync(file, "utf8")).toBe(contents);
  });

  it.each(["", "1e3", "99999999999999999999"])(
    "refuses a call cap that is not a non-negative integer: %j",
    (cap) => {
      expect(() => LiveCallBudget.fromEnv({ MIA_LIVE_CALL_CAP: cap }, "fallback")).toThrow(
        "must be a non-negative integer",
      );
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])("refuses a constructed cap of %d", (cap) => {
    expect(() => new LiveCallBudget("file", cap)).toThrow("must be a non-negative integer");
  });
});
