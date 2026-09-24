import { join } from "node:path";
import { match, P } from "ts-pattern";
import { z } from "zod";
import {
  canonicalDigest,
  ErrorCodeSchema,
  ErrorDispositionSchema,
  redactString,
  redactValue,
  type ApprovalStatus,
  type ClientCommand,
  type Effort,
  type TaskStatus,
  type ToolCallPolicy,
  type ToolCallStatus,
} from "@mia/protocol";
import { Catalog, newId, nowIso } from "./catalog.ts";
import { ObjectStore, type StoredObject } from "./objects.ts";
import type {
  ArtifactKind,
  CaptureStatus,
  ClientKind,
  CommandReply,
  CommandRow,
  ConversationStatus,
  DependencyRelation,
  ExecutionStatus,
  JournalEventType,
  LinkRelation,
  ProvenanceEntryRow,
  ProvenanceRole,
} from "./schema.ts";

/** What recording a command found: a new command to run, or what to answer a reused message_id with. */
export type RecordedCommand =
  | { kind: "new"; commandId: string }
  /** The message_id was used before with a different payload. */
  | { kind: "conflict" }
  /**
   * The message_id was recorded but no reply can be read back for it: it never finished, or its stored reply
   * is unreadable. Either way its outcome is unknown.
   */
  | { kind: "unfinished"; commandId: string }
  | { kind: "duplicate"; reply: CommandReply };

/** A stored `result`: JSON text of an object, or a reply that cannot be read back. */
const StoredResultSchema = z.string().transform((text, ctx) => {
  try {
    return z.record(z.string(), z.unknown()).parse(JSON.parse(text));
  } catch {
    ctx.addIssue({ code: "custom", message: "stored result is not a JSON object" });
    return z.NEVER;
  }
});

/** A stored command row, validated at the SQLite boundary. */
const StoredCommandSchema = z.discriminatedUnion("disposition", [
  z.object({ disposition: z.literal("received") }),
  z.object({ disposition: z.literal("accepted"), result: StoredResultSchema.nullable() }),
  z.object({
    disposition: ErrorDispositionSchema,
    error_code: ErrorCodeSchema,
    error_message: z.string(),
  }),
]);

/** The reply stored for a command, or null when it has none that can be read back. */
const storedReply = (row: unknown): CommandReply | null => {
  const parsed = StoredCommandSchema.safeParse(row);
  if (!parsed.success) return null;
  return match(parsed.data)
    .with({ disposition: "received" }, () => null)
    .with({ disposition: "accepted" }, ({ result }): CommandReply => ({
      disposition: "accepted",
      result,
    }))
    .with(
      { disposition: P.not("accepted") },
      ({ disposition, error_code, error_message }): CommandReply => ({
        disposition,
        error: { code: error_code, message: error_message },
      }),
    )
    .exhaustive();
};

export interface EventInput {
  /** Given by the caller (see RecordWriter). */
  id: string;
  conversationId: string;
  type: JournalEventType;
  payload: unknown;
  taskId?: string | null;
  executionId?: string | null;
  clientId?: string | null;
  clientConnectionId?: string | null;
  causedByEventId?: string | null;
  producerId?: string | null;
  producerEventId?: string | null;
  capturedAt?: string | null;
  durationMs?: number | null;
  timingSource?: string | null;
}

export interface AppendedEvent {
  id: string;
  sequence: number;
  receivedAt: string;
}

/**
 * What was captured for an artifact: the object its bytes were already stored as (`ObjectStore.put`), so
 * registering it does no file I/O, or why nothing was retained.
 */
export type ArtifactCapture =
  | { stored: StoredObject }
  | { captureStatus: Exclude<CaptureStatus, "retained">; captureReason: string };

export type ArtifactInput = ArtifactCapture & {
  kind: ArtifactKind;
  logicalName: string;
  mimeType?: string | null;
  schemaVersion?: string | null;
  producerExecutionId?: string | null;
  producerEventId?: string | null;
  originalPath?: string | null;
  externalLocator?: string | null;
  redaction?: string | null;
};

