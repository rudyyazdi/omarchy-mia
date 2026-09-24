import { z } from "zod";
import type {
  AckDisposition,
  AckError,
  ApprovalStatus,
  ClientCommand,
  Effort,
  ErrorCode,
  ErrorDisposition,
  ServerEventType,
  TaskStatus,
  ToolCallPolicy,
  ToolCallStatus,
} from "@mia/protocol";

export const SCHEMA_VERSION = 2;

/** Logical records from docs/D1/CONVERSATION-RECORDS.md. Foreign keys are enforced per connection (see catalog.ts). */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS objects (
  digest TEXT PRIMARY KEY,
  byte_count INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  integrity TEXT NOT NULL CHECK (integrity IN ('verified','missing','corrupt')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provenance_sets (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  mime_type TEXT,
  schema_version TEXT,
  logical_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  producer_execution_id TEXT,
  producer_event_id TEXT,
  object_digest TEXT REFERENCES objects(digest),
  byte_size INTEGER,
  capture_status TEXT NOT NULL CHECK (capture_status IN ('retained','pending','external_only','missing','failed')),
  external_locator TEXT,
  capture_reason TEXT,
  redaction TEXT,
  original_path TEXT
);
CREATE INDEX IF NOT EXISTS artifacts_object_digest ON artifacts(object_digest);

CREATE TABLE IF NOT EXISTS provenance_entries (
  id TEXT PRIMARY KEY,
  provenance_set_id TEXT NOT NULL REFERENCES provenance_sets(id),
  role TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  version TEXT,
  artifact_id TEXT REFERENCES artifacts(id),
  availability TEXT NOT NULL CHECK (availability IN ('retained','unavailable')),
  reason TEXT,
  UNIQUE(provenance_set_id, role, ordinal)
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  status TEXT NOT NULL,
  provenance_set_id TEXT NOT NULL REFERENCES provenance_sets(id),
  directory TEXT NOT NULL,
  runtime_conversation_id TEXT
);
CREATE INDEX IF NOT EXISTS conversations_started ON conversations(started_at, id);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  kind TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS client_connections (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  build TEXT,
  provenance_set_id TEXT REFERENCES provenance_sets(id),
  connected_at TEXT NOT NULL,
  disconnected_at TEXT,
  last_received_at TEXT
);
CREATE INDEX IF NOT EXISTS client_connections_client ON client_connections(client_id, connected_at, id);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  text TEXT NOT NULL,
  client_id TEXT REFERENCES clients(id),
  UNIQUE(conversation_id, id)
);
CREATE INDEX IF NOT EXISTS tasks_conversation ON tasks(conversation_id, created_at, id);

CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  runtime_identity TEXT NOT NULL,
  runtime_conversation_id TEXT,
  requested_model TEXT NOT NULL,
  reported_model TEXT,
  requested_effort TEXT NOT NULL,
  reported_effort TEXT,
  effort_evidence TEXT,
  provenance_set_id TEXT REFERENCES provenance_sets(id),
  execution_epoch INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  usage TEXT,
  FOREIGN KEY(conversation_id, task_id) REFERENCES tasks(conversation_id, id)
);
CREATE INDEX IF NOT EXISTS executions_task ON executions(task_id, started_at, id);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_version INTEGER NOT NULL DEFAULT 1,
  payload TEXT NOT NULL,
  task_id TEXT,
  execution_id TEXT,
  client_id TEXT,
  client_connection_id TEXT,
  caused_by_event_id TEXT REFERENCES events(id),
  producer_id TEXT,
  producer_event_id TEXT,
  captured_at TEXT,
  received_at TEXT NOT NULL,
  duration_ms INTEGER,
  timing_source TEXT,
  UNIQUE(conversation_id, sequence)
);
CREATE INDEX IF NOT EXISTS events_task ON events(task_id, sequence);
CREATE INDEX IF NOT EXISTS events_execution ON events(execution_id, sequence);
CREATE INDEX IF NOT EXISTS events_type ON events(conversation_id, type, sequence);
CREATE UNIQUE INDEX IF NOT EXISTS events_producer ON events(producer_id, producer_event_id) WHERE producer_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_caused_by ON events(caused_by_event_id);

CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  client_id TEXT NOT NULL REFERENCES clients(id),
  client_connection_id TEXT NOT NULL REFERENCES client_connections(id),
  client_command_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('received','accepted','rejected','failed')),
  error_code TEXT,
  error_message TEXT,
  result TEXT,
  result_event_id TEXT REFERENCES events(id),
  received_at TEXT NOT NULL,
  CHECK ((error_code IS NULL) = (error_message IS NULL)),
  CHECK ((disposition IN ('rejected','failed')) = (error_code IS NOT NULL)),
  CHECK (result IS NULL OR (disposition = 'accepted' AND json_valid(result))),
  UNIQUE(client_id, client_command_id)
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  execution_id TEXT NOT NULL REFERENCES executions(id),
  runtime_call_id TEXT NOT NULL,
  binding_revision INTEGER NOT NULL,
  tool_identity TEXT NOT NULL,
  argument_digest TEXT NOT NULL,
  redacted_arguments TEXT NOT NULL,
  policy TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  proposal_event_id TEXT REFERENCES events(id),
  dispatch_event_id TEXT REFERENCES events(id),
  result_event_id TEXT REFERENCES events(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(execution_id, runtime_call_id, binding_revision),
  FOREIGN KEY(conversation_id, task_id) REFERENCES tasks(conversation_id, id)
);
CREATE INDEX IF NOT EXISTS tool_calls_task ON tool_calls(task_id, proposal_event_id);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  tool_call_id TEXT NOT NULL REFERENCES tool_calls(id),
  execution_epoch INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','invalidated','expired')),
  reason TEXT,
  requesting_event_id TEXT REFERENCES events(id),
  decision_event_id TEXT REFERENCES events(id),
  decision_client_id TEXT,
  requested_at TEXT NOT NULL,
  consumed_at TEXT,
  UNIQUE(tool_call_id, execution_epoch)
);
CREATE INDEX IF NOT EXISTS approvals_pending ON approvals(status, id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS diagnostics (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  client_connection_id TEXT REFERENCES client_connections(id),
  task_id TEXT,
  event_id TEXT REFERENCES events(id),
  captured_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  base_snapshot_id TEXT REFERENCES diagnostics(id),
  state TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS diagnostics_lookup ON diagnostics(conversation_id, client_id, received_at, id);

CREATE TABLE IF NOT EXISTS artifact_links (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  relation TEXT NOT NULL CHECK (relation IN ('provenance','task_output','event_payload','tool_result','diagnostic','runtime_transcript','client_build','agent_prompt')),
  task_id TEXT,
  event_id TEXT REFERENCES events(id),
  tool_call_id TEXT REFERENCES tool_calls(id),
  diagnostic_id TEXT REFERENCES diagnostics(id),
  provenance_set_id TEXT REFERENCES provenance_sets(id),
  CHECK (relation <> 'provenance' OR provenance_set_id IS NOT NULL),
  CHECK (relation <> 'task_output' OR task_id IS NOT NULL),
  CHECK (relation <> 'event_payload' OR event_id IS NOT NULL),
  CHECK (relation <> 'tool_result' OR tool_call_id IS NOT NULL),
  CHECK (relation <> 'diagnostic' OR diagnostic_id IS NOT NULL),
  CHECK (relation <> 'runtime_transcript' OR task_id IS NOT NULL),
  FOREIGN KEY(conversation_id, task_id) REFERENCES tasks(conversation_id, id)
);
CREATE INDEX IF NOT EXISTS artifact_links_conversation ON artifact_links(conversation_id, artifact_id);
CREATE INDEX IF NOT EXISTS artifact_links_artifact ON artifact_links(artifact_id, conversation_id);
CREATE INDEX IF NOT EXISTS artifact_links_task ON artifact_links(task_id, artifact_id);
CREATE INDEX IF NOT EXISTS artifact_links_event ON artifact_links(event_id, artifact_id);

CREATE TABLE IF NOT EXISTS artifact_dependencies (
  parent_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  required_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  relation TEXT NOT NULL,
  UNIQUE(parent_artifact_id, required_artifact_id, relation)
);
CREATE INDEX IF NOT EXISTS artifact_dependencies_required ON artifact_dependencies(required_artifact_id, parent_artifact_id);
`;

/** Tables exported as records/<table>.jsonl, in dependency order. */
export const EXPORT_TABLES = [
  "objects",
  "provenance_sets",
  "artifacts",
  "provenance_entries",
  "conversations",
  "clients",
  "client_connections",
  "tasks",
  "executions",
  "events",
  "commands",
  "tool_calls",
  "approvals",
  "diagnostics",
  "artifact_links",
  "artifact_dependencies",
] as const;
export type ExportTable = (typeof EXPORT_TABLES)[number];

// ---- row types ----
// One interface per table, mirroring the SQL columns above (so snake_case) with their nullability.
// Catalog.get<T>/Catalog.all<T> name the row type at the SQLite boundary; nothing downstream casts.

export type ConversationStatus = "active" | "closed";
export type ExecutionStatus = "running" | "completed" | "failed" | "killed";
export type ClientKind = "text-client";
/**
 * `received` is the pending state between recording a command and finishing it; the others are the outcome
 * its ack reported, stored so a duplicate gets the same reply.
 */
export type CommandDisposition = "received" | AckDisposition;
/** The reply a finished command's ack carried: what a duplicate of it is answered with. */
export type CommandReply =
  | { disposition: "accepted"; result: Record<string, unknown> | null }
  | { disposition: ErrorDisposition; error: AckError };
export type ArtifactKind = "snapshot" | "tool_output" | "runtime_transcript" | "effort_evidence";
/** What ObjectStore.verify found on disk for a digest. */
export type ObjectIntegrity = "verified" | "missing" | "corrupt";
/**
 * Every event type the journal holds: the client protocol's events plus the internal and runtime evidence the
 * engine records without sending it to a client.
 */
export type JournalEventType =
  | ServerEventType
  | "provenance_recorded"
  | "captured_in_debug_mode"
  | "task_submitted"
  | "client_diagnostics"
  | "client_disconnected"
  | "tool_dispatched"
  | "tool_proposal_started"
  | "tool_proposed"
  | "tool_result"
  | "tool_result_unmatched"
  | "mcp_request"
  | "mcp_response"
  | "policy_evaluated"
  | "assistant_message"
  | "runtime_started"
  | "runtime_init"
  | "runtime_result"
  | "runtime_stderr"
  | "runtime_exit"
  | "artifact_registered";
export type ProvenanceRole =
  | "agent_prompt"
  | "runtime_instructions"
  | "configuration"
  | "tool_contracts"
  | "model_selection"
  | "runtime_identity"
  | "architecture"
  | "server_build"
  | "server_local_changes"
  | "client_build";

export interface ObjectRow {
  digest: string;
  byte_count: number;
  storage_key: string;
  integrity: ObjectIntegrity;
  created_at: string;
}

export interface ProvenanceSetRow {
  id: string;
  created_at: string;
  description: string | null;
}

export const CaptureStatusSchema = z.enum([
  "retained",
  "pending",
  "external_only",
  "missing",
  "failed",
]);
export type CaptureStatus = z.infer<typeof CaptureStatusSchema>;

export interface ArtifactRow {
  id: string;
  kind: ArtifactKind;
  mime_type: string | null;
  schema_version: string | null;
  logical_name: string;
  created_at: string;
  producer_execution_id: string | null;
  producer_event_id: string | null;
  object_digest: string | null;
  byte_size: number | null;
  capture_status: CaptureStatus;
  external_locator: string | null;
  capture_reason: string | null;
  redaction: string | null;
  original_path: string | null;
}

export interface ProvenanceEntryRow {
  id: string;
  provenance_set_id: string;
  role: ProvenanceRole;
  ordinal: number;
  version: string | null;
  artifact_id: string | null;
  availability: "retained" | "unavailable";
  reason: string | null;
}

export interface ConversationRow {
  id: string;
  started_at: string;
  status: ConversationStatus;
  provenance_set_id: string;
  directory: string;
  runtime_conversation_id: string | null;
}

export interface ClientRow {
  id: string;
  first_seen_at: string;
  kind: ClientKind;
}

export interface ClientConnectionRow {
  id: string;
  client_id: string;
  build: string | null;
  provenance_set_id: string | null;
  connected_at: string;
  disconnected_at: string | null;
  last_received_at: string | null;
}

export interface TaskRow {
  id: string;
  conversation_id: string;
  status: TaskStatus;
  created_at: string;
  finished_at: string | null;
  text: string;
  client_id: string | null;
}

export interface ExecutionRow {
  id: string;
  task_id: string;
  conversation_id: string;
  runtime_identity: string;
  runtime_conversation_id: string | null;
  requested_model: string;
  reported_model: string | null;
  requested_effort: Effort;
  // eslint-disable-next-line no-restricted-syntax -- whatever effort level the runtime reported, kept as reported
  reported_effort: string | null;
  effort_evidence: string | null;
  provenance_set_id: string | null;
  execution_epoch: number;
  status: ExecutionStatus;
  started_at: string;
  ended_at: string | null;
  usage: string | null;
}

export interface EventRow {
  id: string;
  conversation_id: string;
  sequence: number;
  type: JournalEventType;
  payload_version: number;
  payload: string;
  task_id: string | null;
  execution_id: string | null;
  client_id: string | null;
  client_connection_id: string | null;
  caused_by_event_id: string | null;
  producer_id: string | null;
  producer_event_id: string | null;
  captured_at: string | null;
  received_at: string;
  duration_ms: number | null;
  timing_source: string | null;
}

export interface CommandRow {
  id: string;
  conversation_id: string | null;
  client_id: string;
  client_connection_id: string;
  client_command_id: string;
  type: ClientCommand["type"];
  payload_digest: string;
  disposition: CommandDisposition;
  error_code: ErrorCode | null;
  error_message: string | null;
  /** JSON object; only an accepted command has one. */
  result: string | null;
  result_event_id: string | null;
  received_at: string;
}

export interface ToolCallRow {
  id: string;
  conversation_id: string;
  task_id: string;
  execution_id: string;
  runtime_call_id: string;
  binding_revision: number;
  tool_identity: string;
  argument_digest: string;
  redacted_arguments: string;
  policy: ToolCallPolicy;
  status: ToolCallStatus;
  detail: string | null;
  proposal_event_id: string | null;
  dispatch_event_id: string | null;
  result_event_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApprovalRow {
  id: string;
  tool_call_id: string;
  execution_epoch: number;
  status: ApprovalStatus;
  reason: string | null;
  requesting_event_id: string | null;
  decision_event_id: string | null;
  decision_client_id: string | null;
  requested_at: string;
  consumed_at: string | null;
}

export interface DiagnosticsRow {
  id: string;
  conversation_id: string | null;
  client_id: string;
  client_connection_id: string | null;
  task_id: string | null;
  event_id: string | null;
  captured_at: string;
  received_at: string;
  base_snapshot_id: string | null;
  state: string;
}

export type LinkRelation =
  | "provenance"
  | "task_output"
  | "event_payload"
  | "tool_result"
  | "diagnostic"
  | "runtime_transcript"
  | "client_build"
  | "agent_prompt";

export interface ArtifactLinkRow {
  id: string;
  conversation_id: string;
  artifact_id: string;
  relation: LinkRelation;
  task_id: string | null;
  event_id: string | null;
  tool_call_id: string | null;
  diagnostic_id: string | null;
  provenance_set_id: string | null;
}

/** Why one artifact requires another: a build artifact requires the diff of its local changes. */
export type DependencyRelation = "local_changes";

export interface ArtifactDependencyRow {
  parent_artifact_id: string;
  required_artifact_id: string;
  relation: DependencyRelation;
}

/** The rows of every export table, keyed by table name; the shape of a conversation snapshot and of a verified export. */
export interface SnapshotTables {
  objects: ObjectRow[];
  provenance_sets: ProvenanceSetRow[];
  artifacts: ArtifactRow[];
  provenance_entries: ProvenanceEntryRow[];
  conversations: ConversationRow[];
  clients: ClientRow[];
  client_connections: ClientConnectionRow[];
  tasks: TaskRow[];
  executions: ExecutionRow[];
  events: EventRow[];
  commands: CommandRow[];
  tool_calls: ToolCallRow[];
  approvals: ApprovalRow[];
  diagnostics: DiagnosticsRow[];
  artifact_links: ArtifactLinkRow[];
  artifact_dependencies: ArtifactDependencyRow[];
}

export const emptySnapshotTables = (): SnapshotTables => ({
  objects: [],
  provenance_sets: [],
  artifacts: [],
  provenance_entries: [],
  conversations: [],
  clients: [],
  client_connections: [],
  tasks: [],
  executions: [],
  events: [],
  commands: [],
  tool_calls: [],
  approvals: [],
  diagnostics: [],
  artifact_links: [],
  artifact_dependencies: [],
});
