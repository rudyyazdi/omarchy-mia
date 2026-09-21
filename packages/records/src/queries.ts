import type { Catalog } from "./catalog.ts";
import { EXPORT_TABLES, type ExportTable } from "./schema.ts";

export type Rows = Record<string, unknown>[];

export interface ConversationSummary {
  id: string;
  started_at: string;
  status: string;
  task_count: number;
  last_sequence: number;
  runtime_conversation_id: string | null;
}

export function listConversations(catalog: Catalog): ConversationSummary[] {
  return catalog.all<ConversationSummary>(`
    SELECT c.id, c.started_at, c.status, c.runtime_conversation_id,
      (SELECT COUNT(*) FROM tasks t WHERE t.conversation_id = c.id) AS task_count,
      (SELECT COALESCE(MAX(sequence), 0) FROM events e WHERE e.conversation_id = c.id) AS last_sequence
    FROM conversations c ORDER BY c.started_at DESC, c.id DESC`);
}

export interface ConversationSnapshot {
  conversation_id: string;
  captured_at: string;
  cutoff_sequence: number;
  tables: Record<ExportTable, Rows>;
  /** Artifact ids reachable from this conversation (links + dependency closure). */
  artifact_closure: string[];
  /** References to rows outside the closure, reported not traversed. */
  unresolved_references: Array<{ table: string; id: string; reason: string }>;
  ongoing_tasks: string[];
}

/**
 * Read every record belonging to one conversation from a single SQLite read transaction, bounded by the
 * maximum committed event sequence at that moment. Later writes cannot leak into the result.
 */
export function snapshotConversation(
  catalog: Catalog,
  conversationId: string,
): ConversationSnapshot {
  const db = catalog.db;
  db.exec("BEGIN");
  try {
    const conversation = catalog.get("SELECT * FROM conversations WHERE id = ?", conversationId);
    if (!conversation) throw new Error(`conversation ${conversationId} not found`);
    const cutoff = catalog.get<{ c: number }>(
      "SELECT COALESCE(MAX(sequence), 0) AS c FROM events WHERE conversation_id = ?",
      conversationId,
    )!.c;
    const tables = Object.fromEntries(EXPORT_TABLES.map((t) => [t, [] as Rows])) as Record<
      ExportTable,
      Rows
    >;
    tables.conversations = [conversation];
    tables.events = catalog.all(
      "SELECT * FROM events WHERE conversation_id = ? AND sequence <= ? ORDER BY sequence",
      conversationId,
      cutoff,
    );
    tables.tasks = catalog.all(
      "SELECT * FROM tasks WHERE conversation_id = ? ORDER BY created_at, id",
      conversationId,
    );
    tables.executions = catalog.all(
      "SELECT * FROM executions WHERE conversation_id = ? ORDER BY started_at, id",
      conversationId,
    );
    tables.tool_calls = catalog.all(
      "SELECT * FROM tool_calls WHERE conversation_id = ? ORDER BY created_at, id",
      conversationId,
    );
    tables.approvals = catalog.all(
      "SELECT a.* FROM approvals a JOIN tool_calls t ON t.id = a.tool_call_id WHERE t.conversation_id = ? ORDER BY a.requested_at, a.id",
      conversationId,
    );
    tables.commands = catalog.all(
      "SELECT * FROM commands WHERE conversation_id = ? ORDER BY received_at, id",
      conversationId,
    );
    tables.diagnostics = catalog.all(
      "SELECT * FROM diagnostics WHERE conversation_id = ? ORDER BY received_at, id",
      conversationId,
    );
    tables.artifact_links = catalog.all(
      "SELECT * FROM artifact_links WHERE conversation_id = ? ORDER BY id",
      conversationId,
    );
    const provenanceIds = new Set<string>([conversation.provenance_set_id as string]);
    for (const e of tables.executions)
      if (e.provenance_set_id) provenanceIds.add(e.provenance_set_id as string);
    const connectionIds = new Set<string>();
    for (const row of [...tables.events, ...tables.commands, ...tables.diagnostics])
      if (row.client_connection_id) connectionIds.add(row.client_connection_id as string);
    tables.client_connections = [...connectionIds]
      .map((id) => catalog.get("SELECT * FROM client_connections WHERE id = ?", id))
      .filter((r): r is Record<string, unknown> => r !== undefined);
    for (const c of tables.client_connections)
      if (c.provenance_set_id) provenanceIds.add(c.provenance_set_id as string);
    const clientIds = new Set<string>();
    for (const row of [
      ...tables.tasks,
      ...tables.client_connections,
      ...tables.diagnostics,
      ...tables.events,
    ])
      if (row.client_id) clientIds.add(row.client_id as string);
    tables.clients = [...clientIds]
      .map((id) => catalog.get("SELECT * FROM clients WHERE id = ?", id))
      .filter((r): r is Record<string, unknown> => r !== undefined);
    tables.provenance_sets = [...provenanceIds]
      .map((id) => catalog.get("SELECT * FROM provenance_sets WHERE id = ?", id))
      .filter((r): r is Record<string, unknown> => r !== undefined);
    tables.provenance_entries = [...provenanceIds].flatMap((id) =>
      catalog.all<Record<string, unknown>>(
        "SELECT * FROM provenance_entries WHERE provenance_set_id = ? ORDER BY role, ordinal",
        id,
      ),
    );

    // Artifact closure: linked artifacts + provenance artifacts + dependency closure (cycle-safe).
    const unresolved: ConversationSnapshot["unresolved_references"] = [];
    const closure = new Set<string>();
    const queue: string[] = [];
    for (const l of tables.artifact_links) queue.push(l.artifact_id as string);
    for (const p of tables.provenance_entries)
      if (p.artifact_id) queue.push(p.artifact_id as string);
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (closure.has(id)) continue;
      const art = catalog.get("SELECT * FROM artifacts WHERE id = ?", id);
      if (!art) {
        unresolved.push({ table: "artifacts", id, reason: "referenced artifact row missing" });
        continue;
      }
      closure.add(id);
      tables.artifacts.push(art);
      for (const dep of catalog.all(
        "SELECT * FROM artifact_dependencies WHERE parent_artifact_id = ?",
        id,
      )) {
        tables.artifact_dependencies.push(dep);
        queue.push(dep.required_artifact_id as string);
      }
    }
    const digests = new Set<string>();
    for (const a of tables.artifacts) if (a.object_digest) digests.add(a.object_digest as string);
    tables.objects = [...digests]
      .map((d) => catalog.get("SELECT * FROM objects WHERE digest = ?", d))
      .filter((r): r is Record<string, unknown> => r !== undefined);
    for (const d of digests)
      if (!tables.objects.some((o) => o.digest === d))
        unresolved.push({
          table: "objects",
          id: d,
          reason: "object row missing for artifact digest",
        });
    // Links from other conversations to shared artifacts are deliberately not traversed.
    const ongoing = tables.tasks
      .filter(
        (t) =>
          !["completed", "failed", "interrupted", "outcome_unknown"].includes(t.status as string),
      )
      .map((t) => t.id as string);
    return {
      conversation_id: conversationId,
      captured_at: new Date().toISOString(),
      cutoff_sequence: cutoff,
      tables,
      artifact_closure: [...closure],
      unresolved_references: unresolved,
      ongoing_tasks: ongoing,
    };
  } finally {
    db.exec("COMMIT");
  }
}

