import { z } from "zod";

/**
 * Loose schemas for the Claude Code stream-json output. Only the fields Mia relies on are typed;
 * everything else is preserved as raw and retained (redacted) as evidence.
 */
const base = z.object({ type: z.string(), session_id: z.string().optional(), uuid: z.string().optional() }).passthrough();

export const InitMessageSchema = base.extend({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: z.string(),
  model: z.string(),
  tools: z.array(z.string()),
  mcp_servers: z.array(z.object({ name: z.string(), status: z.string() }).passthrough()),
  permissionMode: z.string().optional(),
  claude_code_version: z.string().optional(),
  cwd: z.string().optional(),
  apiKeySource: z.string().optional(),
});

export const OtherSystemMessageSchema = base.extend({ type: z.literal("system"), subtype: z.string() });

const contentBlock = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    input: z.unknown().optional(),
    tool_use_id: z.string().optional(),
    content: z.unknown().optional(),
    is_error: z.boolean().optional(),
  })
  .passthrough();

export const AssistantMessageSchema = base.extend({
  type: z.literal("assistant"),
  message: z.object({ role: z.literal("assistant"), content: z.array(contentBlock), model: z.string().optional() }).passthrough(),
  parent_tool_use_id: z.string().nullable().optional(),
});

export const UserMessageSchema = base.extend({
  type: z.literal("user"),
  message: z.object({ role: z.literal("user"), content: z.union([z.string(), z.array(contentBlock)]) }).passthrough(),
  parent_tool_use_id: z.string().nullable().optional(),
  tool_use_result: z.unknown().optional(),
});

export const StreamEventSchema = base.extend({
  type: z.literal("stream_event"),
  event: z
    .object({
      type: z.string(),
      index: z.number().optional(),
      content_block: contentBlock.optional(),
      delta: z.object({ type: z.string().optional(), text: z.string().optional(), partial_json: z.string().optional() }).passthrough().optional(),
      message: z.unknown().optional(),
      usage: z.unknown().optional(),
    })
    .passthrough(),
  parent_tool_use_id: z.string().nullable().optional(),
});

export const ResultMessageSchema = base.extend({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  duration_ms: z.number().optional(),
  duration_api_ms: z.number().optional(),
  num_turns: z.number().optional(),
  result: z.string().optional(),
  session_id: z.string(),
  total_cost_usd: z.number().optional(),
  usage: z.unknown().optional(),
  modelUsage: z.unknown().optional(),
  permission_denials: z.array(z.unknown()).optional(),
  errors: z.array(z.unknown()).optional(),
});

export const KnownMessageSchema = z.union([
  InitMessageSchema,
  OtherSystemMessageSchema,
  AssistantMessageSchema,
  UserMessageSchema,
  StreamEventSchema,
  ResultMessageSchema,
]);
export type KnownMessage = z.infer<typeof KnownMessageSchema>;
/** Any other well-formed runtime message (e.g. rate_limit_event): retained as evidence, not acted on. */
export type OtherMessage = { type: "other"; original_type: string; raw: unknown };
export type RuntimeMessage = KnownMessage | OtherMessage;
export type InitMessage = z.infer<typeof InitMessageSchema>;
export type ResultMessage = z.infer<typeof ResultMessageSchema>;

export type ParsedLine =
  | { ok: true; message: RuntimeMessage; raw: string }
  | { ok: false; raw: string; error: string };

export function parseStreamLine(line: string): ParsedLine | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (error) {
    return { ok: false, raw: trimmed, error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = KnownMessageSchema.safeParse(json);
  if (parsed.success) return { ok: true, message: parsed.data, raw: trimmed };
  const other = base.safeParse(json);
  const knownTypes = new Set(["system", "assistant", "user", "stream_event", "result"]);
  if (other.success && !knownTypes.has(other.data.type)) return { ok: true, message: { type: "other", original_type: other.data.type, raw: json }, raw: trimmed };
  return { ok: false, raw: trimmed, error: `malformed runtime message: ${parsed.error.message.slice(0, 300)}` };
}

/** Incremental newline-delimited JSON splitter. */
export class LineSplitter {
  private buffer = "";
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines;
  }
  flush(): string[] {
    const rest = this.buffer;
    this.buffer = "";
    return rest.length > 0 ? [rest] : [];
  }
}
