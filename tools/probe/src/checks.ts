import { match } from "ts-pattern";
import { z } from "zod";
import type { AdapterEvent } from "@mia/agent-adapter";
import type { StepRecord } from "./context.ts";

/** Pure readings of recorded step evidence that the probe's checks are built from. */

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

export const describeEvent = (event: AdapterEvent): string =>
  match(event)
    .with(
      { type: "tool_proposed" },
      (proposed) => `${proposed.toolIdentity} ${proposed.runtimeCallId}`,
    )
    .with({ type: "runtime_stderr" }, (stderr) => stderr.text.trim())
    .otherwise(() => "");

/** The first event of a type across the recorded steps, in step order. */
export const firstEvent = <T extends AdapterEvent["type"]>(
  records: StepRecord[],
  type: T,
): Extract<AdapterEvent, { type: T }> | undefined => {
  const isWanted = (event: AdapterEvent): event is Extract<AdapterEvent, { type: T }> =>
    event.type === type;
  for (const record of records) {
    const found = record.events.find(isWanted);
    if (found) return found;
  }
  return undefined;
};
