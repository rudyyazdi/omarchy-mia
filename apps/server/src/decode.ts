import {
  ClientCommandSchema,
  EnvelopeHeadSchema,
  LIMITS,
  PROTOCOL_VERSION,
  type ClientCommand,
  type ErrorCode,
} from "@mia/protocol";

/** The decision a raw client frame yields: one valid command, or the rejection to acknowledge. */
export type Decoded =
  | { ok: true; command: ClientCommand; commandId: string }
  | { ok: false; commandId: string; code: ErrorCode; message: string };

export interface EnvelopeInput {
  /** The frame decoded as UTF-8; ignored when `isBinary`. */
  text: string;
  isBinary: boolean;
  /** The client id this connection is already bound to, or null before the first command. */
  boundClientId: string | null;
}

/** Acknowledged command id when the frame carries no usable `message_id`. */
const UNKNOWN_COMMAND_ID = "unknown";

const invalid = (commandId: string, message: string): Decoded => ({
  ok: false,
  commandId,
  code: "invalid_message",
  message,
});

/**
 * Decide whether one frame is a `ClientCommand`, and if not which error the client gets. Pure: the
 * gateway owns the socket, the records and the engine, so every rejection is unit-testable here.
 * The order of the checks is part of the contract: a version mismatch is reported before schema
 * errors, so a client on the wrong protocol version is told to upgrade rather than shown field
 * complaints it cannot act on.
 */
export const decodeEnvelope = (input: EnvelopeInput): Decoded => {
  if (input.isBinary) return invalid(UNKNOWN_COMMAND_ID, "binary frames are not accepted");
  if (input.text.length > LIMITS.maxEnvelopeBytes)
    return invalid(UNKNOWN_COMMAND_ID, `envelope exceeds ${LIMITS.maxEnvelopeBytes} bytes`);
  let json: unknown;
  try {
    json = JSON.parse(input.text);
  } catch {
    return invalid(UNKNOWN_COMMAND_ID, "envelope is not valid JSON");
  }
  const head = EnvelopeHeadSchema.safeParse(json);
  const commandId =
    head.success && typeof head.data.message_id === "string"
      ? head.data.message_id
      : UNKNOWN_COMMAND_ID;
  if (!head.success)
    return invalid(
      commandId,
      "envelope must carry protocol_version, message_id, client_id, type and payload",
    );
  if (head.data.protocol_version !== PROTOCOL_VERSION)
    return {
      ok: false,
      commandId,
      code: "unsupported_protocol_version",
      message: `this server speaks protocol_version ${PROTOCOL_VERSION}; received ${JSON.stringify(head.data.protocol_version)}. Upgrade the client or server.`,
    };
  const parsed = ClientCommandSchema.safeParse(json);
  if (!parsed.success)
    return invalid(
      commandId,
      `invalid ${String(head.data.type)} command: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  const command = parsed.data;
  if (input.boundClientId !== null && input.boundClientId !== command.client_id)
    return invalid(commandId, "client_id changed within a connection");
  return { ok: true, command, commandId };
};
