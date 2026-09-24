import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog, RecordWriter, newId } from "@mia/records";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { exportToDirectory, reconcile } from "./commands.ts";

let root: string;
let log: MockInstance<typeof console.log>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mia-debug-cli-"));
  // Printing is how these commands report; the spy keeps it off the test output and lets tests read it.
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
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
    const catalog = Catalog.openSync(state);
    const conversationId = catalog.transaction(() => {
      const writer = new RecordWriter(catalog);
      const provenanceSetId = writer.createProvenanceSet("debug-cli fixture");
      const id = newId("conv");
      writer.createConversation({ id, provenanceSetId, runtimeConversationId: "runtime" });
      return id;
    });
    catalog.close();
    // A writable open resets the database to 0600 and runs the migration; a read-only one does neither.
    chmodSync(catalog.paths.database, 0o400);
    exportToDirectory(options(state), conversationId);
    expect(existsSync(join(root, "export", "manifest.json"))).toBe(true);
    reconcile(options(state));
    expect(log).toHaveBeenLastCalledWith(
      JSON.stringify({ orphans: [], missing: [], corrupt: [] }, null, 2),
    );
    expect(statSync(catalog.paths.database).mode & 0o777).toBe(0o400);
  });
});
