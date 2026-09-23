import { mkdtempDisposableSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Catalog } from "./catalog.ts";
import { SCHEMA_VERSION } from "./schema.ts";

describe("read-only catalog", () => {
  it("opens a catalog at the current schema version", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-catalog-"));
    new Catalog(directory.path).close();
    const reader = new Catalog(directory.path, { readonly: true });
    expect(reader.get("SELECT version FROM schema_version")).toEqual({ version: SCHEMA_VERSION });
    reader.close();
  });

  it("refuses a catalog at another schema version, as a writable open does", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-catalog-"));
    const writer = new Catalog(directory.path);
    writer.db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION + 1);
    writer.close();
    const mismatch = `catalog schema version ${SCHEMA_VERSION + 1} does not match ${SCHEMA_VERSION}`;
    expect(() => new Catalog(directory.path, { readonly: true })).toThrow(mismatch);
    expect(() => new Catalog(directory.path)).toThrow(mismatch);
  });
});