export interface LinkInput {
  conversationId: string;
  artifactId: string;
  relation: LinkRelation;
  taskId?: string | null;
  eventId?: string | null;
  toolCallId?: string | null;
  diagnosticId?: string | null;
  provenanceSetId?: string | null;
}

/** What a finished turn cost; stored in the execution's `usage` column under snake_case keys. */
export interface ExecutionUsage {
  /** The runtime's own token accounting, kept as reported. */
  usage?: unknown;
  totalCostUsd?: number;
  durationMs?: number;
  durationApiMs?: number;
  numTurns?: number;
}

/**
 * All writes to the private catalog go through here. Payloads are redacted before persistence.
 * Callers wrap related writes in catalog.transaction so events and state rows commit together.
 *
 * The rows a state transition creates and refers to within one transaction (conversations, tasks, executions,
 * tool calls, approvals and events) take their id from the caller, so a transition can name a record before it
 * is written: an approval_requested event carries its approval's id, and the approval row its requesting event's.
 * Callers generate them with `newId`; a reused id fails the insert, and with it the transaction. The other rows
 * (commands, provenance, artifacts, links, diagnostics) are still named here, which holds only while whatever
 * refers to one is written after it in the same transaction, as a conversation names its provenance set and an
 * artifact_registered event its artifact.
 */
export class RecordWriter {
  readonly objects: ObjectStore;

  constructor(readonly catalog: Catalog) {
    this.objects = new ObjectStore(catalog.paths);
  }

  // ---- clients & connections ----

  ensureClient(clientId: string, kind: ClientKind): void {
    const existing = this.catalog.get("SELECT id FROM clients WHERE id = ?", clientId);
    if (!existing) this.catalog.insert("clients", { id: clientId, first_seen_at: nowIso(), kind });
  }

  openConnection(input: {
    connectionId: string;
    clientId: string;
    build: unknown;
    provenanceSetId?: string | null;
  }): void {
    this.catalog.insert("client_connections", {
      id: input.connectionId,
      client_id: input.clientId,
      build: JSON.stringify(redactValue(input.build ?? null)),
      provenance_set_id: input.provenanceSetId ?? null,
      connected_at: nowIso(),
      last_received_at: nowIso(),
    });
  }

  touchConnection(connectionId: string): void {
    this.catalog.update("client_connections", connectionId, { last_received_at: nowIso() });
  }

  closeConnection(connectionId: string): void {
    this.catalog.update("client_connections", connectionId, { disconnected_at: nowIso() });
  }

  // ---- commands ----

  /**
   * Record a command before it runs, keyed by the client's own identity so a resend on a new connection
   * finds it. A message_id the client already used returns what was stored for it instead.
   */
  recordCommand(input: {
    connectionId: string;
    clientId: string;
    clientCommandId: string;
    type: ClientCommand["type"];
    payload: unknown;
    conversationId?: string | null;
  }): RecordedCommand {
    const digest = canonicalDigest(input.payload);
    const existing = this.catalog.get<
      Pick<
        CommandRow,
        "id" | "type" | "payload_digest" | "disposition" | "error_code" | "error_message" | "result"
      >
    >(
      "SELECT id, type, payload_digest, disposition, error_code, error_message, result FROM commands WHERE client_id = ? AND client_command_id = ?",
      input.clientId,
      input.clientCommandId,
    );
    if (existing) {
      if (existing.payload_digest !== digest || existing.type !== input.type)
        return { kind: "conflict" };
      const reply = storedReply(existing);
      return reply === null
        ? { kind: "unfinished", commandId: existing.id }
        : { kind: "duplicate", reply };
    }
    const id = newId("cmd");
    this.catalog.insert("commands", {
      id,
      conversation_id: input.conversationId ?? null,
      client_id: input.clientId,
      client_connection_id: input.connectionId,
      client_command_id: input.clientCommandId,
      type: input.type,
      payload_digest: digest,
      disposition: "received",
      received_at: nowIso(),
    });
    return { kind: "new", commandId: id };
  }

