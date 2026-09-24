// Rows for the watch view's unit tests: each builder fills every column, and a test overrides the ones it is about.
import type {
  ApprovalRow,
  ConversationRow,
  EventRow,
  ExecutionRow,
  TaskRow,
  ToolCallRow,
  WatchRows,
} from "@mia/records";

const AT = "2026-09-24T00:00:00.000Z";

export const conversationRow = (fields: Partial<ConversationRow> = {}): ConversationRow => ({
  id: "conv",
  started_at: AT,
  status: "active",
  provenance_set_id: "provenance",
  directory: "/state/conversations/conv",
  runtime_conversation_id: "runtime-conv",
  ...fields,
});

export const taskRow = (fields: Partial<TaskRow> = {}): TaskRow => ({
  id: "t1",
  conversation_id: "conv",
  status: "running",
  created_at: AT,
  finished_at: null,
  text: "summarise my inbox",
  client_id: "client-A",
  ...fields,
});

export const executionRow = (fields: Partial<ExecutionRow> = {}): ExecutionRow => ({
  id: "x1",
  task_id: "t1",
  conversation_id: "conv",
  runtime_identity: "scripted",
  runtime_conversation_id: "runtime-conv",
  requested_model: "model",
  reported_model: null,
  requested_effort: "medium",
  reported_effort: null,
  effort_evidence: null,
  provenance_set_id: null,
  execution_epoch: 1,
  status: "running",
  started_at: AT,
  ended_at: null,
  usage: null,
  ...fields,
});

export const toolCallRow = (fields: Partial<ToolCallRow> = {}): ToolCallRow => ({
  id: "c1",
  conversation_id: "conv",
  task_id: "t1",
  execution_id: "x1",
  runtime_call_id: "toolu_1",
  binding_revision: 1,
  tool_identity: "mcp__d1__change",
  argument_digest: "digest",
  redacted_arguments: JSON.stringify({ delta: 1 }),
  policy: "ask",
  status: "proposed",
  detail: null,
  proposal_event_id: null,
  dispatch_event_id: null,
  result_event_id: null,
  created_at: AT,
  updated_at: AT,
  ...fields,
});

export const approvalRow = (fields: Partial<ApprovalRow> = {}): ApprovalRow => ({
  id: "a1",
  tool_call_id: "c1",
  execution_epoch: 1,
  status: "pending",
  reason: null,
  requesting_event_id: null,
  decision_event_id: null,
  decision_client_id: null,
  requested_at: AT,
  consumed_at: null,
  ...fields,
});

export const eventRow = (fields: Partial<EventRow> & Pick<EventRow, "sequence">): EventRow => ({
  id: `e${fields.sequence}`,
  conversation_id: "conv",
  type: "text_delta",
  payload_version: 1,
  payload: "{}",
  task_id: null,
  execution_id: null,
  client_id: null,
  client_connection_id: null,
  caused_by_event_id: null,
  producer_id: null,
  producer_event_id: null,
  captured_at: null,
  received_at: AT,
  duration_ms: null,
  timing_source: null,
  ...fields,
});

export const watchRows = (tables: Partial<WatchRows> = {}): WatchRows => ({
  conversations: [conversationRow()],
  tasks: [],
  executions: [],
  events: [],
  tool_calls: [],
  approvals: [],
  ...tables,
});
