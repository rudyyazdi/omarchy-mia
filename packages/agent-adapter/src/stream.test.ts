import { describe, expect, it } from "vitest";
import { LineSplitter, parseStreamLine } from "./stream.ts";

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
    expect(parseStreamLine(`  ${raw}\r\n`)).toEqual({ ok: true, message, raw });
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
      raw,
      error: expect.stringContaining("malformed runtime message:"),
    });
  });
  it("distinguishes blank lines from invalid JSON", () => {
    expect(parseStreamLine(" \r\n")).toBeNull();
    expect(parseStreamLine(" { ")).toEqual({
      ok: false,
      raw: "{",
      error: expect.stringContaining("invalid JSON:"),
    });
  });
});
