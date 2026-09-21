import { z } from "zod";
import { parseJson, type Catalog } from "./catalog.ts";
import {
  emptySnapshotTables,
  type ApprovalRow,
  type ArtifactDependencyRow,
  type ArtifactLinkRow,
  type ArtifactRow,
  type ClientConnectionRow,
  type ClientRow,
  type CommandRow,
  type ConversationRow,
  type DiagnosticsRow,
  type EventRow,
  type ExecutionRow,
  type ObjectRow,
  type ProvenanceEntryRow,
  type ProvenanceSetRow,
  type SnapshotTables,
  type TaskRow,
  type ToolCallRow,
} from "./schema.ts";

export type Rows = Record<string, unknown>[];

const isPresent = <T>(value: T | undefined): value is T => value !== undefined;

export interface ConversationSummary {
  id: string;
  started_at: string;
  status: string;
  task_count: number;
  last_sequence: number;
  runtime_conversation_id: string | null;
}

export const listConversations = (catalog: Catalog): ConversationSummary[] =>
  catalog.all<ConversationSummary>(`
    SELECT c.id, c.started_at, c.status, c.runtime_conversation_id,
      (SELECT COUNT(*) FROM tasks t WHERE t.conversation_id = c.id) AS task_count,
      (SELECT COALESCE(MAX(sequence), 0) FROM events e WHERE e.conversation_id = c.id) AS last_sequence
    FROM conversations c ORDER BY c.started_at DESC, c.id DESC`);

export interface UnresolvedReference {
  table: string;
  id: string;
  reason: string;
}

export interface ConversationSnapshot {
  conversation_id: string;
  captured_at: string;
  cutoff_sequence: number;
  tables: SnapshotTables;
  /** Artifact ids reachable from this conversation (links + dependency closure). */
  artifact_closure: string[];
  /** References to rows outside the closure, reported not traversed. */
  unresolved_references: UnresolvedReference[];
  ongoing_tasks: string[];
}

const FINISHED_TASK_STATUSES = new Set(["completed", "failed", "interrupted", "outcome_unknown"]);

/**
 * Read every record belonging to one conversation from a single SQLite read transaction, bounded by the
 * maximum committed event sequence at that moment. Later writes cannot leak into the result.
 */
export const snapshotConversation = (
  catalog: Catalog,
  conversationId: string,
): ConversationSnapshot => {
  const db = catalog.db;
  db.exec("BEGIN");
  try {
    const conversation = catalog.get<ConversationRow>(
      "SELECT * FROM conversations WHERE id = ?",
      conversationId,
    );
    if (!conversation) throw new Error(`conversation ${conversationId} not found`);
    const cutoff =
      catalog.get<{ cutoff: number }>(
        "SELECT COALESCE(MAX(sequence), 0) AS cutoff FROM events WHERE conversation_id = ?",
        conversationId,
      )?.cutoff ?? 0;
    const tables = emptySnapshotTables();
    tables.conversations = [conversation];
    tables.events = catalog.all<EventRow>(
      "SELECT * FROM events WHERE conversation_id = ? AND sequence <= ? ORDER BY sequence",
      conversationId,
      cutoff,
    );
    tables.tasks = catalog.all<TaskRow>(
      "SELECT * FROM tasks WHERE conversation_id = ? ORDER BY created_at, id",
      conversationId,
    );
    tables.executions = catalog.all<ExecutionRow>(
      "SELECT * FROM executions WHERE conversation_id = ? ORDER BY started_at, id",
      conversationId,
    );
    tables.tool_calls = catalog.all<ToolCallRow>(
      "SELECT * FROM tool_calls WHERE conversation_id = ? ORDER BY created_at, id",
      conversationId,
    );
    tables.approvals = catalog.all<ApprovalRow>(
      "SELECT a.* FROM approvals a JOIN tool_calls t ON t.id = a.tool_call_id WHERE t.conversation_id = ? ORDER BY a.requested_at, a.id",
      conversationId,
    );
    tables.commands = catalog.all<CommandRow>(
      "SELECT * FROM commands WHERE conversation_id = ? ORDER BY received_at, id",
      conversationId,
    );
    tables.diagnostics = catalog.all<DiagnosticsRow>(
      "SELECT * FROM diagnostics WHERE conversation_id = ? ORDER BY received_at, id",
      conversationId,
    );
    tables.artifact_links = catalog.all<ArtifactLinkRow>(
      "SELECT * FROM artifact_links WHERE conversation_id = ? ORDER BY id",
      conversationId,
    );
    const provenanceIds = new Set<string>([conversation.provenance_set_id]);
    for (const execution of tables.executions)
      if (execution.provenance_set_id) provenanceIds.add(execution.provenance_set_id);
    const connectionIds = new Set<string>();
    for (const row of [...tables.events, ...tables.commands, ...tables.diagnostics])
      if (row.client_connection_id) connectionIds.add(row.client_connection_id);
    tables.client_connections = connectionIds
      .values()
      .map((id) =>
        catalog.get<ClientConnectionRow>("SELECT * FROM client_connections WHERE id = ?", id),
      )
      .filter(isPresent)
      .toArray();
    for (const connection of tables.client_connections)
      if (connection.provenance_set_id) provenanceIds.add(connection.provenance_set_id);
    const clientIds = new Set<string>();
    for (const row of [
      ...tables.tasks,
      ...tables.client_connections,
      ...tables.diagnostics,
      ...tables.events,
    ])
      if (row.client_id) clientIds.add(row.client_id);
    tables.clients = clientIds
      .values()
      .map((id) => catalog.get<ClientRow>("SELECT * FROM clients WHERE id = ?", id))
      .filter(isPresent)
      .toArray();
    tables.provenance_sets = provenanceIds
      .values()
      .map((id) => catalog.get<ProvenanceSetRow>("SELECT * FROM provenance_sets WHERE id = ?", id))
      .filter(isPresent)
      .toArray();
    tables.provenance_entries = provenanceIds
      .values()
      .flatMap((id) =>
        catalog.all<ProvenanceEntryRow>(
          "SELECT * FROM provenance_entries WHERE provenance_set_id = ? ORDER BY role, ordinal",
          id,
        ),
      )
      .toArray();

    // Artifact closure: linked artifacts + provenance artifacts + dependency closure (cycle-safe).
    const unresolved: UnresolvedReference[] = [];
    const closure = new Set<string>();
    const queue: string[] = tables.artifact_links.map((link) => link.artifact_id);
    for (const entry of tables.provenance_entries)
      if (entry.artifact_id) queue.push(entry.artifact_id);
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      if (closure.has(id)) continue;
      const artifact = catalog.get<ArtifactRow>("SELECT * FROM artifacts WHERE id = ?", id);
      if (!artifact) {
        unresolved.push({ table: "artifacts", id, reason: "referenced artifact row missing" });
        continue;
      }
      closure.add(id);
      tables.artifacts.push(artifact);
      for (const dependency of catalog.all<ArtifactDependencyRow>(
        "SELECT * FROM artifact_dependencies WHERE parent_artifact_id = ?",
        id,
      )) {
        tables.artifact_dependencies.push(dependency);
        queue.push(dependency.required_artifact_id);
      }
    }
    const digests = new Set<string>();
    for (const artifact of tables.artifacts)
      if (artifact.object_digest) digests.add(artifact.object_digest);
    tables.objects = digests
      .values()
      .map((digest) => catalog.get<ObjectRow>("SELECT * FROM objects WHERE digest = ?", digest))
      .filter(isPresent)
      .toArray();
    for (const digest of digests)
      if (!tables.objects.some((object) => object.digest === digest))
        unresolved.push({
          table: "objects",
          id: digest,
          reason: "object row missing for artifact digest",
        });
    // Links from other conversations to shared artifacts are deliberately not traversed.
    const ongoing = tables.tasks
      .filter((task) => !FINISHED_TASK_STATUSES.has(task.status))
      .map((task) => task.id);
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
};

