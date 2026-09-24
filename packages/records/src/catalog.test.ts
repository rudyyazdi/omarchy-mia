import { existsSync, mkdtempDisposableSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Catalog, defaultStateDir } from "./catalog.ts";
import { SCHEMA_VERSION } from "./schema.ts";

describe("defaultStateDir", () => {
  it("resolves from the environment it is given, not the process's", () => {
    expect(defaultStateDir({ MIA_STATE_DIR: "/state/override", XDG_STATE_HOME: "/xdg" })).toBe(
      "/state/override",
    );
    expect(defaultStateDir({ XDG_STATE_HOME: "/xdg", HOME: "/home/someone" })).toBe("/xdg/mia");
    expect(defaultStateDir({ XDG_STATE_HOME: "", HOME: "/home/someone" })).toBe(
      "/home/someone/.local/state/mia",
    );
    expect(defaultStateDir({})).toBe(join(".", ".local", "state", "mia"));
  });
});

/** Leave a catalog at `path` whose stored schema version is one this code does not know. */
const storeNextSchemaVersion = (path: string): void => {
  const writer = Catalog.openSync(path);
  writer.db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION + 1);
  writer.close();
};

describe("read-only catalog", () => {
  it("opens a catalog at the current schema version", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-catalog-"));
    Catalog.openSync(directory.path).close();
    const reader = Catalog.openSync(directory.path, { readonly: true });
    expect(reader.get("SELECT version FROM schema_version")).toEqual({ version: SCHEMA_VERSION });
    reader.close();
  });

  it("refuses a catalog at another schema version, as a writable open does", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-catalog-"));
    storeNextSchemaVersion(directory.path);
    const mismatch = `catalog schema version ${SCHEMA_VERSION + 1} does not match ${SCHEMA_VERSION}`;
    expect(() => Catalog.openSync(directory.path, { readonly: true })).toThrow(mismatch);
    expect(() => Catalog.openSync(directory.path)).toThrow(mismatch);
  });

  it("closes the database when a writable open fails", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-catalog-"));
    storeNextSchemaVersion(directory.path);
    expect(() => Catalog.openSync(directory.path)).toThrow("does not match");
    // SQLite removes the write-ahead log when the last connection closes; a leaked connection keeps it.
    expect(existsSync(join(directory.path, "catalog.sqlite-wal"))).toBe(false);
  });
});
