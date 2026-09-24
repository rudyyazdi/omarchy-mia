import { match } from "ts-pattern";
import type { RuntimeFileRead } from "@mia/agent-adapter";
import { bodyLogLinesFor, type BodyDirection } from "@mia/mcp-http";
import { redactValue } from "@mia/protocol";

/**
 * The most a body log may hold for a tool result to read it. The fixture's log only grows, and each read is the
 * whole file, so the cap bounds the memory and the parse one result costs; past it, calls record why their bodies
 * are missing instead.
 */
export const MAX_BODY_LOG_BYTES = 16 * 1024 * 1024;

/**
 * One MCP message of a call as debug mode records it: its body, redacted, or why no body was recorded. A call
 * records every line its tool-use id has, in log order (a runtime that re-sent the call has two requests), and a
 * direction with no line records one `unrecorded`, so a call's record never has a silent gap.
 */
export type McpBody =
  | { direction: BodyDirection; status: "recorded"; body: unknown }
  | { direction: BodyDirection; status: "unrecorded"; reason: string };

const DIRECTIONS: readonly BodyDirection[] = ["request", "response"];

const unrecorded = (reason: string): McpBody[] =>
  DIRECTIONS.map((direction) => ({ direction, status: "unrecorded", reason }));

/** What a tool result with tool-use id `toolUseId` records from its server's body log, read as `read`. */
export const mcpBodiesFrom = (read: RuntimeFileRead, toolUseId: string): McpBody[] =>
  match(read)
    .with({ status: "absent" }, () => unrecorded("the body log does not exist"))
    .with({ status: "unreadable" }, ({ reason }) =>
      unrecorded(`the body log is unreadable: ${reason}`),
    )
    .with({ status: "read" }, ({ bytes }) => {
      const { lines } = bodyLogLinesFor(bytes.toString("utf8"), toolUseId);
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
        reason: `the body log has no ${direction} for this call`,
      }));
      return [...recorded, ...missing];
    })
    .exhaustive();
