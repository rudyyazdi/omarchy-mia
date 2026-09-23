import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.ts";

/** Column values for an insert or update; an undefined value means "leave this column out". */
export type Row = Record<string, SQLInputValue | undefined>;

type Column = [name: string, value: SQLInputValue];

const definedColumns = (row: Row): Column[] =>
  Object.entries(row).filter((entry): entry is Column => entry[1] !== undefined);

export const newId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, "")}`;

export const nowIso = (): string => new Date().toISOString();

/** Parse stored JSON. The result is unknown; callers that need a shape validate it. */
export const parseJson = (text: string): unknown => JSON.parse(text);

/** The environment variables that choose the default state directory. */
type StateDirEnv = Readonly<Partial<Record<"MIA_STATE_DIR" | "XDG_STATE_HOME" | "HOME", string>>>;

/** Resolve the private state directory: $XDG_STATE_HOME/mia or ~/.local/state/mia unless overridden. */
export const defaultStateDir = (env: StateDirEnv): string => {
  if (env.MIA_STATE_DIR) return env.MIA_STATE_DIR;
  const xdg = env.XDG_STATE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(env.HOME ?? ".", ".local", "state");
  return join(base, "mia");
};

/** A savepoint's result: fn's value, or the error fn's writes were undone after. */
export type SavepointOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

export interface CatalogPaths {
  root: string;
  database: string;
  objects: string;
  conversations: string;
  staging: string;
}

export const catalogPaths = (root: string): CatalogPaths => ({
  root,
  database: join(root, "catalog.sqlite"),
  objects: join(root, "objects", "sha256"),
  conversations: join(root, "conversations"),
  staging: join(root, "staging"),
});

export class Catalog {
  private closed = false;

  private constructor(
    readonly paths: CatalogPaths,
    readonly db: DatabaseSync,
  ) {}

  /**
   * Open the catalog under `root`, creating and migrating it unless `readonly`. It blocks on the filesystem
   * and SQLite, so a caller runs it before serving.
   */
  static openSync(root: string, options: { readonly?: boolean } = {}): Catalog {
    const paths = catalogPaths(root);
    if (!options.readonly) {
      for (const dir of [root, paths.objects, paths.conversations, paths.staging]) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        try {
          chmodSync(dir, 0o700);
        } catch {
          /* best effort */
        }
      }
    } else if (!existsSync(paths.database)) {
      throw new Error(`no catalog at ${paths.database}`);
    }
    const catalog = new Catalog(
      paths,
      new DatabaseSync(paths.database, { readOnly: options.readonly === true }),
    );
    // A failed open closes the connection, so it leaves no handle (and no write-ahead log) behind.
    try {
      // SQLite requires each connection to opt into foreign-key enforcement.
      catalog.db.exec("PRAGMA foreign_keys = ON");
      if (!options.readonly) {
        catalog.db.exec("PRAGMA journal_mode = WAL");
        catalog.db.exec("PRAGMA synchronous = FULL");
        catalog.migrate();
        try {
          chmodSync(paths.database, 0o600);
        } catch {
          /* best effort */
        }
      } else {
        // A reader cannot migrate, but it must still refuse a catalog whose rows it would misread.
        catalog.checkVersion(catalog.storedVersion() ?? "none");
      }
    } catch (error) {
      catalog.db.close();
      throw error;
    }
    return catalog;
  }

  private storedVersion(): number | undefined {
    return this.get<{ version: number }>("SELECT version FROM schema_version LIMIT 1")?.version;
  }

  private checkVersion(version: number | "none"): void {
    if (version !== SCHEMA_VERSION)
      throw new Error(`catalog schema version ${version} does not match ${SCHEMA_VERSION}`);
  }

  private migrate(): void {
    this.db.exec(SCHEMA_SQL);
    const version = this.storedVersion();
    if (version === undefined)
      this.db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(SCHEMA_VERSION);
    else this.checkVersion(version);
  }

  /** Run fn inside one write transaction (no nesting). */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw error;
    }
  }

  /**
   * Run fn inside the open transaction so that a throw undoes only fn's writes, and the transaction can still
   * commit the rest: how a best-effort write stays out of the fate of the records around it. A failure that
   * ended the whole transaction (SQLite rolls back on some I/O errors) throws, because nothing is left to commit.
   */
  savepoint<T>(fn: () => T): SavepointOutcome<T> {
    if (!this.db.isTransaction) throw new Error("savepoint needs an open transaction");
    this.db.exec("SAVEPOINT attempt");
    try {
      const value = fn();
      this.db.exec("RELEASE attempt");
      return { ok: true, value };
    } catch (error) {
      if (!this.db.isTransaction) throw error;
      this.db.exec("ROLLBACK TO attempt");
      this.db.exec("RELEASE attempt");
      return { ok: false, error };
    }
  }

  insert(table: string, row: Row): void {
    const columns = definedColumns(row);
    const names = columns.map(([name]) => name);
    const sql = `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`;
    this.db.prepare(sql).run(...columns.map(([, value]) => value));
  }

  update(table: string, id: string, row: Row): void {
    const columns = definedColumns(row);
    if (columns.length === 0) return;
    const assignments = columns.map(([name]) => `${name} = ?`).join(", ");
    const sql = `UPDATE ${table} SET ${assignments} WHERE id = ?`;
    this.db.prepare(sql).run(...columns.map(([, value]) => value), id);
  }

  get<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T | undefined {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- node:sqlite returns untyped rows; callers name the row type
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T[] {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- node:sqlite returns untyped rows; callers name the row type
    return this.db.prepare(sql).all(...params) as T[];
  }

  nextSequence(conversationId: string): number {
    const row = this.get<{ next: number }>(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM events WHERE conversation_id = ?",
      conversationId,
    );
    return row?.next ?? 1;
  }

  /** Idempotent: node:sqlite throws on an already closed database, and shutdown paths can run twice. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
