import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { canonicalDigest, redactValue } from "@mia/protocol";
import { Catalog, newId, nowIso } from "./catalog.ts";
import { ObjectStore } from "./objects.ts";
import type { CaptureStatus, CommandRow, LinkRelation } from "./schema.ts";

export interface EventInput {
  conversationId: string;
  type: string;
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

export interface ArtifactInput {
  kind: string;
  logicalName: string;
  mimeType?: string | null;
  schemaVersion?: string | null;
  bytes?: Uint8Array | null;
  producerExecutionId?: string | null;
  producerEventId?: string | null;
  originalPath?: string | null;
  captureStatus?: CaptureStatus;
  externalLocator?: string | null;
  captureReason?: string | null;
  redaction?: string | null;
}

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

/**
 * All writes to the private catalog go through here. Payloads are redacted before persistence.
 * Callers wrap related writes in catalog.transaction so events and state rows commit together.
 */
export class RecordWriter {
  readonly objects: ObjectStore;

  constructor(readonly catalog: Catalog) {
    this.objects = new ObjectStore(catalog.paths);
  }

  // ---- clients & connections ----

  ensureClient(clientId: string, kind: string): void {
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

  /** Returns the existing disposition for a duplicate command ID, or null when the command is new (and recorded as accepted-pending). */
  recordCommand(input: {
    connectionId: string;
    clientId: string;
    clientCommandId: string;
    type: string;
    payload: unknown;
    conversationId?: string | null;
  }):
    | {
        duplicate: true;
        disposition: string;
        sameDigest: boolean;
        error: string | null;
        commandId: string;
      }
    | { duplicate: false; commandId: string } {
    const digest = canonicalDigest(input.payload);
    const existing = this.catalog.get<
      Pick<CommandRow, "id" | "payload_digest" | "disposition" | "error">
    >(
      "SELECT id, payload_digest, disposition, error FROM commands WHERE client_connection_id = ? AND client_command_id = ?",
      input.connectionId,
      input.clientCommandId,
    );
    if (existing) {
      return {
        duplicate: true,
        disposition: existing.disposition,
        sameDigest: existing.payload_digest === digest,
        error: existing.error,
        commandId: existing.id,
      };
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
      disposition: "accepted",
      received_at: nowIso(),
    });
    return { duplicate: false, commandId: id };
  }

  finishCommand(
    commandId: string,
    outcome: {
      disposition: "accepted" | "rejected";
      error: string | null;
      resultEventId: string | null;
    },
  ): void {
    this.catalog.update("commands", commandId, {
      disposition: outcome.disposition,
      error: outcome.error,
      result_event_id: outcome.resultEventId,
    });
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
    let digest: string | null = null;
    let byteSize: number | null = null;
    let status = input.captureStatus ?? (input.bytes ? "retained" : "missing");
    if (input.bytes) {
      const stored = this.objects.put(input.bytes);
      digest = stored.digest;
      byteSize = stored.byteCount;
      if (!this.catalog.get("SELECT digest FROM objects WHERE digest = ?", digest)) {
        this.catalog.insert("objects", {
          digest,
          byte_count: byteSize,
          storage_key: stored.storageKey,
          integrity: "verified",
          created_at: nowIso(),
        });
      }
      status = "retained";
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
      object_digest: digest,
      byte_size: byteSize,
      capture_status: status,
      external_locator: input.externalLocator ?? null,
      capture_reason: input.captureReason ?? null,
      redaction: input.redaction ?? null,
      original_path: input.originalPath ?? null,
    });
    return { artifactId: id, digest, byteSize };
  }

  addProvenanceEntry(input: {
    provenanceSetId: string;
    role: string;
    ordinal?: number;
    version?: string | null;
    artifactId?: string | null;
    availability: "retained" | "unavailable";
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

  addDependency(parentArtifactId: string, requiredArtifactId: string, relation: string): void {
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

  createConversation(input: { provenanceSetId: string; runtimeConversationId: string }): {
    id: string;
    startedAt: string;
    directory: string;
  } {
    const startedAt = nowIso();
    const id = newId("conv");
    const directory = join(
      this.catalog.paths.conversations,
      `${startedAt.replace(/[:.]/g, "-")}_${id}`,
    );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.catalog.insert("conversations", {
      id,
      started_at: startedAt,
      status: "active",
      provenance_set_id: input.provenanceSetId,
      directory,
      runtime_conversation_id: input.runtimeConversationId,
    });
    return { id, startedAt, directory };
  }

  updateConversation(id: string, fields: { status?: string }): void {
    this.catalog.update("conversations", id, { status: fields.status });
  }

  createTask(input: { conversationId: string; text: string; clientId: string | null }): string {
    const id = newId("task");
    this.catalog.insert("tasks", {
      id,
      conversation_id: input.conversationId,
      status: "running",
      created_at: nowIso(),
      text: redactValue(input.text),
      client_id: input.clientId,
    });
    return id;
  }

  updateTask(id: string, fields: { status?: string; finishedAt?: string | null }): void {
    this.catalog.update("tasks", id, { status: fields.status, finished_at: fields.finishedAt });
  }

  createExecution(input: {
    taskId: string;
    conversationId: string;
    runtimeIdentity: string;
    runtimeConversationId: string;
    requestedModel: string;
    requestedEffort: string;
    provenanceSetId: string | null;
    executionEpoch: number;
  }): string {
    const id = newId("exec");
    this.catalog.insert("executions", {
      id,
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
    return id;
  }

  updateExecution(
    id: string,
    fields: {
      status?: string;
      endedAt?: string | null;
      reportedModel?: string | null;
      reportedEffort?: string | null;
      effortEvidence?: unknown;
      usage?: unknown;
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
      usage: fields.usage === undefined ? undefined : JSON.stringify(redactValue(fields.usage)),
    });
  }

  // ---- events ----

  appendEvent(input: EventInput): AppendedEvent {
    const receivedAt = nowIso();
    const id = newId("evt");
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
    conversationId: string;
    taskId: string;
    executionId: string;
    runtimeCallId: string;
    bindingRevision: number;
    toolIdentity: string;
    argumentDigest: string;
    redactedArguments: unknown;
    policy: string;
    status: string;
    proposalEventId: string | null;
  }): string {
    const id = newId("call");
    const now = nowIso();
    this.catalog.insert("tool_calls", {
      id,
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
    return id;
  }

  updateToolCall(
    id: string,
    fields: {
      status?: string;
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
    toolCallId: string;
    executionEpoch: number;
    requestingEventId: string | null;
  }): string {
    const id = newId("appr");
    this.catalog.insert("approvals", {
      id,
      tool_call_id: input.toolCallId,
      execution_epoch: input.executionEpoch,
      status: "pending",
      requesting_event_id: input.requestingEventId,
      requested_at: nowIso(),
    });
    return id;
  }

  updateApproval(
    id: string,
    fields: {
      status: "approved" | "rejected" | "invalidated" | "expired";
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
