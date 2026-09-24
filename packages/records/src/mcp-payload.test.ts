import { describe, expect, it } from "vitest";
import { mcpContentOf, mcpPayload, type McpContent } from "./mcp-payload.ts";

const CALL = { toolCallId: "call-1", runtimeCallId: "toolu_1" };

describe("MCP message payloads", () => {
  it.each<McpContent>([
    { status: "recorded", body: { method: "tools/call" } },
    { status: "recorded", body: null },
    { status: "unrecorded", reason: "the body log does not exist" },
  ])("reads back what was written, through storage: %o", (content) => {
    const stored: unknown = JSON.parse(JSON.stringify(mcpPayload(CALL, content)));
    expect(stored).toMatchObject({ tool_call_id: "call-1", runtime_call_id: "toolu_1" });
    expect(mcpContentOf(stored)).toEqual(content);
  });

  it("reads a payload with neither a body nor a reason as nothing", () => {
    expect(mcpContentOf({ tool_call_id: "call-1" })).toBeNull();
    expect(mcpContentOf("text")).toBeNull();
  });
});
