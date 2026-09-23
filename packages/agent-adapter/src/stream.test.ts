import { REDACTED } from "@mia/protocol";
import { describe, expect, it } from "vitest";
import { LineSplitter, parseStreamLine, redactLine } from "./stream.ts";

describe("runtime stream framing", () => {
  it("retains partial lines between chunks and flushes the tail exactly once", () => {
    const splitter = new LineSplitter();
    expect(splitter.push("fir")).toEqual([]);
    expect(splitter.push("st\nsecond\nthi")).toEqual(["first", "second"]);
    expect(splitter.push("rd\n\ntail")).toEqual(["third", ""]);
    expect(splitter.flush()).toEqual(["tail"]);
    expect(splitter.flush()).toEqual([]);
    expect(splitter.push("next\n")).toEqual(["next"]);
    expect(splitter.flush()).toEqual([]);
  });

  it("parses known messages and preserves additional evidence fields", () => {
    const message = {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "session",
      result: "done",
      extra: 42,
    };
    const raw = JSON.stringify(message);
    expect(parseStreamLine(`  ${raw}\r\n`)).toEqual({ ok: true, message, json: message, raw });
  });

  it("retains unknown message types as evidence", () => {
    const raw = '{"type":"future_event","evidence":{"value":42}}';
    expect(parseStreamLine(raw)).toEqual({
      ok: true,
      raw,
      message: {
        type: "other",
        original_type: "future_event",
        raw: { type: "future_event", evidence: { value: 42 } },
      },
      json: { type: "future_event", evidence: { value: 42 } },
    });
  });

  it.each([
    '{"type":"assistant"}',
    '{"type":"result","session_id":12}',
    '{"type":"system","subtype":"init","session_id":"session","model":"m","mcp_servers":[]}',
    "null",
    "{}",
  ])("rejects malformed runtime messages: %s", (raw) => {
    expect(parseStreamLine(raw)).toEqual({
      ok: false,
      reason: "invalid_schema",
      json: JSON.parse(raw),
      raw,
      error: expect.stringContaining("malformed runtime message:"),
    });
  });
  it("distinguishes blank lines from invalid JSON", () => {
    expect(parseStreamLine(" \r\n")).toBeNull();
    expect(parseStreamLine(" { ")).toEqual({
      ok: false,
      reason: "invalid_json",
      raw: "{",
      error: expect.stringContaining("invalid JSON:"),
    });
  });
});

describe("redactLine", () => {
  const redacted = (line: string) => {
    const parsed = parseStreamLine(line);
    if (!parsed) throw new Error("blank line");
    return redactLine(parsed);
  };

  it("redacts a schema-invalid JSON line by key, not only by value", () => {
    const line = '{"type":"assistant","api_key":"short","nested":{"token":"x"},"text":"kept"}';
    expect(parseStreamLine(line)?.ok).toBe(false);
    expect(JSON.parse(redacted(line))).toEqual({
      type: "assistant",
      api_key: REDACTED,
      nested: { token: REDACTED },
      text: "kept",
    });
  });

  it.each([
    ['{"type":"future_event","password":"short"}', { type: "future_event", password: REDACTED }],
    [
      '{"type":"result","subtype":"success","is_error":false,"session_id":"s","secret":"short"}',
      { type: "result", subtype: "success", is_error: false, session_id: "s", secret: REDACTED },
    ],
  ])("redacts a well-formed line by key: %s", (line, expected) => {
    expect(parseStreamLine(line)?.ok).toBe(true);
    expect(JSON.parse(redacted(line))).toEqual(expected);
  });

  it("redacts secret-shaped keys of a schema-invalid line", () => {
    expect(redacted('{"type":"assistant","headers":{"sk-ant-abcdefghijklmnop":1}}')).toBe(
      `{"type":"assistant","headers":{"${REDACTED}":1}}`,
    );
  });

  it.each([
    ["null", "null"],
    ["42", "42"],
    ['"sk-ant-abcdefghijklmnop"', `"${REDACTED}"`],
    ['[{"api_key":"short"}]', `[{"api_key":"${REDACTED}"}]`],
  ])("redacts a schema-invalid JSON value that is not an object: %s", (line, expected) => {
    expect(redacted(line)).toBe(expected);
  });

  it.each([
    ['{"type":"assistant","api_key":"short', `{"type":"assistant","api_key":"${REDACTED}`],
    [
      '{"type":"assistant","api_key":"short","text":"kept',
      `{"type":"assistant","api_key":"${REDACTED}","text":"kept`,
    ],
    ['{"type":"assistant","password":123456', `{"type":"assistant","password":"${REDACTED}"`],
    [
      '{"type":"assistant","nested":{"token":{"value":"x"},"text":"kept',
      `{"type":"assistant","nested":{"token":"${REDACTED}","text":"kept`,
    ],
    [
      '{"type":"result","usage":{"input_tokens":1200',
      '{"type":"result","usage":{"input_tokens":1200',
    ],
  ])("redacts a line cut short by key: %s", (line, expected) => {
    expect(parseStreamLine(line)?.ok).toBe(false);
    expect(redacted(line)).toBe(expected);
  });

  it("redacts a line that is not JSON by key and by value", () => {
    expect(redacted('{"api_key":"short" sk-ant-abcdefghijkl')).toBe(
      `{"api_key":"${REDACTED}" ${REDACTED}`,
    );
  });
});
