import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probeStaticCapabilitiesSync, type StaticCapabilities } from "@mia/agent-adapter";
import { redactValue } from "@mia/protocol";
import { firstEvent } from "./checks.ts";
import { log, ProbeContext } from "./context.ts";
import type { ProbeDeadlines, ProbeOptions } from "./record.ts";
import {
  effortControl,
  followupEveryCallDeny,
  interruptCancellable,
  interruptUncancellable,
  resumeAfterKill,
  streamApprove,
} from "./steps.ts";

/** Freezes redacted protocol examples from the recorded steps under the examples directory. */
const freezeExamples = (context: ProbeContext, staticReport: StaticCapabilities): void => {
  const { records } = context;
  const examples: Record<string, unknown> = {
    captured_at: new Date().toISOString(),
    runtime_version: staticReport.runtime_version,
    adapter_version: staticReport.adapter_version,
    model: context.options.model,
    init: firstEvent(records, "runtime_init")?.init.evidence ?? null,
    tool_proposed: firstEvent(records, "tool_proposed") ?? null,
    permission_request_payload:
      records.find((record) => record.permission_requests.length > 0)?.permission_requests[0]
        ?.request ?? null,
    permission_response_examples: [
      { behavior: "allow" },
      { behavior: "deny", message: "The user rejected this call." },
    ],
    tool_result: firstEvent(records, "tool_result") ?? null,
    turn_result: firstEvent(records, "turn_result")?.summary.evidence ?? null,
    hook_evidence: records[0]?.hook_evidence ?? null,
    launch_description: records[0]?.turn?.launch ?? null,
  };
  writeFileSync(
    join(context.dirs.examples, "captured-examples.json"),
    JSON.stringify(redactValue(examples), null, 2),
  );
  // stream sample: first 40 raw lines of the first turn
  const firstStream = records[0]?.turn?.streamLogPath;
  if (firstStream && existsSync(firstStream)) {
    const lines = readFileSync(firstStream, "utf8").split("\n").filter(Boolean);
    writeFileSync(
      join(context.dirs.examples, "stream-sample.jsonl"),
      lines.slice(0, 40).join("\n") + "\n",
    );
  }
};

/** Runs the static probe and then every wanted live step; resolves to the process exit code. */
const runSteps = async (context: ProbeContext): Promise<number> => {
  const staticReport = probeStaticCapabilitiesSync(context.baseConfig(), context.env);
  context.save("static-capabilities", staticReport);
  log("static:", JSON.stringify(staticReport, null, 1));
  if (staticReport.errors.length > 0) {
    console.error(
      "Static probe found blockers:\n" +
        staticReport.errors.map((problem) => ` - ${problem}`).join("\n"),
    );
    return 1;
  }

  const s1 = randomUUID();
  if (context.wants("stream-approve")) await streamApprove(context, s1);
  if (context.wants("followup-everycall-deny")) await followupEveryCallDeny(context, s1);
  const s2 = randomUUID();
  if (context.wants("interrupt-cancellable")) await interruptCancellable(context, s2);
  if (context.wants("resume-after-kill")) await resumeAfterKill(context, s2);
  if (context.wants("interrupt-uncancellable")) await interruptUncancellable(context);
  if (context.wants("effort-control")) await effortControl(context);

  freezeExamples(context, staticReport);
  context.save("summary", {
    static: staticReport,
    steps: context.records.map((record) => ({
      name: record.name,
      checks: record.checks,
      notes: record.notes,
      status: record.turn?.status,
      error: record.turn?.error,
    })),
    live_calls_used: context.liveCallsUsed(),
  });
  log("done. evidence in", context.dirs.out);
  return 0;
};

/**
 * D1 capability probe: proves, against the real installed runtime, the behaviours the adapter relies on.
 * Every live turn is counted against the shared live-call budget. Evidence lands in an out directory;
 * redacted protocol examples are frozen under the examples directory. `env` is the environment the
 * runtime inherits and supplies the live-call budget's overrides, and `deadlines` bound each wait on
 * the fixture. Resolves to the exit code once the fixture and bridge are released.
 */
export const runProbe = async (
  options: ProbeOptions,
  env: NodeJS.ProcessEnv,
  deadlines: ProbeDeadlines,
): Promise<number> => {
  const context = await ProbeContext.start(options, env, deadlines);
  try {
    return await runSteps(context);
  } finally {
    await context.close();
  }
};

export type { ProbeDeadlines, ProbeOptions };
