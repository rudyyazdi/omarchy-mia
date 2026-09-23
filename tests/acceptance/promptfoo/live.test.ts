import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runLive } from "./live.ts";

describe("runLive", () => {
  let parent: string;
  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "mia-live-"));
  });
  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it("rejects an aborted signal before it creates evidence or starts anything", async () => {
    const out = join(parent, "evidence");
    const options = { repeat: "1", agentPrompt: "prompts/agent-v1.md", model: "none", out };
    await expect(runLive(options, {}, AbortSignal.abort())).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(existsSync(out)).toBe(false);
  });
});
