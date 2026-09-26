import { REDACTED } from "@mia/protocol";
import { describe, expect, it } from "vitest";
import { parseStreamLine, redactLine } from "./stream.ts";

describe("runtime stream framing", () => {
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
    '{"type":"system","subtype":"init","session_id":"session","model":"m","mcp_servers":[]}',
    "null",
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
      error: "invalid JSON",
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
    ["null", "null"],
    ["42", "42"],
    ['"sk-ant-abcdefghijklmnop"', `"${REDACTED}"`],
    ['[{"api_key":"short"}]', `[{"api_key":"${REDACTED}"}]`],
  ])("redacts a schema-invalid JSON value that is not an object: %s", (line, expected) => {
    expect(redacted(line)).toBe(expected);
  });

  it("leaks no sensitive value at any point the line is cut", () => {
    const line = JSON.stringify({
      type: "assistant",
      api_key: 'leak-a "quoted\\ "password": x',
      nested: { password: 918273645, text: "kept" },
      credentials: { value: "leak-b", list: ["leak-c", { "}": "leak-d" }] },
      tokens: ["leak-e"],
      usage: { input_tokens: 1200 },
    });
    const leaks = ["leak", "9182", "quoted"];
    for (const cut of Array.from({ length: line.length }, (_, index) => index + 1)) {
      const parsed = parseStreamLine(line.slice(0, cut));
      if (!parsed) continue;
      const retained = [redactLine(parsed), parsed.ok ? "" : parsed.error].join("\n");
      for (const leak of leaks) expect(retained, line.slice(0, cut)).not.toContain(leak);
    }
  });

  it("redacts a line that is not JSON by key and by value", () => {
    expect(redacted('{"api_key":"short" sk-ant-abcdefghijkl')).toBe(
      `{"api_key":"${REDACTED}" ${REDACTED}`,
    );
  });
});