  /**
   * Store the reply a recorded command's ack carries, so a duplicate of it gets the same one. Like every other
   * write it is redacted first, so a duplicate never echoes a secret the original reply held. Only a command
   * still `received` moves: a late finish cannot overwrite a reply already stored, which duplicates may have
   * been answered with. Returns whether this reply was stored.
   */
  finishCommand(commandId: string, reply: CommandReply): boolean {
    return this.catalog.updateIf(
      "commands",
      match(reply)
        .with({ disposition: "accepted" }, ({ result }) => ({
          disposition: "accepted",
          result: result === null ? null : JSON.stringify(redactValue(result)),
        }))
        .with({ disposition: P.not("accepted") }, ({ disposition, error }) => ({
          disposition,
          error_code: error.code,
          error_message: redactString(error.message),
        }))
        .exhaustive(),
      { id: commandId, expected: { disposition: "received" } },
    );
  }

  // ---- provenance & artifacts ----

  createProvenanceSet(description: string): string {
    const id = newId("prov");
    this.catalog.insert("provenance_sets", { id, created_at: nowIso(), description });
    return id;
  }

  registerArtifact(input: ArtifactInput): {
    artifactId: string;
    digest: string | null;
    byteSize: number | null;
  } {
    const id = newId("art");
    const stored = "stored" in input ? input.stored : null;
    const capture: { capture_status: CaptureStatus; capture_reason: string | null } =
      "stored" in input
        ? { capture_status: "retained", capture_reason: null }
        : { capture_status: input.captureStatus, capture_reason: input.captureReason };
    if (stored && !this.catalog.get("SELECT digest FROM objects WHERE digest = ?", stored.digest)) {
      this.catalog.insert("objects", {
        digest: stored.digest,
        byte_count: stored.byteCount,
        storage_key: stored.storageKey,
        integrity: "verified",
        created_at: nowIso(),
      });
    }
    this.catalog.insert("artifacts", {
      id,
      kind: input.kind,
      mime_type: input.mimeType ?? null,
      schema_version: input.schemaVersion ?? null,
      logical_name: input.logicalName,
      created_at: nowIso(),
      producer_execution_id: input.producerExecutionId ?? null,
      producer_event_id: input.producerEventId ?? null,
      object_digest: stored?.digest ?? null,
      byte_size: stored?.byteCount ?? null,
      ...capture,
      external_locator: input.externalLocator ?? null,
      redaction: input.redaction ?? null,
      original_path: input.originalPath ?? null,
    });
    return { artifactId: id, digest: stored?.digest ?? null, byteSize: stored?.byteCount ?? null };
  }

  addProvenanceEntry(input: {
    provenanceSetId: string;
    role: ProvenanceRole;
    ordinal?: number;
    version?: string | null;
    artifactId?: string | null;
    availability: ProvenanceEntryRow["availability"];
    reason?: string | null;
  }): string {
    const id = newId("pe");
    this.catalog.insert("provenance_entries", {
      id,
      provenance_set_id: input.provenanceSetId,
      role: input.role,
      ordinal: input.ordinal ?? 0,
      version: input.version ?? null,
      artifact_id: input.artifactId ?? null,
      availability: input.availability,
      reason: input.reason ?? null,
    });
    return id;
  }

  linkArtifact(input: LinkInput): string {
    const id = newId("link");
    this.catalog.insert("artifact_links", {
      id,
      conversation_id: input.conversationId,
      artifact_id: input.artifactId,
      relation: input.relation,
      task_id: input.taskId ?? null,
      event_id: input.eventId ?? null,
      tool_call_id: input.toolCallId ?? null,
      diagnostic_id: input.diagnosticId ?? null,
      provenance_set_id: input.provenanceSetId ?? null,
    });
    return id;
  }

  addDependency(
    parentArtifactId: string,
    requiredArtifactId: string,
    relation: DependencyRelation,
  ): void {
    this.catalog.insert("artifact_dependencies", {
      parent_artifact_id: parentArtifactId,
      required_artifact_id: requiredArtifactId,
      relation,
    });
  }

