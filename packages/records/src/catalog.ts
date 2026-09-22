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

/** Resolve the private state directory: $XDG_STATE_HOME/mia or ~/.local/state/mia unless overridden. */
export const defaultStateDir = (): string => {
  if (process.env.MIA_STATE_DIR) return process.env.MIA_STATE_DIR;
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(process.env.HOME ?? ".", ".local", "state");
  return join(base, "mia");
};

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
  readonly db: DatabaseSync;
  readonly paths: CatalogPaths;
  private closed = false;

  constructor(root: string, options: { readonly?: boolean } = {}) {
    this.paths = catalogPaths(root);
    if (!options.readonly) {
      for (const dir of [root, this.paths.objects, this.paths.conversations, this.paths.staging]) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        try {
          chmodSync(dir, 0o700);
        } catch {
          /* best effort */
        }
      }
    } else if (!existsSync(this.paths.database)) {
      throw new Error(`no catalog at ${this.paths.database}`);
    }
    this.db = new DatabaseSync(this.paths.database, { readOnly: options.readonly === true });
    // SQLite requires each connection to opt into foreign-key enforcement.
    this.db.exec("PRAGMA foreign_keys = ON");
    if (!options.readonly) {
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = FULL");
      this.migrate();
      try {
        chmodSync(this.paths.database, 0o600);
      } catch {
        /* best effort */
      }
    }
  }

  private migrate(): void {
    this.db.exec(SCHEMA_SQL);
    const row = this.get<{ version: number }>("SELECT version FROM schema_version LIMIT 1");
    if (!row) this.db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(SCHEMA_VERSION);
    else if (row.version !== SCHEMA_VERSION)
      throw new Error(`catalog schema version ${row.version} does not match ${SCHEMA_VERSION}`);
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
