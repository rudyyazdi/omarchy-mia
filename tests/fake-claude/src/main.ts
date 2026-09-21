/**
 * Fake Claude Code executable for offline end-to-end tests of the real adapter: honours the launch flags
 * Mia passes, speaks stream-json on stdout, asks the approval bridge for permission over MCP exactly like the
 * runtime does, and calls fixture tools. The prompt text selects the behaviour: READ, CHANGE, SLOW.
 */
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sessionId = flag("--session-id") ?? flag("--resume") ?? "fake-session";
const mcpConfig = JSON.parse(readFileSync(flag("--mcp-config")!, "utf8")) as {
  mcpServers: Record<string, { url: string }>;
};
const permissionTool = flag("--permission-prompt-tool") ?? "";
const [, bridgeServer, bridgeTool] = /^mcp__(.+?)__(.+)$/.exec(permissionTool) ?? [];
const model = flag("--model") ?? "fake";
let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;

const emit = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
const now = () => new Date().toISOString();
emit({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  model,
  tools: Object.keys(mcpConfig.mcpServers)
    .filter((s) => s !== bridgeServer)
    .map((s) => `mcp__${s}__read`),
  mcp_servers: Object.keys(mcpConfig.mcpServers).map((name) => ({ name, status: "connected" })),
  permissionMode: "default",
  claude_code_version: "fake-0.1",
  cwd: process.cwd(),
});

async function mcpClient(server: string): Promise<Client> {
  const c = new Client({ name: "fake-claude", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(mcpConfig.mcpServers[server]!.url)));
  return c;
}

async function askPermission(
  toolName: string,
  input: unknown,
  toolUseId: string,
): Promise<{ behavior: string; message?: string }> {
  if (!bridgeServer || !bridgeTool)
    return { behavior: "deny", message: "no permission tool configured" };
  const c = await mcpClient(bridgeServer);
  try {
    const r = await c.callTool({
      name: bridgeTool,
      arguments: { tool_name: toolName, input, tool_use_id: toolUseId },
    });
    return JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as {
      behavior: string;
      message?: string;
    };
  } finally {
    await c.close();
  }
}

async function useTool(
  server: string,
  tool: string,
  input: Record<string, unknown>,
  toolUseId: string,
): Promise<void> {
  const identity = `mcp__${server}__${tool}`;
  emit({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: toolUseId, name: identity, input: {} },
    },
    session_id: sessionId,
  });
  emit({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name: identity, input }],
    },
    session_id: sessionId,
  });
  const decision = await askPermission(identity, input, toolUseId);
  if (decision.behavior !== "allow") {
    emit({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: `denied: ${decision.message ?? ""}`,
            is_error: true,
          },
        ],
      },
      session_id: sessionId,
    });
    return;
  }
  const c = await mcpClient(server);
  try {
    const r = await c.callTool({ name: tool, arguments: input });
    emit({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: (r.content as Array<{ text: string }>)[0]?.text ?? "",
            is_error: r.isError === true,
          },
        ],
      },
      session_id: sessionId,
    });
  } finally {
    await c.close();
  }
}

const say = (text: string) =>
  emit({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    session_id: sessionId,
  });

const start = Date.now();
say("Fake runtime: ");
if (/READ/.test(prompt)) {
  say("reading.");
  await useTool("d1", "read", {}, "toolu_fake_read_1");
}
if (/CHANGE/.test(prompt)) {
  say("changing.");
  await useTool("d1", "change", { delta: 1 }, "toolu_fake_change_1");
}
if (/SLOW/.test(prompt)) {
  say("slow.");
  await useTool(
    "d1",
    "slow",
    { mode: /UNCANCELLABLE/.test(prompt) ? "uncancellable" : "cancellable" },
    "toolu_fake_slow_1",
  );
  await useTool("d1", "change", { delta: 1 }, "toolu_fake_change_after_slow");
}
if (/CRASH/.test(prompt)) process.exit(3);
emit({
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: Date.now() - start,
  num_turns: 1,
  result: "done",
  session_id: sessionId,
  total_cost_usd: 0,
  usage: { input_tokens: 1, output_tokens: 1 },
});
process.exit(0);
