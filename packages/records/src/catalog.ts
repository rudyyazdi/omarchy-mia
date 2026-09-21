import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.ts";

export type Row = Record<string, SQLInputValue | undefined>;

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Resolve the private state directory: $XDG_STATE_HOME/mia or ~/.local/state/mia unless overridden. */
export function defaultStateDir(): string {
  if (process.env.MIA_STATE_DIR) return process.env.MIA_STATE_DIR;
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(process.env.HOME ?? ".", ".local", "state");
  return join(base, "mia");
}

export interface CatalogPaths {
  root: string;
  database: string;
  objects: string;
  conversations: string;
  staging: string;
}

export function catalogPaths(root: string): CatalogPaths {
  return {
    root,
    database: join(root, "catalog.sqlite"),
    objects: join(root, "objects", "sha256"),
    conversations: join(root, "conversations"),
    staging: join(root, "staging"),
  };
}

export class Catalog {
  readonly db: DatabaseSync;
  readonly paths: CatalogPaths;

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
    const row = this.db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
      { version: number } | undefined;
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
    const keys = Object.keys(row).filter((k) => row[k] !== undefined);
    const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`;
    this.db.prepare(sql).run(...keys.map((k) => row[k] as SQLInputValue));
  }

  update(table: string, id: string, row: Row): void {
    const keys = Object.keys(row).filter((k) => row[k] !== undefined);
    if (keys.length === 0) return;
    const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`;
    this.db.prepare(sql).run(...keys.map((k) => row[k] as SQLInputValue), id);
  }

  get<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  nextSequence(conversationId: string): number {
    const row = this.get<{ next: number }>(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM events WHERE conversation_id = ?",
      conversationId,
    );
    return row?.next ?? 1;
  }

  close(): void {
    this.db.close();
  }
}
