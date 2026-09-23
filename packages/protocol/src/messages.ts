import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

export const LIMITS = {
  maxEnvelopeBytes: 256 * 1024,
  maxTextChars: 32_000,
  maxIdChars: 128,
} as const;

const id = z.string().min(1).max(LIMITS.maxIdChars);
const isoTime = z.string().datetime({ offset: true });

export const DecisionSchema = z.enum(["approve", "reject"]);
export type Decision = z.infer<typeof DecisionSchema>;

export const ToolPolicySchema = z.enum(["allow", "ask", "deny"]);
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;
/** Missing configuration stays distinct from an explicit deny in the persisted policy audit. */
export type ToolCallPolicy = ToolPolicy | "unlisted";

export const ApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "invalidated",
  "expired",
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const TaskStatusSchema = z.enum([
  "running",
  "awaiting_approval",
  "interrupting",
  "completed",
  "failed",
  "interrupted",
  "outcome_unknown",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** Client-reported diagnostics; voice/display fields are explicitly not applicable in D1. */
export const ClientDiagnosticsSchema = z.object({
  build: z.object({
    name: z.string(),
    version: z.string(),
    commit: z.string().nullable(),
    dirty: z.boolean().nullable(),
  }),
  connection_state: z.enum(["connecting", "connected", "reconnecting", "disconnected"]),
  recent_interaction_ids: z.array(id).max(50),
  recent_errors: z.array(z.object({ at: isoTime, message: z.string().max(2000) })).max(20),
  timing: z.record(z.string(), z.number()).optional(),
  voice: z.literal("not_applicable"),
  display: z.literal("not_applicable"),
  captured_at: isoTime,
});
export type ClientDiagnostics = z.infer<typeof ClientDiagnosticsSchema>;

// ---------- client -> server commands ----------

const command = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  z.object({
    protocol_version: z.literal(PROTOCOL_VERSION),
    message_id: id,
    client_id: id,
    type: z.literal(type),
    payload,
  });

export const StartConversationCommand = command("start_conversation", z.object({}).strict());
export const SubmitTextCommand = command(
  "submit_text",
  z.object({ conversation_id: id, text: z.string().min(1).max(LIMITS.maxTextChars) }).strict(),
);
export const ApprovalDecisionCommand = command(
  "approval_decision",
  z
    .object({ conversation_id: id, task_id: id, approval_id: id, decision: DecisionSchema })
    .strict(),
);
export const InterruptTaskCommand = command(
  "interrupt_task",
  z.object({ conversation_id: id, task_id: id }).strict(),
);
export const DiagnosticSnapshotCommand = command(
  "diagnostic_snapshot",
  z.object({ conversation_id: id.nullable(), diagnostics: ClientDiagnosticsSchema }).strict(),
);
export const HeartbeatCommand = command(
  "heartbeat",
  z
    .object({
      conversation_id: id.nullable(),
      captured_at: isoTime,
      connection_state: z.string().max(32),
    })
    .strict(),
);

export const ClientCommandSchema = z.discriminatedUnion("type", [
  StartConversationCommand,
  SubmitTextCommand,
  ApprovalDecisionCommand,
  InterruptTaskCommand,
  DiagnosticSnapshotCommand,
  HeartbeatCommand,
]);
export type ClientCommand = z.infer<typeof ClientCommandSchema>;

/** Loose pre-parse so version errors can be reported before schema errors. */
export const EnvelopeHeadSchema = z.object({
  protocol_version: z.unknown(),
  message_id: z.unknown(),
  client_id: z.unknown(),
  type: z.unknown(),
});

// ---------- server -> client events ----------

export const ErrorCodeSchema = z.enum([
  "unsupported_protocol_version",
  "invalid_message",
  "unauthenticated",
  "busy",
  "not_found",
  "invalid_state",
  "duplicate_command_conflict",
  "runtime_failure",
  "configuration_error",
  "record_failure",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/**
 * A command's outcome as its ack reports it. `failed` means the command was recorded and then handling broke:
 * it may have taken effect, and it will not run again.
 */
export const AckDispositionSchema = z.enum(["accepted", "rejected", "failed"]);
export type AckDisposition = z.infer<typeof AckDispositionSchema>;
/** The dispositions whose ack carries an error. */
export const ErrorDispositionSchema = AckDispositionSchema.exclude(["accepted"]);
export type ErrorDisposition = z.infer<typeof ErrorDispositionSchema>;

export const ToolCallStatusSchema = z.enum([
  "proposed",
  "awaiting_approval",
  "permitted",
  "denied",
  "blocked_gate",
  "invalidated",
  "dispatched",
  "completed",
  "failed",
  "cancelled",
  "unknown",
]);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

/** Set when this message_id was already recorded for the client: the ack repeats the stored reply. */
const ackDuplicate = z.literal(true).optional();

const eventPayloads = {
  /**
   * An `accepted` ack may carry a result and never an error; any other disposition always carries its error.
   * Both variants are strict so a field from the other variant fails validation instead of being stripped.
   */
  ack: z.discriminatedUnion("disposition", [
    z.strictObject({
      command_id: id,
      disposition: z.literal("accepted"),
      result: z.record(z.string(), z.unknown()).optional(),
      duplicate: ackDuplicate,
    }),
    z.strictObject({
      command_id: id,
      disposition: ErrorDispositionSchema,
      error: z.object({ code: ErrorCodeSchema, message: z.string() }),
      duplicate: ackDuplicate,
    }),
  ]),
  conversation_started: z.object({
    conversation_id: id,
    started_at: isoTime,
    provenance_set_id: id,
  }),
  task_started: z.object({
    conversation_id: id,
    task_id: id,
    execution_id: id,
    execution_epoch: z.number().int(),
    text: z.string(),
  }),
  text_delta: z.object({ conversation_id: id, task_id: id, execution_id: id, text: z.string() }),
  tool_call: z.object({
    conversation_id: id,
    task_id: id,
    tool_call_id: id,
    runtime_call_id: z.string(),
    tool_identity: z.string(),
    status: ToolCallStatusSchema,
    detail: z.string().optional(),
    /** Present so a policy-allowed dispatch is not opaque to the person; same redaction as approval_requested. */
    redacted_arguments: z.unknown().optional(),
  }),
  approval_requested: z.object({
    conversation_id: id,
    task_id: id,
    approval_id: id,
    tool_call_id: id,
    runtime_call_id: z.string(),
    binding_revision: z.number().int(),
    execution_epoch: z.number().int(),
    tool_identity: z.string(),
    intended_action: z.string(),
    redacted_arguments: z.unknown(),
    argument_digest: z.string(),
    explainable: z.boolean(),
  }),
  approval_resolved: z.object({
    conversation_id: id,
    task_id: id,
    approval_id: id,
    tool_call_id: id,
    status: ApprovalStatusSchema.exclude(["pending"]),
    reason: z.string().optional(),
  }),
  interruption_requested: z.object({
    conversation_id: id,
    task_id: id,
    execution_epoch: z.number().int(),
  }),
  interruption_outcome: z.object({
    conversation_id: id,
    task_id: id,
    task_status: TaskStatusSchema,
    actions: z.array(
      z.object({
        tool_call_id: id,
        tool_identity: z.string(),
        status: ToolCallStatusSchema,
        detail: z.string().optional(),
      }),
    ),
    runtime_cancellation: z.enum(["not_needed", "forced_kill", "unknown"]),
  }),
  task_finished: z.object({
    conversation_id: id,
    task_id: id,
    status: TaskStatusSchema,
    error: z.string().optional(),
    usage: z.unknown().optional(),
  }),
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    conversation_id: id.optional(),
    task_id: id.optional(),
  }),
} as const;

export type ServerEventType = keyof typeof eventPayloads;

const serverEvent = <T extends ServerEventType>(type: T) =>
  z.object({
    protocol_version: z.literal(PROTOCOL_VERSION),
    message_id: id,
    type: z.literal(type),
    conversation_id: id.nullable(),
    sequence: z.number().int().nullable(),
    server_time: isoTime,
    payload: eventPayloads[type],
  });

export const ServerEventSchema = z.discriminatedUnion("type", [
  serverEvent("ack"),
  serverEvent("conversation_started"),
  serverEvent("task_started"),
  serverEvent("text_delta"),
  serverEvent("tool_call"),
  serverEvent("approval_requested"),
  serverEvent("approval_resolved"),
  serverEvent("interruption_requested"),
  serverEvent("interruption_outcome"),
  serverEvent("task_finished"),
  serverEvent("error"),
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type ServerEventOf<T extends ServerEventType> = Extract<ServerEvent, { type: T }>;
export type EventPayload<T extends ServerEventType> = z.infer<(typeof eventPayloads)[T]>;
