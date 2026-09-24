import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ApprovalBridge, BRIDGE_TOOL_NAME } from "./bridge.ts";

let bridge: ApprovalBridge;
beforeAll(async () => {
  bridge = new ApprovalBridge();
  await bridge.start();
});
afterAll(async () => bridge.close());

const client = async () => {
  const mcpClient = new Client({ name: "bridge-test", version: "0" });
  await mcpClient.connect(new StreamableHTTPClientTransport(new URL(bridge.url)));
  return mcpClient;
};

const TextToolResultSchema = z.object({
  content: z.tuple([z.object({ type: z.literal("text"), text: z.string() })], z.unknown()),
});

/** The bridge answers with one text block carrying the JSON-encoded decision. */
const decisionOf = (response: unknown): unknown =>
  JSON.parse(TextToolResultSchema.parse(response).content[0].text);

describe("approval bridge", () => {
  it("lists the request tool", async () => {
    const mcpClient = await client();
    const tools = await mcpClient.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([BRIDGE_TOOL_NAME]);
    await mcpClient.close();
  });

  it("denies when no handler is active", async () => {
    const mcpClient = await client();
    const response = await mcpClient.callTool({
      name: BRIDGE_TOOL_NAME,
      arguments: { tool_name: "mcp__d1__change", input: { delta: 1 }, tool_use_id: "toolu_1" },
    });
    expect(decisionOf(response)).toMatchObject({ behavior: "deny" });
    await mcpClient.close();
  });

  it("routes to the handler with toolUseId and returns its decision", async () => {
    bridge.setHandler(async (request) => {
      expect(request.toolUseId).toBe("toolu_2");
      expect(request.input).toEqual({ delta: 1 });
      return { behavior: "allow" };
    });
    const mcpClient = await client();
    const response = await mcpClient.callTool({
      name: BRIDGE_TOOL_NAME,
      arguments: { tool_name: "mcp__d1__change", input: { delta: 1 }, tool_use_id: "toolu_2" },
    });
    expect(decisionOf(response)).toEqual({ behavior: "allow" });
    bridge.setHandler(null);
    await mcpClient.close();
  });

  it("signals abandonment when the caller disconnects before a decision", async () => {
    const received = Promise.withResolvers<undefined>();
    const abandoned = Promise.withResolvers<undefined>();
    bridge.setHandler(
      (request) =>
        new Promise((resolve) => {
          request.abandoned.addEventListener("abort", () => {
            abandoned.resolve(undefined);
            resolve({ behavior: "deny", message: "abandoned" });
          });
          received.resolve(undefined);
        }),
    );
    const mcpClient = await client();
    const pending = mcpClient.callTool({
      name: BRIDGE_TOOL_NAME,
      arguments: { tool_name: "mcp__d1__slow", input: {}, tool_use_id: "toolu_3" },
    });
    pending.catch(() => undefined);
    await received.promise;
    await mcpClient.close();
    // Resolved only by the abort listener: a bridge that never signals abandonment fails on the test's timeout.
    await abandoned.promise;
    bridge.setHandler(null);
  });
});
