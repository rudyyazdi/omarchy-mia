import { match } from "ts-pattern";
import type { RuntimeFileRead } from "@mia/agent-adapter";
import { bodyLogLinesFor, type BodyDirection } from "@mia/mcp-http";
import { redactValue } from "@mia/protocol";
import type { McpContent } from "@mia/records";

/**
 * The most a body log may hold for Mia to read it, at a tool result or at turn end. The fixture's log only grows,
 * and each read is the whole file, so the cap bounds the memory a read costs and the parse each call it serves
 * costs; past it, calls record why their bodies are missing instead.
 */
export const MAX_BODY_LOG_BYTES = 16 * 1024 * 1024;

/**
 * One MCP message of a call as debug mode records it: its body, redacted, or why no body was recorded. A call
 * records every line its tool-use id has, in log order (a runtime that re-sent the call has two requests), and a
 * direction with no line records one `unrecorded`. Bodies are read at a call's tool result, or, for a released
 * call whose result never arrives (its turn interrupted or its runtime gone mid-call), at its turn's end, where
 * the call itself ends `unknown`.
 */
export type McpBody = { direction: BodyDirection } & McpContent;

/**
 * When a call's bodies are read. At its tool result a missing line means the log has none: the fixture writes a
 * request's line before handling it and a response's before sending it. At turn end the server may still be
 * handling a call the runtime gave up on, so a missing line only means none was written yet.
 */
export type BodyReadPoint = "tool_result" | "turn_end";

const missingReason = (direction: BodyDirection, readAt: BodyReadPoint): string =>
  match(readAt)
    .with("tool_result", () => `the body log has no ${direction} for this call`)
    .with("turn_end", () => `the body log had no ${direction} for this call when its turn ended`)
    .exhaustive();

const DIRECTIONS: readonly BodyDirection[] = ["request", "response"];

/** Both bodies of a call, unrecorded for `reason`. */
export const unrecordedBodies = (reason: string): McpBody[] =>
  DIRECTIONS.map((direction) => ({ direction, status: "unrecorded", reason }));

/** What a call with tool-use id `toolUseId` records from its server's body log, read as `read` at `readAt`. */
export const mcpBodiesFrom = (
  read: RuntimeFileRead,
  toolUseId: string,
  readAt: BodyReadPoint,
): McpBody[] =>
  match(read)
    .with({ status: "absent" }, () => unrecordedBodies("the body log does not exist"))
    .with({ status: "unreadable" }, ({ reason }) =>
      unrecordedBodies(`the body log is unreadable: ${reason}`),
    )
    .with({ status: "read" }, ({ bytes }) => {
      const lines = bodyLogLinesFor(bytes.toString("utf8"), toolUseId);
      const recorded = lines.map((line): McpBody => ({
        direction: line.direction,
        status: "recorded",
        body: redactValue(line.body),
      }));
      const missing = DIRECTIONS.filter(
        (direction) => !lines.some((line) => line.direction === direction),
      ).map((direction): McpBody => ({
        direction,
        status: "unrecorded",
        reason: missingReason(direction, readAt),
      }));
      return [...recorded, ...missing];
    })
    .exhaustive();
