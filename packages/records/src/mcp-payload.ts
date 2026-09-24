import { match } from "ts-pattern";
import { z } from "zod";
import { isRecord } from "@mia/protocol";
import type { JournalEventType } from "./schema.ts";

/**
 * The payload of the events debug mode records for one MCP message of a tool call (issue #6): the engine writes it
 * and the watch view reads it, so both go through this one definition.
 */

/** The events that record one MCP request or response of a call. */
export type McpEventType = Extract<JournalEventType, "mcp_request" | "mcp_response">;

/** What one MCP message event holds: the body as recorded (already redacted), or why none was. */
export type McpContent =
  { status: "recorded"; body: unknown } | { status: "unrecorded"; reason: string };

const MCP_EVENT_TYPES: ReadonlySet<JournalEventType> = new Set<McpEventType>([
  "mcp_request",
  "mcp_response",
]);

export const isMcpEventType = (type: JournalEventType): type is McpEventType =>
  MCP_EVENT_TYPES.has(type);

/** An MCP message event's payload: the call it belongs to, and its body or why there is none. */
export const mcpPayload = (
  call: { toolCallId: string; runtimeCallId: string },
  content: McpContent,
): Record<string, unknown> => ({
  tool_call_id: call.toolCallId,
  runtime_call_id: call.runtimeCallId,
  ...match(content)
    .with({ status: "recorded" }, ({ body }) => ({ body }))
    .with({ status: "unrecorded" }, ({ reason }) => ({ unrecorded: reason }))
    .exhaustive(),
});

const Unrecorded = z.object({ unrecorded: z.string() });

/** What a stored MCP message payload holds, or null for a payload of neither shape. */
export const mcpContentOf = (payload: unknown): McpContent | null => {
  const unrecorded = Unrecorded.safeParse(payload);
  if (unrecorded.success) return { status: "unrecorded", reason: unrecorded.data.unrecorded };
  if (isRecord(payload) && Object.hasOwn(payload, "body"))
    return { status: "recorded", body: payload.body };
  return null;
};
