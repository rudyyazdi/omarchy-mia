import { existsSync, mkdtempDisposableSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { Catalog, defaultStateDir, newId } from "./catalog.ts";
import { RecordWriter } from "./writer.ts";
import { SCHEMA_VERSION, type JournalEventType } from "./schema.ts";

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

describe("savepoint", () => {
  /** A catalog with one conversation to append events to, closed and removed when the test finishes. */
  const openCatalog = () => {
    const path = mkdtempSync(join(tmpdir(), "mia-catalog-"));
    const catalog = Catalog.openSync(path);
    onTestFinished(() => {
      catalog.close();
      rmSync(path, { recursive: true, force: true });
    });
    const writer = new RecordWriter(catalog);
    writer.createConversation({
      id: "conv-1",
      provenanceSetId: writer.createProvenanceSet("test"),
      runtimeConversationId: "rt-1",
    });
    const append = (type: JournalEventType) =>
      writer.appendEvent({ id: newId("evt"), conversationId: "conv-1", type, payload: {} });
    const eventTypes = () =>
      catalog
        .all<{ type: JournalEventType }>("SELECT type FROM events ORDER BY sequence")
        .map((row) => row.type);
    return { catalog, append, eventTypes };
  };

  it("undoes only a failed savepoint's writes and commits the rest of the transaction", () => {
    const { catalog, append, eventTypes } = openCatalog();
    catalog.transaction(() => {
      append("task_submitted");
      const undone = catalog.savepoint(() => {
        append("tool_dispatched");
        throw new Error("simulated write failure");
      });
      expect(undone).toMatchObject({ ok: false, error: new Error("simulated write failure") });
      expect(catalog.savepoint(() => append("runtime_exit")).ok).toBe(true);
    });
    expect(eventTypes()).toEqual(["task_submitted", "runtime_exit"]);
  });

  it("refuses to run outside a transaction", () => {
    const { catalog } = openCatalog();
    expect(() => catalog.savepoint(() => undefined)).toThrow("savepoint needs an open transaction");
  });

  it("throws when its failure ended the whole transaction, since nothing is left to commit", () => {
    const { catalog, append, eventTypes } = openCatalog();
    expect(() =>
      catalog.transaction(() => {
        append("task_submitted");
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
