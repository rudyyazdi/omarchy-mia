import { describe, expect, it } from "vitest";
import { bodyLogLinesFor, responseId, TOOL_USE_ID_META, toolCallsIn } from "./body-log.ts";

const call = (id: number | string, toolUseId?: string) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "read", ...(toolUseId ? { _meta: { [TOOL_USE_ID_META]: toolUseId } } : {}) },
});

describe("toolCallsIn", () => {
  it("finds each tool call with a tool-use id, in a single message or a batch", () => {
    expect([...toolCallsIn(call(1, "toolu_a")).entries()]).toEqual([
      [1, { toolUseId: "toolu_a", body: call(1, "toolu_a") }],
    ]);
    const batch = [call("x", "toolu_b"), call(2), { jsonrpc: "2.0", id: 3, method: "tools/list" }];
    expect([...toolCallsIn(batch).keys()]).toEqual(["x"]);
    expect(toolCallsIn(undefined).size).toBe(0);
  });
});

describe("responseId", () => {
  it("is the id of a result or an error, and null for anything else", () => {
    expect(responseId({ jsonrpc: "2.0", id: 4, result: {} })).toBe(4);
    expect(responseId({ jsonrpc: "2.0", id: "e", error: { code: 1, message: "no" } })).toBe("e");
    expect(responseId({ jsonrpc: "2.0", method: "notifications/progress", params: {} })).toBe(null);
    expect(responseId({ jsonrpc: "2.0", id: null, error: { code: 1, message: "no" } })).toBe(null);
  });
});

describe("bodyLogLinesFor", () => {
  it("returns one tool use's lines in log order, skipping malformed ones", () => {
    const line = (toolUseId: string, direction: string, body: unknown) =>
      JSON.stringify({ tool_use_id: toolUseId, direction, body });
    const text = [
      line("toolu_a", "request", 1),
      line("toolu_b", "request", 2),
      '{"tool_use_id":"toolu_a","direction":"sideways","body":0}',
      line("toolu_a", "response", 3),
      "",
      '{"tool_use_id":"toolu_a","dire',
    ].join("\n");

    expect(bodyLogLinesFor(text, "toolu_a")).toEqual([
      { tool_use_id: "toolu_a", direction: "request", body: 1 },
      { tool_use_id: "toolu_a", direction: "response", body: 3 },
    ]);
    // A line that mentions the id only in its body belongs to another call.
    expect(bodyLogLinesFor(line("toolu_b", "request", "toolu_a"), "toolu_a")).toEqual([]);
  });
});
