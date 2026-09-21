import { z } from "zod";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpServer, startMcpHttpServer, type McpHttpServerHandle } from "@mia/mcp-http";

export const BRIDGE_SERVER_NAME = "mia_approval";
export const BRIDGE_TOOL_NAME = "request";
export const BRIDGE_TOOL_IDENTITY = `mcp__${BRIDGE_SERVER_NAME}__${BRIDGE_TOOL_NAME}`;

/** Payload observed from Claude Code 2.1.x: { tool_name, input, tool_use_id }. Extra fields are retained raw. */
export const PermissionRequestPayloadSchema = z
  .object({
    tool_name: z.string(),
    input: z.unknown().optional(),
    tool_use_id: z.string().optional(),
  })
  .passthrough();

export interface PermissionRequest {
  tool_name: string;
  input: unknown;
  /** Runtime call identity; undefined if the runtime did not supply one (then the call must be rejected). */
  tool_use_id: string | undefined;
  raw: unknown;
  received_at: string;
  /** Aborts if the runtime abandons the prompt (turn aborted or connection closed) before a decision. */
  abandoned: AbortSignal;
}

export type PermissionDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string; interrupt?: boolean };

export type PermissionHandler = (request: PermissionRequest) => Promise<PermissionDecision>;

/**
 * The approval bridge: an MCP server Claude Code calls (via --permission-prompt-tool) for every
 * tool call its rules do not already deny. It holds the call until Mia's handler decides.
 * Without an active handler it denies: no decision is ever inferred.
 */
export class ApprovalBridge {
  private handler: PermissionHandler | null = null;
  private http: McpHttpServerHandle | null = null;

  get url(): string {
    if (!this.http) throw new Error("bridge not started");
    return this.http.url;
  }

  setHandler(handler: PermissionHandler | null): void {
    this.handler = handler;
  }

  async start(host = "127.0.0.1", port = 0): Promise<string> {
    this.http = await startMcpHttpServer({
      host,
      port,
      createServer: (ctx) => {
        const server = new McpServer({ name: BRIDGE_SERVER_NAME, version: "0.1.0" }, { capabilities: { tools: {} } });
        server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [
            {
              name: BRIDGE_TOOL_NAME,
              description: "Mia approval bridge. Holds a proposed tool call until the authenticated user decides.",
              inputSchema: {
                type: "object",
                properties: {
                  tool_name: { type: "string" },
                  input: { type: "object" },
                  tool_use_id: { type: "string" },
                },
                required: ["tool_name"],
              },
            },
          ],
        }));
        server.server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
          const received_at = new Date().toISOString();
          if (req.params.name !== BRIDGE_TOOL_NAME) {
            return { isError: true, content: [{ type: "text", text: JSON.stringify({ behavior: "deny", message: "unknown bridge tool" }) }] };
          }
          const parsed = PermissionRequestPayloadSchema.safeParse(req.params.arguments ?? {});
          const respond = (decision: PermissionDecision) => ({ content: [{ type: "text" as const, text: JSON.stringify(decision) }] });
          if (!parsed.success) return respond({ behavior: "deny", message: `Mia rejected a malformed permission request: ${parsed.error.message.slice(0, 200)}` });
          const handler = this.handler;
          if (!handler) return respond({ behavior: "deny", message: "Mia has no active task accepting tool calls." });
          try {
            const decision = await handler({
              tool_name: parsed.data.tool_name,
              input: parsed.data.input ?? {},
              tool_use_id: parsed.data.tool_use_id,
              raw: req.params.arguments,
              received_at,
              abandoned: AbortSignal.any([extra.signal, ctx.connectionClosed]),
            });
            return respond(decision);
          } catch (error) {
            return respond({ behavior: "deny", message: `Mia could not evaluate this call: ${error instanceof Error ? error.message : String(error)}` });
          }
        });
        return server;
      },
    });
    return this.http.url;
  }

  async close(): Promise<void> {
    await this.http?.close();
    this.http = null;
  }
}
