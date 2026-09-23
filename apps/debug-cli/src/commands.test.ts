import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog, RecordWriter } from "@mia/records";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportToDirectory, reconcile } from "./commands.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mia-debug-cli-"));
  // The commands print their results; the tests read the filesystem instead.
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const options = (state: string) => ({ state, output: join(root, "export"), json: false });

describe("debug commands open the catalog read-only", () => {
  it.each([
    ["export", (state: string) => exportToDirectory(options(state), "conv_missing")],
    ["reconcile", (state: string) => reconcile(options(state))],
  ])("%s refuses a missing --state and creates nothing", (_, run) => {
    const state = join(root, "mistyped");
    expect(() => run(state)).toThrow("no catalog");
    expect(existsSync(state)).toBe(false);
    expect(existsSync(join(root, "export"))).toBe(false);
  });

  it("exports and reconciles an existing catalog", () => {
    const state = join(root, "state");
    const catalog = new Catalog(state);
    const conversationId = catalog.transaction(() => {
      const writer = new RecordWriter(catalog);
      const provenanceSetId = writer.createProvenanceSet("debug-cli fixture");
      return writer.createConversation({ provenanceSetId, runtimeConversationId: "runtime" }).id;
    });
    catalog.close();
    exportToDirectory(options(state), conversationId);
    expect(existsSync(join(root, "export", "manifest.json"))).toBe(true);
    expect(() => reconcile(options(state))).not.toThrow();
  });
});