  /** Link every artifact referenced by a provenance set into a conversation (shared snapshots get a link per conversation). */
  linkProvenanceSet(conversationId: string, provenanceSetId: string): void {
    const entries = this.catalog.all<{ artifact_id: string }>(
      "SELECT artifact_id FROM provenance_entries WHERE provenance_set_id = ? AND artifact_id IS NOT NULL",
      provenanceSetId,
    );
    for (const entry of entries)
      this.linkArtifact({
        conversationId,
        artifactId: entry.artifact_id,
        relation: "provenance",
        provenanceSetId,
      });
  }

  // ---- conversations, tasks, executions ----

  /**
   * Records a conversation and names its directory without creating it, so recording one does no file I/O; whoever
   * first writes into the directory creates it.
   */
  createConversation(input: {
    id: string;
    provenanceSetId: string;
    runtimeConversationId: string;
  }): {
    startedAt: string;
    directory: string;
  } {
    const { id } = input;
    const startedAt = nowIso();
    const directory = join(
      this.catalog.paths.conversations,
      `${startedAt.replace(/[:.]/g, "-")}_${id}`,
    );
    this.catalog.insert("conversations", {
      id,
      started_at: startedAt,
      status: "active",
      provenance_set_id: input.provenanceSetId,
      directory,
      runtime_conversation_id: input.runtimeConversationId,
    });
    return { startedAt, directory };
  }

  updateConversation(id: string, fields: { status?: ConversationStatus }): void {
    this.catalog.update("conversations", id, { status: fields.status });
  }

  createTask(input: {
    id: string;
    conversationId: string;
    text: string;
    clientId: string | null;
  }): void {
    this.catalog.insert("tasks", {
      id: input.id,
      conversation_id: input.conversationId,
      status: "running",
      created_at: nowIso(),
      text: redactString(input.text),
      client_id: input.clientId,
    });
  }

  updateTask(id: string, fields: { status?: TaskStatus; finishedAt?: string | null }): void {
    this.catalog.update("tasks", id, { status: fields.status, finished_at: fields.finishedAt });
  }

  createExecution(input: {
    id: string;
    taskId: string;
    conversationId: string;
    runtimeIdentity: string;
    runtimeConversationId: string;
    requestedModel: string;
    requestedEffort: Effort;
    provenanceSetId: string | null;
    executionEpoch: number;
  }): void {
    this.catalog.insert("executions", {
      id: input.id,
      task_id: input.taskId,
      conversation_id: input.conversationId,
      runtime_identity: input.runtimeIdentity,
      runtime_conversation_id: input.runtimeConversationId,
      requested_model: input.requestedModel,
      requested_effort: input.requestedEffort,
      provenance_set_id: input.provenanceSetId,
      execution_epoch: input.executionEpoch,
      status: "running",
      started_at: nowIso(),
    });
  }

  updateExecution(
    id: string,
    fields: {
      status?: ExecutionStatus;
      endedAt?: string | null;
      reportedModel?: string | null;
      // eslint-disable-next-line no-restricted-syntax -- whatever the runtime reported, kept as reported
      reportedEffort?: string | null;
      effortEvidence?: unknown;
      usage?: ExecutionUsage;
    },
  ): void {
    this.catalog.update("executions", id, {
      status: fields.status,
      ended_at: fields.endedAt,
      reported_model: fields.reportedModel,
      reported_effort: fields.reportedEffort,
      effort_evidence:
        fields.effortEvidence === undefined
          ? undefined
          : JSON.stringify(redactValue(fields.effortEvidence)),
      usage:
        fields.usage === undefined
          ? undefined
          : JSON.stringify(
              redactValue({
                usage: fields.usage.usage,
                total_cost_usd: fields.usage.totalCostUsd,
                duration_ms: fields.usage.durationMs,
                duration_api_ms: fields.usage.durationApiMs,
                num_turns: fields.usage.numTurns,
              }),
            ),
    });
  }

  // ---- events ----

