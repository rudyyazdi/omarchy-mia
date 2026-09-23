import { describe, expect, it } from "vitest";
import { ClaudeTranslator } from "./claude-translate.ts";
import { parseStreamLine, type RuntimeMessage } from "./stream.ts";

const at = "2026-01-01T00:00:00.000Z";

/** Messages go through the real stream parser, so the translator sees exactly what the adapter feeds it. */
const message = (json: unknown): RuntimeMessage => {
  const parsed = parseStreamLine(JSON.stringify(json));
  if (!parsed?.ok) throw new Error(`fixture did not parse: ${JSON.stringify(json)}`);
  return parsed.message;
};

const init = {
  type: "system",
  subtype: "init",
  session_id: "session",
  model: "claude-test",
  tools: ["mcp__d1__read"],
  mcp_servers: [{ name: "d1", status: "connected" }],
  claude_code_version: "2.1.0",
};

const toolUse = { type: "tool_use", id: "toolu_1", name: "mcp__d1__read", input: { key: 1 } };

describe("ClaudeTranslator", () => {
  it("reports the init model and keeps the whole init message as evidence", () => {
    expect(new ClaudeTranslator().translate(message(init), at)).toEqual([
      { type: "runtime_init", init: { model: "claude-test", evidence: init }, at },
    ]);
  });

  it("ignores system messages other than init and messages it does not know", () => {
    const translator = new ClaudeTranslator();
    expect(translator.translate(message({ type: "system", subtype: "compact" }), at)).toEqual([]);
    expect(translator.translate(message({ type: "rate_limit_event" }), at)).toEqual([]);
  });

  it("streams text deltas and announces a tool call as soon as its block starts", () => {
    const translator = new ClaudeTranslator();
    const delta = {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
    };
    const start = {
      type: "stream_event",
      event: { type: "content_block_start", content_block: { ...toolUse, input: {} } },
    };
    expect(translator.translate(message(delta), at)).toEqual([
      { type: "text_delta", text: "hi", at },
    ]);
    expect(translator.translate(message(start), at)).toEqual([
      {
        type: "tool_proposed",
        runtimeCallId: "toolu_1",
        toolIdentity: "mcp__d1__read",
        arguments: {},
        complete: false,
        at,
      },
    ]);
  });

  it("reports a tool call's complete proposal once, however often the assistant repeats it", () => {
    const translator = new ClaudeTranslator();
    const assistant = message({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "ok" }, toolUse] },
    });
    const first = translator.translate(assistant, at);
    expect(first.map((event) => event.type)).toEqual(["assistant_message", "tool_proposed"]);
    expect(first[1]).toEqual({
      type: "tool_proposed",
      runtimeCallId: "toolu_1",
      toolIdentity: "mcp__d1__read",
      arguments: { key: 1 },
      complete: true,
      at,
    });
    expect(translator.translate(assistant, at).map((event) => event.type)).toEqual([
      "assistant_message",
    ]);
  });

  it("reports each tool result block with its call id and error flag", () => {
    const user = message({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "done", is_error: false },
          { type: "tool_result", tool_use_id: "toolu_2", content: "denied", is_error: true },
          { type: "text", text: "ignored" },
        ],
      },
      tool_use_result: { stdout: "done" },
    });
    expect(new ClaudeTranslator().translate(user, at)).toEqual([
      {
        type: "tool_result",
        runtimeCallId: "toolu_1",
        isError: false,
        content: "done",
        raw: { stdout: "done" },
        at,
      },
      {
        type: "tool_result",
        runtimeCallId: "toolu_2",
        isError: true,
        content: "denied",
        raw: { stdout: "done" },
        at,
      },
    ]);
  });

  it("summarises the result in camelCase and keeps the result message as evidence", () => {
    const result = {
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      session_id: "session",
      result: "stopped",
      duration_ms: 10,
      duration_api_ms: 7,
      num_turns: 3,
      total_cost_usd: 0.5,
      usage: { input_tokens: 1 },
      permission_denials: [{ tool_name: "mcp__d1__forbidden" }],
    };
    expect(new ClaudeTranslator().translate(message(result), at)).toEqual([
      {
        type: "turn_result",
        summary: {
          isError: true,
          outcome: "error_max_turns",
          finalText: "stopped",
          usage: { input_tokens: 1 },
          totalCostUsd: 0.5,
          durationMs: 10,
          durationApiMs: 7,
          numTurns: 3,
          permissionDenials: [{ tool_name: "mcp__d1__forbidden" }],
          evidence: result,
        },
        at,
      },
    ]);
  });
});
