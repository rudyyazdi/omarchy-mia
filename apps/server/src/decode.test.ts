import { IdSchema, LIMITS, PROTOCOL_VERSION } from "@mia/protocol";
import { describe, expect, it } from "vitest";
import { decodeEnvelope, type Decoded } from "./decode.ts";

const envelope = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    protocol_version: PROTOCOL_VERSION,
    message_id: "cmd-1",
    client_id: "client-A",
    type: "start_conversation",
    payload: {},
    ...overrides,
  });

const decodeText = (text: string, boundClientId: string | null = null): Decoded =>
  decodeEnvelope({ text, isBinary: false, boundClientId });

describe("decodeEnvelope rejections", () => {
  it("rejects a binary frame without looking at the text", () => {
    expect(decodeEnvelope({ text: envelope(), isBinary: true, boundClientId: null })).toEqual({
      ok: false,
      commandId: "unknown",
      code: "invalid_message",
      message: "binary frames are not accepted",
    });
  });

  it("rejects an envelope over the size limit", () => {
    expect(decodeText("x".repeat(LIMITS.maxEnvelopeBytes + 1))).toEqual({
      ok: false,
      commandId: "unknown",
      code: "invalid_message",
      message: `envelope exceeds ${LIMITS.maxEnvelopeBytes} bytes`,
    });
  });

  it("rejects text that is not JSON", () => {
    expect(decodeText("{not json")).toEqual({
      ok: false,
      commandId: "unknown",
      code: "invalid_message",
      message: "envelope is not valid JSON",
    });
  });

  it("rejects JSON that is not an envelope head", () => {
    expect(decodeText(JSON.stringify(["not", "an", "envelope"]))).toEqual({
      ok: false,
      commandId: "unknown",
      code: "invalid_message",
      message: "envelope must carry protocol_version, message_id, client_id, type and payload",
    });
  });

  it("reports an unsupported protocol version before any schema complaint", () => {
    const decoded = decodeText(
      envelope({ protocol_version: 99, type: "submit_text", payload: {} }),
    );
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.code).toBe("unsupported_protocol_version");
    expect(decoded.message).toBe(
      `this server speaks protocol_version ${PROTOCOL_VERSION}; received 99. Upgrade the client or server.`,
    );
    expect(decoded.commandId).toBe("cmd-1");
  });

  it("rejects a command whose payload fails its schema, naming the type and the fields", () => {
    const decoded = decodeText(envelope({ type: "submit_text", payload: {}, message_id: "cmd-2" }));
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.code).toBe("invalid_message");
    expect(decoded.commandId).toBe("cmd-2");
    expect(decoded.message).toContain("invalid submit_text command: ");
    expect(decoded.message).toContain("payload.conversation_id");
    expect(decoded.message).toContain("payload.text");
  });

  it("rejects a command whose client_id differs from the one the connection is bound to", () => {
    expect(decodeText(envelope({ client_id: "client-B" }), "client-A")).toEqual({
      ok: false,
      commandId: "cmd-1",
      code: "invalid_message",
      message: "client_id changed within a connection",
    });
  });
});

describe("decodeEnvelope command id", () => {
  it.each([
    ["a non-string", 7],
    ["an empty", ""],
    ["an over-long", "x".repeat(LIMITS.maxIdChars + 1)],
  ])("acknowledges %s message_id as 'unknown', since no ack could carry it", (_, messageId) => {
    const decoded = decodeText(envelope({ message_id: messageId }));
    expect(decoded).toMatchObject({ ok: false, commandId: "unknown", code: "invalid_message" });
  });

  it("echoes a message_id of exactly the maximum length", () => {
    const messageId = "x".repeat(LIMITS.maxIdChars);
    expect(decodeText(envelope({ message_id: messageId }))).toMatchObject({
      ok: true,
      commandId: messageId,
    });
  });

  const texts: [string, string, string | null][] = [
    ["oversized", "x".repeat(LIMITS.maxEnvelopeBytes + 1), null],
    ["not JSON", "{not json", null],
    ["not a head", "[]", null],
    ["wrong version", envelope({ protocol_version: 99 }), null],
    ["wrong version, empty id", envelope({ protocol_version: 99, message_id: "" }), null],
    ["bad payload", envelope({ type: "submit_text" }), null],
    ["rebound client", envelope(), "client-B"],
    ["numeric id", envelope({ message_id: 7 }), null],
    ["empty id", envelope({ message_id: "" }), null],
    ["over-long id", envelope({ message_id: "x".repeat(LIMITS.maxIdChars + 1) }), null],
    ["valid", envelope(), null],
  ];

  // The ack's other fields are fixed by the gateway or typed by `Decoded`; the command id is the
  // only part a client controls, so it is what every outcome must keep a valid protocol `id`.
  it.each(texts)("yields a command id an ack can carry (%s frame)", (_, text, boundClientId) => {
    expect(IdSchema.safeParse(decodeText(text, boundClientId).commandId).success).toBe(true);
  });

  it("yields a command id an ack can carry (binary frame)", () => {
    const decoded = decodeEnvelope({ text: envelope(), isBinary: true, boundClientId: null });
    expect(IdSchema.safeParse(decoded.commandId).success).toBe(true);
  });
});

describe("decodeEnvelope happy path", () => {
  it("accepts a valid command on an unbound connection and echoes its message id", () => {
    const decoded = decodeText(envelope());
    expect(decoded).toEqual({
      ok: true,
      commandId: "cmd-1",
      command: {
        protocol_version: PROTOCOL_VERSION,
        message_id: "cmd-1",
        client_id: "client-A",
        type: "start_conversation",
        payload: {},
      },
    });
  });

  it("accepts a valid command whose client_id matches the bound one", () => {
    const decoded = decodeText(
      envelope({
        type: "submit_text",
        message_id: "cmd-3",
        payload: { conversation_id: "conv-1", text: "hello" },
      }),
      "client-A",
    );
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.command.type).toBe("submit_text");
    expect(decoded.commandId).toBe("cmd-3");
  });
});
