/**
 * Fake Claude Code executable for offline end-to-end tests of the real adapter: honours the launch flags
 * Mia passes, speaks stream-json on stdout, asks the approval bridge for permission over MCP exactly like the
 * runtime does, and calls fixture tools. The prompt text selects the behaviour: READ, CHANGE, SLOW.
 *
 * Everything it writes to stdout imitates the real runtime's wire format, so those payloads stay snake_case.
 */
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// The flags the real runtime accepts (see packages/agent-adapter/src/launch.ts); anything else is tolerated
// and ignored so the fake keeps working when the adapter adds a flag.
const program = new Command()
  .name("fake-claude")
  .allowUnknownOption()
  .allowExcessArguments()
  .option("-p")
  .option("--output-format <format>")
  .option("--verbose")
  .option("--include-partial-messages")
  .option("--model <model>", "model to report in the init message", "fake")
  .option("--effort <effort>")
  .option("--strict-mcp-config")
  .requiredOption("--mcp-config <path>", "MCP server configuration written by the adapter")
  .option("--settings <path>")
  .option("--permission-mode <mode>")
  .option("--permission-prompt-tool <identity>", "bridge tool to ask for permission", "")
  .option("--tools <list>")
  .option("--append-system-prompt-file <path>")
  .option("--session-id <id>")
  .option("--resume <id>")
  .option("--debug <category>")
  .option("--debug-file <path>");
program.parse();
const flags = program.opts<{
  model: string;
  mcpConfig: string;
  permissionPromptTool: string;
  sessionId?: string;
  resume?: string;
}>();

const McpConfigSchema = z.object({
  mcpServers: z.record(z.string(), z.looseObject({ url: z.string() })),
});
const PermissionResponseSchema = z.object({ behavior: z.string(), message: z.string().optional() });

const sessionId = flags.sessionId ?? flags.resume ?? "fake-session";
const mcpConfig = McpConfigSchema.parse(JSON.parse(readFileSync(flags.mcpConfig, "utf8")));
const [, bridgeServer, bridgeTool] = /^mcp__(.+?)__(.+)$/.exec(flags.permissionPromptTool) ?? [];
const model = flags.model;
let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;

const emit = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
emit({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  model,
  tools: Object.keys(mcpConfig.mcpServers)
    .filter((server) => server !== bridgeServer)
    .map((server) => `mcp__${server}__read`),
  mcp_servers: Object.keys(mcpConfig.mcpServers).map((name) => ({ name, status: "connected" })),
  permissionMode: "default",
  claude_code_version: "fake-0.1",
  cwd: process.cwd(),
});

const mcpClient = async (server: string): Promise<Client> => {
  const entry = mcpConfig.mcpServers[server];
  if (!entry) throw new Error(`mcp server ${server} is not in --mcp-config`);
  const client = new Client({ name: "fake-claude", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(entry.url)));
  return client;
};

/** The first text block of a tool result, or undefined when the tool answered with none. */
const firstText = (result: Awaited<ReturnType<Client["callTool"]>>): string | undefined => {
  const first: unknown = Array.isArray(result.content) ? result.content[0] : undefined;
  if (typeof first !== "object" || first === null || !("text" in first)) return undefined;
  return typeof first.text === "string" ? first.text : undefined;
};

const askPermission = async (
  toolName: string,
  input: unknown,
  toolUseId: string,
): Promise<{ behavior: string; message?: string }> => {
  if (!bridgeServer || !bridgeTool)
    return { behavior: "deny", message: "no permission tool configured" };
  const client = await mcpClient(bridgeServer);
  try {
    const result = await client.callTool({
      name: bridgeTool,
      arguments: { tool_name: toolName, input, tool_use_id: toolUseId },
    });
    const text = firstText(result);
    if (text === undefined) throw new Error("permission tool returned no text");
    return PermissionResponseSchema.parse(JSON.parse(text));
  } finally {
    await client.close();
  }
};

const useTool = async ({
  server,
  tool,
  input,
  toolUseId,
}: {
  server: string;
  tool: string;
  input: Record<string, unknown>;
  toolUseId: string;
}): Promise<void> => {
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
  const client = await mcpClient(server);
  try {
    const result = await client.callTool({ name: tool, arguments: input });
    emit({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: firstText(result) ?? "",
            is_error: result.isError === true,
          },
        ],
      },
      session_id: sessionId,
    });
  } finally {
    await client.close();
  }
};

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
  await useTool({ server: "d1", tool: "read", input: {}, toolUseId: "toolu_fake_read_1" });
}
if (/CHANGE/.test(prompt)) {
  say("changing.");
  await useTool({
    server: "d1",
    tool: "change",
    input: { delta: 1 },
    toolUseId: "toolu_fake_change_1",
  });
}
if (/SLOW/.test(prompt)) {
  say("slow.");
  await useTool({
    server: "d1",
    tool: "slow",
    input: { mode: /UNCANCELLABLE/.test(prompt) ? "uncancellable" : "cancellable" },
    toolUseId: "toolu_fake_slow_1",
  });
  await useTool({
    server: "d1",
    tool: "change",
    input: { delta: 1 },
    toolUseId: "toolu_fake_change_after_slow",
  });
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
