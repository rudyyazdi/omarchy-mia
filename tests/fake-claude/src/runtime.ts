/**
 * Everything the fake writes to stdout imitates the real runtime's wire format, so those payloads stay
 * snake_case. The prompt text selects the behaviour: READ, CHANGE, SLOW, CRASH.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** The launch flags the fake acts on, as commander parsed them. */
export interface FakeClaudeFlags {
  model: string;
  mcpConfig: string;
  permissionPromptTool: string;
  sessionId?: string;
  resume?: string;
}

const McpConfigSchema = z.object({
  mcpServers: z.record(z.string(), z.looseObject({ url: z.string() })),
});
type McpConfig = z.infer<typeof McpConfigSchema>;
const PermissionResponseSchema = z.object({ behavior: z.string(), message: z.string().optional() });

const emit = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");

/** The first text block of a tool result, or undefined when the tool answered with none. */
const firstText = (result: Awaited<ReturnType<Client["callTool"]>>): string | undefined => {
  const first: unknown = Array.isArray(result.content) ? result.content[0] : undefined;
  if (typeof first !== "object" || first === null || !("text" in first)) return undefined;
  return typeof first.text === "string" ? first.text : undefined;
};

interface ToolUse {
  server: string;
  tool: string;
  input: Record<string, unknown>;
  toolUseId: string;
}

/** One fake turn's connection to the MCP servers and the approval bridge, and its stream-json output. */
class FakeTurn {
  readonly #sessionId: string;
  readonly #mcpConfig: McpConfig;
  readonly #bridgeServer: string | undefined;
  readonly #bridgeTool: string | undefined;

  constructor(flags: FakeClaudeFlags) {
    this.#sessionId = flags.sessionId ?? flags.resume ?? "fake-session";
    this.#mcpConfig = McpConfigSchema.parse(JSON.parse(readFileSync(flags.mcpConfig, "utf8")));
    [, this.#bridgeServer, this.#bridgeTool] =
      /^mcp__(.+?)__(.+)$/.exec(flags.permissionPromptTool) ?? [];
  }

  init(model: string): void {
    const servers = Object.keys(this.#mcpConfig.mcpServers);
    emit({
      type: "system",
      subtype: "init",
      session_id: this.#sessionId,
      model,
      tools: servers
        .filter((server) => server !== this.#bridgeServer)
        .map((server) => `mcp__${server}__read`),
      mcp_servers: servers.map((name) => ({ name, status: "connected" })),
      permissionMode: "default",
      claude_code_version: "fake-0.1",
      cwd: process.cwd(),
    });
  }

  say(text: string): void {
    emit({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      session_id: this.#sessionId,
    });
  }

  async useTool({ server, tool, input, toolUseId }: ToolUse): Promise<void> {
    const identity = `mcp__${server}__${tool}`;
    emit({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: toolUseId, name: identity, input: {} },
      },
      session_id: this.#sessionId,
    });
    emit({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: toolUseId, name: identity, input }],
      },
      session_id: this.#sessionId,
    });
    const decision = await this.#askPermission(identity, input, toolUseId);
    if (decision.behavior !== "allow") {
      this.#toolResult(toolUseId, `denied: ${decision.message ?? ""}`, true);
      return;
    }
    const client = await this.#mcpClient(server);
    try {
      const result = await client.callTool({ name: tool, arguments: input });
      this.#toolResult(toolUseId, firstText(result) ?? "", result.isError === true);
    } finally {
      await client.close();
    }
  }

  result(durationMs: number): void {
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: durationMs,
      num_turns: 1,
      result: "done",
      session_id: this.#sessionId,
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }

  #toolResult(toolUseId: string, content: string, isError: boolean): void {
    emit({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
      },
      session_id: this.#sessionId,
    });
  }

  async #mcpClient(server: string): Promise<Client> {
    const entry = this.#mcpConfig.mcpServers[server];
    if (!entry) throw new Error(`mcp server ${server} is not in --mcp-config`);
    const client = new Client({ name: "fake-claude", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(entry.url)));
    return client;
  }

  async #askPermission(
    toolName: string,
    input: unknown,
    toolUseId: string,
  ): Promise<{ behavior: string; message?: string }> {
    if (!this.#bridgeServer || !this.#bridgeTool)
      return { behavior: "deny", message: "no permission tool configured" };
    const client = await this.#mcpClient(this.#bridgeServer);
    try {
      const result = await client.callTool({
        name: this.#bridgeTool,
        arguments: { tool_name: toolName, input, tool_use_id: toolUseId },
      });
      const text = firstText(result);
      if (text === undefined) throw new Error("permission tool returned no text");
      return PermissionResponseSchema.parse(JSON.parse(text));
    } finally {
      await client.close();
    }
  }
}

/** Reads the prompt from stdin, plays the behaviours it names, and exits as the real runtime would. */
export const runFakeClaude = async (flags: FakeClaudeFlags): Promise<void> => {
  const turn = new FakeTurn(flags);
  let prompt = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) prompt += chunk;
  turn.init(flags.model);

  const start = Date.now();
  turn.say("Fake runtime: ");
  if (/READ/.test(prompt)) {
    turn.say("reading.");
    await turn.useTool({ server: "d1", tool: "read", input: {}, toolUseId: "toolu_fake_read_1" });
  }
  if (/CHANGE/.test(prompt)) {
    turn.say("changing.");
    await turn.useTool({
      server: "d1",
      tool: "change",
      input: { delta: 1 },
      toolUseId: "toolu_fake_change_1",
    });
  }
  if (/SLOW/.test(prompt)) {
    turn.say("slow.");
    await turn.useTool({
      server: "d1",
      tool: "slow",
      input: { mode: /UNCANCELLABLE/.test(prompt) ? "uncancellable" : "cancellable" },
      toolUseId: "toolu_fake_slow_1",
    });
    await turn.useTool({
      server: "d1",
      tool: "change",
      input: { delta: 1 },
      toolUseId: "toolu_fake_change_after_slow",
    });
  }
  if (/CRASH/.test(prompt)) process.exit(3);
  turn.result(Date.now() - start);
  process.exit(0);
};
