import {
  PROTOCOL_VERSION,
  type AcceptedAck,
  type AckError,
  type AckPayload,
  type ServerEventOf,
} from "@mia/protocol";

const ackFor = (payload: AckPayload): ServerEventOf<"ack"> => ({
  protocol_version: PROTOCOL_VERSION,
  message_id: `event_${payload.command_id}`,
  conversation_id: null,
  sequence: null,
  server_time: new Date().toISOString(),
  type: "ack",
  payload,
});

/** An accepted ack for `commandId`, as a server sends it; tests use it to stand in for the server. */
export const ackEvent = (commandId: string, result?: AcceptedAck["result"]): ServerEventOf<"ack"> =>
  ackFor({
    command_id: commandId,
    disposition: "accepted",
    ...(result === undefined ? {} : { result }),
  });

/** A rejected ack for `commandId` carrying `error`. */
export const refusalEvent = (commandId: string, error: AckError): ServerEventOf<"ack"> =>
  ackFor({ command_id: commandId, disposition: "rejected", error });
