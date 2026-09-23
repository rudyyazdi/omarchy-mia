import { PROTOCOL_VERSION, type ServerEventOf } from "@mia/protocol";
import type { AckPayload } from "./client.ts";

/** An accepted ack for `commandId`, as a server sends it; tests use it to stand in for the server. */
export const ackEvent = (
  commandId: string,
  result?: AckPayload["result"],
): ServerEventOf<"ack"> => ({
  protocol_version: PROTOCOL_VERSION,
  message_id: `event_${commandId}`,
  conversation_id: null,
  sequence: null,
  server_time: new Date().toISOString(),
  type: "ack",
  payload: { command_id: commandId, disposition: "accepted", result },
});