export type ToolCallView = ToolCallRow & { approvals: ApprovalRow[] };

/** Derived, readable view used by the report and the CLI. */
export interface TaskView {
  id: string;
  status: string;
  created_at: string;
  finished_at: string | null;
  text: string;
  assistant_text: string;
  partial: boolean;
  executions: ExecutionRow[];
  tool_calls: ToolCallView[];
  events: EventRow[];
  interruption: Record<string, unknown> | null;
  errors: EventRow[];
}

const ERROR_EVENT_TYPES = new Set(["error", "runtime_stderr", "malformed_event"]);

/** Shapes of stored payloads this view reads back. */
const TextDeltaPayload = z.object({ text: z.string() });
const JsonObject = z.record(z.string(), z.unknown());

export const taskViews = (snapshot: ConversationSnapshot): TaskView[] => {
  const { tables } = snapshot;
  return tables.tasks.map((task) => {
    const events = tables.events.filter((event) => event.task_id === task.id);
    const text = events
      .filter((event) => event.type === "text_delta")
      .map((event) => TextDeltaPayload.parse(parseJson(event.payload)).text)
      .join("");
    const interruption = events.find((event) => event.type === "interruption_outcome");
    return {
      id: task.id,
      status: task.status,
      created_at: task.created_at,
      finished_at: task.finished_at,
      text: task.text,
      assistant_text: text,
      partial: task.status !== "completed",
      executions: tables.executions.filter((execution) => execution.task_id === task.id),
      tool_calls: tables.tool_calls
        .filter((call) => call.task_id === task.id)
        .map((call) => ({
          ...call,
          approvals: tables.approvals.filter((approval) => approval.tool_call_id === call.id),
        })),
      events,
      interruption: interruption ? JsonObject.parse(parseJson(interruption.payload)) : null,
      errors: events.filter((event) => ERROR_EVENT_TYPES.has(event.type)),
    };
  });
};

export type Freshness = "current" | "stale" | "disconnected";

export interface DiagnosticsView {
  client_id: string;
  connection_id: string | null;
  captured_at: string;
  received_at: string;
  freshness: Freshness;
  state: unknown;
}

const freshnessOf = (options: {
  disconnected: boolean;
  ageMs: number;
  staleMs: number;
}): Freshness => {
  if (options.disconnected) return "disconnected";
  if (options.ageMs > options.staleMs) return "stale";
  return "current";
};

export const diagnosticsViews = (
  snapshot: ConversationSnapshot,
  now = Date.now(),
  staleMs = 60_000,
): DiagnosticsView[] => {
  const connections = new Map(
    snapshot.tables.client_connections.map((connection) => [connection.id, connection]),
  );
  return snapshot.tables.diagnostics.map((diagnostic) => {
    const connection = diagnostic.client_connection_id
      ? connections.get(diagnostic.client_connection_id)
      : undefined;
    const disconnected = connection?.disconnected_at != null;
    const ageMs = now - Date.parse(diagnostic.received_at);
    return {
      client_id: diagnostic.client_id,
      connection_id: diagnostic.client_connection_id,
      captured_at: diagnostic.captured_at,
      received_at: diagnostic.received_at,
      freshness: freshnessOf({ disconnected, ageMs, staleMs }),
      state: parseJson(diagnostic.state),
    };
  });
};
