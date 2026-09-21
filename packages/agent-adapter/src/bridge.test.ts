import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApprovalBridge, BRIDGE_TOOL_NAME } from "./bridge.ts";

let bridge: ApprovalBridge;
beforeAll(async () => {
  bridge = new ApprovalBridge();
  await bridge.start();
});
afterAll(async () => bridge.close());

async function client() {
  const c = new Client({ name: "bridge-test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(bridge.url)));
  return c;
}

describe("approval bridge", () => {
  it("lists the request tool", async () => {
    const c = await client();
    const tools = await c.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual([BRIDGE_TOOL_NAME]);
    await c.close();
  });

  it("denies when no handler is active", async () => {
    const c = await client();
    const r = await c.callTool({ name: BRIDGE_TOOL_NAME, arguments: { tool_name: "mcp__d1__change", input: { delta: 1 }, tool_use_id: "toolu_1" } });
    const text = (r.content as Array<{ text: string }>)[0]!.text;
    expect(JSON.parse(text).behavior).toBe("deny");
    await c.close();
  });

  it("routes to the handler with tool_use_id and returns its decision", async () => {
    bridge.setHandler(async (req) => {
      expect(req.tool_use_id).toBe("toolu_2");
      expect(req.input).toEqual({ delta: 1 });
      return { behavior: "allow" };
    });
    const c = await client();
    const r = await c.callTool({ name: BRIDGE_TOOL_NAME, arguments: { tool_name: "mcp__d1__change", input: { delta: 1 }, tool_use_id: "toolu_2" } });
    expect(JSON.parse((r.content as Array<{ text: string }>)[0]!.text)).toEqual({ behavior: "allow" });
    bridge.setHandler(null);
    await c.close();
  });

  it("signals abandonment when the caller disconnects before a decision", async () => {
    let abandoned = false;
    bridge.setHandler(
      (req) =>
        new Promise((resolve) => {
          req.abandoned.addEventListener("abort", () => {
            abandoned = true;
            resolve({ behavior: "deny", message: "abandoned" });
          });
        }),
    );
    const c = await client();
    const p = c.callTool({ name: BRIDGE_TOOL_NAME, arguments: { tool_name: "mcp__d1__slow", input: {}, tool_use_id: "toolu_3" } });
    p.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    await c.close();
    for (let i = 0; i < 100 && !abandoned; i++) await new Promise((r) => setTimeout(r, 10));
    expect(abandoned).toBe(true);
    bridge.setHandler(null);
  });
});
