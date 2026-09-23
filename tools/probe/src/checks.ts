import { z } from "zod";
import type { RuntimeEvent } from "@mia/agent-adapter";
import type { StepRecord } from "./record.ts";

// Pure readings of recorded step evidence, and the checks each step derives from them.

/** The raw permission payload the runtime sent to the bridge; fields it did not send read as undefined. */
const RawPermissionRequest = z.looseObject({
  tool_name: z.string().optional(),
  tool_use_id: z.string().optional(),
});
export const rawRequestsOf = (step: StepRecord): { tool_name?: string; tool_use_id?: string }[] =>
  step.permission_requests.map((entry) => {
    const parsed = RawPermissionRequest.safeParse(entry.request);
    return parsed.success ? parsed.data : {};
  });

/** Effort level per PreToolUse hook record: the hook's `effort` (object or string), else the env var it saw. */
const HookEffort = z.looseObject({
  effort: z.union([z.looseObject({ level: z.string().optional() }), z.string()]).optional(),
  env_claude_effort: z.string().nullish(),
});
export const effortsOf = (hooks: Record<string, unknown>[]): (string | undefined)[] =>
  hooks.map((hook) => {
    const parsed = HookEffort.safeParse(hook);
    if (!parsed.success) return undefined;
    const { effort, env_claude_effort: envEffort } = parsed.data;
    const level = typeof effort === "object" ? effort.level : effort;
    return level ?? envEffort ?? undefined;
  });

/** The first event of a type across the recorded steps, in step order. */
export const firstEvent = <T extends RuntimeEvent["type"]>(
  records: StepRecord[],
  type: T,
): Extract<RuntimeEvent, { type: T }> | undefined => {
  const isWanted = (event: RuntimeEvent): event is Extract<RuntimeEvent, { type: T }> =>
    event.type === type;
  for (const record of records) {
    const found = record.events.find(isWanted);
    if (found) return found;
  }
  return undefined;
};

export type StepChecks = StepRecord["checks"];

/** Streaming order, bridge routing, call-id binding, one commit, and which effort won. */
export const streamApproveChecks = (step: StepRecord): StepChecks => {
  const ledger = step.ledger_after?.ledger ?? [];
  const reqs = rawRequestsOf(step);
  const efforts = effortsOf(step.hook_evidence ?? []);
  return {
    deltas_before_result:
      step.events.findIndex((event) => event.type === "text_delta") <
      step.events.findIndex((event) => event.type === "turn_result"),
    read_routed_through_bridge: reqs.some((request) => request.tool_name === "mcp__d1__read"),
    change_routed_through_bridge: reqs.some((request) => request.tool_name === "mcp__d1__change"),
    tool_use_id_present_on_all_requests: reqs.every(
      (request) => typeof request.tool_use_id === "string" && request.tool_use_id.length > 0,
    ),
    tool_use_id_matches_streamed_tool_use: reqs.every((request) =>
      step.events.some(
        (event) =>
          event.type === "tool_proposed" &&
          event.runtimeCallId === request.tool_use_id &&
          event.toolIdentity === request.tool_name,
      ),
    ),
    exactly_one_commit: ledger.filter((entry) => entry.kind === "committed").length === 1,
    effort_evidence: efforts.length > 0 ? JSON.stringify(efforts) : "no hook evidence captured",
    effort_flag_beats_settings_layer:
      efforts.length > 0 && efforts.every((effort) => effort === "medium"),
    init_model: step.turn?.init?.model ?? "no init",
  };
};

/** Memory across turns, one approval per call, and a denied tool that never runs. */
export const followupChecks = (step: StepRecord): StepChecks => {
  const ledger = step.ledger_after?.ledger ?? [];
  const reqs = rawRequestsOf(step);
  const changeIds = reqs
    .filter((request) => request.tool_name === "mcp__d1__change")
    .map((request) => request.tool_use_id);
  return {
    marker_recalled: step.events.some(
      (event) => event.type === "assistant_message" && JSON.stringify(event.message).includes("K7"),
    ),
    two_distinct_change_requests: changeIds.length === 2 && new Set(changeIds).size === 2,
    commits_total_after_step: String(
      ledger.filter((entry) => entry.kind === "committed" && entry.tool === "change").length,
    ),
    forbidden_never_reached_bridge: !reqs.some(
      (request) => request.tool_name === "mcp__d1__forbidden",
    ),
    forbidden_never_executed: !ledger.some((entry) => entry.tool === "forbidden"),
    forbidden_proposed_by_model: step.events.some(
      (event) => event.type === "tool_proposed" && event.toolIdentity === "mcp__d1__forbidden",
    ),
    runtime_reported_denials: JSON.stringify(step.turn?.summary?.permissionDenials ?? null).slice(
      0,
      500,
    ),
  };
};

/** A killed runtime cancels the slow call and nothing commits or follows it. */
export const interruptCancellableChecks = (step: StepRecord): StepChecks => {
  const ledger = step.ledger_after?.ledger ?? [];
  return {
    slow_cancelled_in_ledger: ledger.some(
      (entry) => entry.kind === "cancelled" && entry.tool === "slow",
    ),
    zero_commits: ledger.filter((entry) => entry.kind === "committed").length === 0,
    no_change_proposed_after_interrupt: !step.events.some(
      (event) => event.type === "tool_proposed" && event.toolIdentity === "mcp__d1__change",
    ),
    runtime_exit: JSON.stringify(step.turn?.exit),
    runtime_cancellation: step.turn?.runtimeCancellation ?? "",
    result_message_received: step.turn?.summary !== null,
  };
};

/** The session resumes after the kill without calling tools. */
export const resumeChecks = (step: StepRecord): StepChecks => ({
  resumed_ok: step.turn?.status === "completed",
  no_tools_called: step.permission_requests.length === 0,
});

/** An uncancellable call commits once released; the follow-up call never does. */
export const interruptUncancellableChecks = (step: StepRecord): StepChecks => {
  const ledger = step.ledger_after?.ledger ?? [];
  return {
    slow_committed_after_release:
      ledger.filter((entry) => entry.kind === "committed" && entry.tool === "slow").length === 1,
    no_change_commit: !ledger.some(
      (entry) => entry.kind === "committed" && entry.tool === "change",
    ),
    runtime_cancellation: step.turn?.runtimeCancellation ?? "",
  };
};
