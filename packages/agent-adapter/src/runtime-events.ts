import type { LaunchPlan } from "./launch.ts";

/**
 * The runtime-independent contract between an agent runtime and the engine. A runtime's own message
 * format is translated into these at the adapter boundary; `evidence` carries the runtime's original
 * payload for the records and is never read to make a decision.
 */

/** What the runtime reported when its session started. */
export interface RuntimeInit {
  model: string;
  evidence: unknown;
}

/** What the runtime reported when the turn ended. */
export interface TurnSummary {
  /** The runtime reported the turn as failed. */
  isError: boolean;
  /** The runtime's own name for how the turn ended, e.g. "success" or "error_max_turns". */
  outcome: string;
  /** The runtime's closing text, when it gave one. */
  finalText?: string;
  /** The runtime's own token accounting, shaped as it reported it: forwarded and stored, never decided on. */
  usage?: unknown;
  totalCostUsd?: number;
  durationMs?: number;
  durationApiMs?: number;
  numTurns?: number;
  /** Tool calls the runtime itself reports having refused. */
  permissionDenials?: unknown[];
  evidence: unknown;
}

export type RuntimeEvent =
  | { type: "runtime_started"; pid: number; launch: LaunchPlan["description"]; at: string }
  | { type: "runtime_init"; init: RuntimeInit; at: string }
  | { type: "text_delta"; text: string; at: string }
  | {
      type: "tool_proposed";
      runtimeCallId: string;
      toolIdentity: string;
      arguments: unknown;
      complete: boolean;
      at: string;
    }
  | { type: "assistant_message"; message: unknown; at: string }
  | {
      type: "tool_result";
      runtimeCallId: string;
      isError: boolean;
      content: unknown;
      raw: unknown;
      at: string;
    }
  | { type: "turn_result"; summary: TurnSummary; at: string }
  | { type: "runtime_stderr"; text: string; at: string }
  | { type: "malformed_event"; raw: string; error: string; at: string }
  | { type: "runtime_exit"; code: number | null; signal: NodeJS.Signals | null; at: string };
