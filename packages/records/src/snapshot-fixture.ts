import type { ConversationSnapshot } from "./queries.ts";
import { emptySnapshotTables, type EventRow } from "./schema.ts";

export const fixtureEvent = (overrides: Partial<EventRow> = {}): EventRow => ({
  id: "event",
  conversation_id: "conversation",
  sequence: 1,
  type: "text_delta",
  payload_version: 1,
  payload: JSON.stringify({ text: "answer" }),
  task_id: "task",
  execution_id: null,
  client_id: null,
  client_connection_id: null,
  caused_by_event_id: null,
  producer_id: null,
  producer_event_id: null,
  captured_at: null,
  received_at: "2026-01-01T00:00:00.000Z",
  duration_ms: null,
  timing_source: null,
  ...overrides,
});

/** In-memory report input; the text factory lets escaping tests mark every displayed free-text field. */
export const snapshotFixture = (
  text: (label: string) => string = (label) => label,
): ConversationSnapshot => {
  const conversationId = text("conversation");
  const taskId = text("task");
  const artifactId = text("artifact");
  const executionId = text("execution");
  const toolCallId = "call";
  const snapshot: ConversationSnapshot = {
    conversation_id: conversationId,
    captured_at: text("cutoff-time"),
    cutoff_sequence: 5,
    tables: emptySnapshotTables(),
    artifact_closure: [artifactId],
    unresolved_references: [
      { table: text("gap-table"), id: text("gap-id"), reason: text("gap-reason") },
    ],
    ongoing_tasks: [taskId],
  };
  const { tables } = snapshot;
  tables.conversations = [
    {
      id: conversationId,
      started_at: text("started"),
      status: "active",
      provenance_set_id: "provenance",
      directory: "unused",
      runtime_conversation_id: text("runtime-conversation"),
    },
  ];
  tables.tasks = [
    {
      id: taskId,
      conversation_id: conversationId,
      status: "interrupted",
      created_at: text("task-created"),
      finished_at: text("task-finished"),
      text: text("user-text"),
      client_id: null,
    },
  ];
  tables.events = [
    fixtureEvent({
      id: "delta",
      conversation_id: conversationId,
      task_id: taskId,
      received_at: text("delta-received"),
      caused_by_event_id: text("caused-by"),
      payload: JSON.stringify({ text: text("assistant-text") }),
    }),
    fixtureEvent({
      id: "error",
      conversation_id: conversationId,
      task_id: taskId,
      type: "error",
      sequence: 2,
      received_at: text("error-received"),
      payload: JSON.stringify({ detail: text("error-payload") }),
    }),
    fixtureEvent({
      id: "interrupt",
      conversation_id: conversationId,
      task_id: taskId,
      type: "interruption_outcome",
      sequence: 3,
      received_at: text("interrupt-received"),
      payload: JSON.stringify({ detail: text("interruption") }),
    }),
    fixtureEvent({
      id: "other",
      conversation_id: conversationId,
      task_id: taskId,
      type: "tool_dispatched",
      sequence: 4,
      received_at: text("other-received"),
      payload: JSON.stringify({ detail: text("event-payload") }),
    }),
    fixtureEvent({
      id: "conversation-event",
      conversation_id: conversationId,
      task_id: null,
      type: "client_disconnected",
      sequence: 5,
      received_at: text("conversation-event-time"),
      payload: JSON.stringify({ detail: text("conversation-event-payload") }),
    }),
  ];
  tables.executions = [
    {
      id: executionId,
      task_id: taskId,
      conversation_id: conversationId,
      runtime_identity: "fixture",
      runtime_conversation_id: null,
      requested_model: text("requested-model"),
      reported_model: text("reported-model"),
      requested_effort: "medium",
      reported_effort: text("reported-effort"),
      effort_evidence: JSON.stringify({ detail: text("effort-evidence") }),
      provenance_set_id: "provenance",
      execution_epoch: 1,
      status: "killed",
      started_at: "unused",
      ended_at: null,
      usage: JSON.stringify({ detail: text("usage") }),
    },
  ];
  tables.tool_calls = [
    {
      id: toolCallId,
      conversation_id: conversationId,
      task_id: taskId,
      execution_id: executionId,
      runtime_call_id: text("runtime-call"),
      binding_revision: 1,
      tool_identity: text("tool"),
      argument_digest: text("digest"),
      redacted_arguments: JSON.stringify({ detail: text("arguments") }),
      policy: "ask",
      status: "denied",
      detail: text("tool-detail"),
      proposal_event_id: null,
      dispatch_event_id: null,
      result_event_id: null,
      created_at: "unused",
      updated_at: "unused",
    },
  ];
  tables.approvals = [
    {
      id: text("approval"),
      tool_call_id: toolCallId,
      execution_epoch: 1,
      status: "rejected",
      reason: text("approval-reason"),
      requesting_event_id: null,
      decision_event_id: null,
      decision_client_id: text("decision-client"),
      requested_at: "unused",
      consumed_at: text("consumed"),
    },
  ];
  tables.diagnostics = [
    {
      id: "diagnostic",
      conversation_id: conversationId,
      client_id: text("client"),
      client_connection_id: text("connection"),
      task_id: null,
      event_id: null,
      captured_at: text("diagnostic-captured"),
      received_at: text("diagnostic-received"),
      base_snapshot_id: null,
      state: JSON.stringify({ detail: text("diagnostic-state") }),
    },
  ];
  tables.artifacts = [
    {
      id: artifactId,
      kind: "tool_output",
      mime_type: text("mime"),
      schema_version: null,
      logical_name: text("filename"),
      created_at: "unused",
      producer_execution_id: executionId,
      producer_event_id: null,
      object_digest: text("object-digest"),
      byte_size: 10,
      capture_status: "missing",
      external_locator: null,
      capture_reason: text("capture-reason"),
      redaction: null,
      original_path: text("original-path"),
    },
  ];
  tables.provenance_entries = [
    {
      id: "entry",
      provenance_set_id: "provenance",
      role: "agent_prompt",
      ordinal: 0,
      version: text("version"),
      artifact_id: artifactId,
      availability: "unavailable",
      reason: text("provenance-reason"),
    },
  ];
  tables.artifact_links = [
    {
      id: "link",
      conversation_id: conversationId,
      artifact_id: artifactId,
      relation: "task_output",
      task_id: taskId,
      event_id: text("link-event"),
      tool_call_id: text("link-call"),
      diagnostic_id: null,
      provenance_set_id: text("link-provenance"),
    },
  ];
  tables.artifact_dependencies = [
    {
      parent_artifact_id: artifactId,
      required_artifact_id: text("required-artifact"),
      relation: "local_changes",
    },
  ];
  return snapshot;
};