/** Derived, readable view used by the report and the CLI. */
export interface TaskView {
  id: string;
  status: string;
  created_at: string;
  finished_at: string | null;
  text: string;
  assistant_text: string;
  partial: boolean;
  executions: Rows;
  tool_calls: Array<Record<string, unknown> & { approvals: Rows }>;
  events: Rows;
  interruption: Record<string, unknown> | null;
  errors: Rows;
}

export function taskViews(snapshot: ConversationSnapshot): TaskView[] {
  const { tables } = snapshot;
  return tables.tasks.map((task) => {
    const events = tables.events.filter((e) => e.task_id === task.id);
    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (JSON.parse(e.payload as string) as { text: string }).text)
      .join("");
    const interruption = events.find((e) => e.type === "interruption_outcome");
    return {
      id: task.id as string,
      status: task.status as string,
      created_at: task.created_at as string,
      finished_at: (task.finished_at as string | null) ?? null,
      text: task.text as string,
      assistant_text: text,
      partial: task.status !== "completed",
      executions: tables.executions.filter((e) => e.task_id === task.id),
      tool_calls: tables.tool_calls
        .filter((c) => c.task_id === task.id)
        .map((c) => ({ ...c, approvals: tables.approvals.filter((a) => a.tool_call_id === c.id) })),
      events,
      interruption: interruption
        ? (JSON.parse(interruption.payload as string) as Record<string, unknown>)
        : null,
      errors: events.filter(
        (e) => e.type === "error" || e.type === "runtime_stderr" || e.type === "malformed_event",
      ),
    };
  });
}

export interface DiagnosticsView {
  client_id: string;
  connection_id: string | null;
  captured_at: string;
  received_at: string;
  freshness: "current" | "stale" | "disconnected";
  state: unknown;
}

export function diagnosticsViews(
  snapshot: ConversationSnapshot,
  now = Date.now(),
  staleMs = 60_000,
): DiagnosticsView[] {
  const connections = new Map(snapshot.tables.client_connections.map((c) => [c.id as string, c]));
  return snapshot.tables.diagnostics.map((d) => {
    const conn = d.client_connection_id
      ? connections.get(d.client_connection_id as string)
      : undefined;
    const disconnected = conn?.disconnected_at != null;
    const age = now - Date.parse(d.received_at as string);
    return {
      client_id: d.client_id as string,
      connection_id: (d.client_connection_id as string | null) ?? null,
      captured_at: d.captured_at as string,
      received_at: d.received_at as string,
      freshness: disconnected ? "disconnected" : age > staleMs ? "stale" : "current",
      state: JSON.parse(d.state as string),
    };
  });
}
