import { mkdtempDisposableSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { Catalog, defaultStateDir } from "./catalog.ts";
import { RecordWriter } from "./writer.ts";
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

describe("savepoint", () => {
  /** A catalog with one conversation to append events to, closed and removed when the test finishes. */
  const openCatalog = () => {
    const path = mkdtempSync(join(tmpdir(), "mia-catalog-"));
    const catalog = new Catalog(path);
    onTestFinished(() => {
      catalog.close();
      rmSync(path, { recursive: true, force: true });
    });
    const writer = new RecordWriter(catalog);
    const conversation = writer.createConversation({
      provenanceSetId: writer.createProvenanceSet("test"),
      runtimeConversationId: "rt-1",
    });
    const append = (type: string) =>
      writer.appendEvent({ conversationId: conversation.id, type, payload: {} });
    const eventTypes = () =>
      catalog
        .all<{ type: string }>("SELECT type FROM events ORDER BY sequence")
        .map((row) => row.type);
    return { catalog, append, eventTypes };
  };

  it("undoes only a failed savepoint's writes and commits the rest of the transaction", () => {
    const { catalog, append, eventTypes } = openCatalog();
    catalog.transaction(() => {
      append("before");
      const undone = catalog.savepoint(() => {
        append("undone");
        throw new Error("simulated write failure");
      });
      expect(undone).toMatchObject({ ok: false, error: new Error("simulated write failure") });
      expect(catalog.savepoint(() => append("kept")).ok).toBe(true);
    });
    expect(eventTypes()).toEqual(["before", "kept"]);
  });

  it("refuses to run outside a transaction", () => {
    const { catalog } = openCatalog();
    expect(() => catalog.savepoint(() => undefined)).toThrow("savepoint needs an open transaction");
  });

  it("throws when its failure ended the whole transaction, since nothing is left to commit", () => {
    const { catalog, append, eventTypes } = openCatalog();
    expect(() =>
      catalog.transaction(() => {
        append("before");
        catalog.savepoint(() => {
          // SQLite ends the transaction itself on some I/O errors; ROLLBACK stands in for one.
          catalog.db.exec("ROLLBACK");
          throw new Error("simulated disk I/O error");
        });
      }),
    ).toThrow("simulated disk I/O error");
    expect(catalog.db.isTransaction).toBe(false);
    expect(eventTypes()).toEqual([]);
  });
});
