import { mkdtempDisposableSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readHookEvidence } from "./adapter.ts";

describe("readHookEvidence", () => {
  it("returns no evidence when the hook never wrote a file", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-hooks-"));
    expect(readHookEvidence(join(directory.path, "absent.jsonl"))).toEqual({
      records: [],
      malformedLines: 0,
    });
  });

  it("keeps every object line and counts the lines that are not one", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-hooks-"));
    const path = join(directory.path, "hook-evidence.jsonl");
    writeFileSync(path, '{"effort":"low"}\n42\n\n{"effort":"high"}\n{"effort":"me');
    expect(readHookEvidence(path)).toEqual({
      records: [{ effort: "low" }, { effort: "high" }],
      malformedLines: 2,
    });
  });
});