  appendEvent(input: EventInput): AppendedEvent {
    const { id } = input;
    const receivedAt = nowIso();
    const sequence = this.catalog.nextSequence(input.conversationId);
    this.catalog.insert("events", {
      id,
      conversation_id: input.conversationId,
      sequence,
      type: input.type,
      payload_version: 1,
      payload: JSON.stringify(redactValue(input.payload) ?? null),
      task_id: input.taskId ?? null,
      execution_id: input.executionId ?? null,
      client_id: input.clientId ?? null,
      client_connection_id: input.clientConnectionId ?? null,
      caused_by_event_id: input.causedByEventId ?? null,
      producer_id: input.producerId ?? null,
      producer_event_id: input.producerEventId ?? null,
      captured_at: input.capturedAt ?? null,
      received_at: receivedAt,
      duration_ms: input.durationMs ?? null,
      timing_source: input.timingSource ?? null,
    });
    return { id, sequence, receivedAt };
  }

  // ---- tool calls & approvals ----

  createToolCall(input: {
    id: string;
    conversationId: string;
    taskId: string;
    executionId: string;
    runtimeCallId: string;
    bindingRevision: number;
    toolIdentity: string;
    argumentDigest: string;
    redactedArguments: unknown;
    policy: ToolCallPolicy;
    status: ToolCallStatus;
    proposalEventId: string | null;
  }): void {
    const now = nowIso();
    this.catalog.insert("tool_calls", {
      id: input.id,
      conversation_id: input.conversationId,
      task_id: input.taskId,
      execution_id: input.executionId,
      runtime_call_id: input.runtimeCallId,
      binding_revision: input.bindingRevision,
      tool_identity: input.toolIdentity,
      argument_digest: input.argumentDigest,
      redacted_arguments: JSON.stringify(input.redactedArguments ?? null),
      policy: input.policy,
      status: input.status,
      proposal_event_id: input.proposalEventId,
      created_at: now,
      updated_at: now,
    });
  }

  updateToolCall(
    id: string,
    fields: {
      status?: ToolCallStatus;
      detail?: string | null;
      dispatchEventId?: string | null;
      resultEventId?: string | null;
      proposalEventId?: string | null;
    },
  ): void {
    this.catalog.update("tool_calls", id, {
      status: fields.status,
      detail: fields.detail,
      dispatch_event_id: fields.dispatchEventId,
      result_event_id: fields.resultEventId,
      proposal_event_id: fields.proposalEventId,
      updated_at: nowIso(),
    });
  }

  createApproval(input: {
    id: string;
    toolCallId: string;
    executionEpoch: number;
    requestingEventId: string | null;
  }): void {
    this.catalog.insert("approvals", {
      id: input.id,
      tool_call_id: input.toolCallId,
      execution_epoch: input.executionEpoch,
      status: "pending",
      requesting_event_id: input.requestingEventId,
      requested_at: nowIso(),
    });
  }

  updateApproval(
    id: string,
    fields: {
      status: Exclude<ApprovalStatus, "pending">;
      reason?: string | null;
      decisionEventId?: string | null;
      decisionClientId?: string | null;
    },
  ): void {
    this.catalog.update("approvals", id, {
      status: fields.status,
      reason: fields.reason,
      decision_event_id: fields.decisionEventId,
      decision_client_id: fields.decisionClientId,
      consumed_at: nowIso(),
    });
  }

  // ---- diagnostics ----

  recordDiagnostics(input: {
    conversationId: string | null;
    clientId: string;
    clientConnectionId: string | null;
    taskId?: string | null;
    eventId: string | null;
    capturedAt: string;
    state: unknown;
  }): string {
    const id = newId("diag");
    this.catalog.insert("diagnostics", {
      id,
      conversation_id: input.conversationId,
      client_id: input.clientId,
      client_connection_id: input.clientConnectionId,
      task_id: input.taskId ?? null,
      event_id: input.eventId,
      captured_at: input.capturedAt,
      received_at: nowIso(),
      state: JSON.stringify(redactValue(input.state)),
    });
    return id;
  }
}
