import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { z } from "zod";
import { isRecord } from "@mia/protocol";

/**
 * The `_meta` key under which Claude Code sends the tool-use id of a `tools/call` request: the id its stream-json
 * output gives the same call, so a body log line and a recorded tool call can be matched.
 */
export const TOOL_USE_ID_META = "claudecode/toolUseId";

export const BodyDirectionSchema = z.enum(["request", "response"]);
export type BodyDirection = z.infer<typeof BodyDirectionSchema>;

/** One line of a body log: one JSON-RPC message of a `tools/call` exchange, keyed by the call's tool-use id. */
export const BodyLogLineSchema = z.object({
  tool_use_id: z.string(),
  direction: BodyDirectionSchema,
  body: z.unknown(),
});
export type BodyLogLine = z.infer<typeof BodyLogLineSchema>;

/** A JSON-RPC id: what pairs a response with its request inside one HTTP exchange. */
type RpcId = string | number;

const ToolCallRequestSchema = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.literal("tools/call"),
  params: z.object({ _meta: z.object({ [TOOL_USE_ID_META]: z.string() }) }),
});

/**
 * The `tools/call` requests in one HTTP request body (a single message or a batch), each with its tool-use id,
 * by JSON-RPC id. A call without a tool-use id cannot be matched to a recorded call, so it is left out.
 */
export const toolCallsIn = (body: unknown): Map<RpcId, { toolUseId: string; body: unknown }> => {
  const calls = new Map<RpcId, { toolUseId: string; body: unknown }>();
  for (const message of Array.isArray(body) ? body : [body]) {
    const call = ToolCallRequestSchema.safeParse(message);
    if (call.success)
      calls.set(call.data.id, {
        toolUseId: call.data.params._meta[TOOL_USE_ID_META],
        body: message,
      });
  }
  return calls;
};

/** The id of a JSON-RPC response (a result or an error), or null for any other message, such as a notification. */
export const responseId = (message: unknown): RpcId | null => {
  if (!isRecord(message) || !("result" in message || "error" in message)) return null;
  const { id } = message;
  return typeof id === "string" || typeof id === "number" ? id : null;
};

/**
 * The lines of a body log for one tool use, in log order. A line that is not a body log line (the truncated last
 * line of a process killed mid-write) is skipped and counted.
 */
export const bodyLogLinesFor = (
  text: string,
  toolUseId: string,
): { lines: BodyLogLine[]; malformed: number } => {
  const lines: BodyLogLine[] = [];
  let malformed = 0;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      malformed += 1;
      continue;
    }
    const line = BodyLogLineSchema.safeParse(json);
    if (!line.success) malformed += 1;
    else if (line.data.tool_use_id === toolUseId) lines.push(line.data);
  }
  return { lines, malformed };
};

/** Appends body log lines; `append` resolves once the line is written, so a reader then sees it. */
export interface BodyLog {
  /** Resolves once `line` is written, or at once when logging has failed; never rejects. */
  append(line: BodyLogLine): Promise<void>;
  /** Waits for the lines already appended and closes the file; later appends are ignored. Safe to call again. */
  close(): Promise<void>;
}

/**
 * A body log on `file`, opened (and created, owner-only) on the first line. Lines are written one at a time, in
 * the order they were appended, so two exchanges never interleave within a line. The first failure goes to
 * `reportFailure` and turns logging off: the log is evidence for tests, and a failed write must not fail the MCP
 * request it describes. The lines waiting to be written are the messages of the requests being served, so the
 * queue is bounded by what the server is serving.
 */
export const createBodyLog = (options: {
  file: string;
  reportFailure: (error: unknown) => void;
}): BodyLog => {
  const { file, reportFailure } = options;
  let handle: Promise<FileHandle> | null = null;
  let state: "open" | "closed" | "failed" = "open";
  let written: Promise<void> = Promise.resolve();
  let closing: Promise<void> | null = null;
  const write = async (line: BodyLogLine): Promise<void> => {
    if (state === "failed") return;
    try {
      handle ??= open(file, "a", 0o600);
      await (await handle).appendFile(JSON.stringify(line) + "\n");
    } catch (error) {
      // Writes run one at a time, so this is the first failure.
      state = "failed";
      reportFailure(error);
    }
  };
  return {
    append: (line) => {
      if (state !== "open") return Promise.resolve();
      // `write` never rejects, so the chain never does either.
      written = written.then(() => write(line));
      return written;
    },
    close: () => {
      if (state === "open") state = "closed";
      closing ??= written.then(async () => {
        // A failed open or close loses nothing: every line was either written or reported already.
        await (await handle?.catch(() => null))?.close().catch(() => undefined);
      });
      return closing;
    },
  };
};
