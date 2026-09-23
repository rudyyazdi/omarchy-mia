import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareLaunch, readHookEvidence } from "@mia/agent-adapter";
import { effortsOf, rawRequestsOf } from "./checks.ts";
import { log, type ProbeContext, type StepRecord } from "./context.ts";

/** Each step is one live experiment: it runs its turn(s), then records and saves its checks. */

/**
 * The two interruption steps are the same experiment twice: same profile, everything allowed, kill
 * the runtime the moment the fixture reports `entered`. Only the fixture mode and what the harness
 * does after the kill differ, so those are the only arguments.
 */
const runInterruptStep = (
  context: ProbeContext,
  args: {
    mode: "cancellable" | "uncancellable";
    sessionId: string;
    afterKill: (entered: { call_id: string }, step: StepRecord) => Promise<void>;
  },
): Promise<StepRecord> =>
  context.runStep({
    name: `interrupt-${args.mode}`,
    config: context.baseConfig(),
    sessionId: args.sessionId,
    firstTurn: true,
    turnIndex: 1,
    prompt: `Call d1.slow with mode ${args.mode} exactly once. After it returns, call d1.change with delta 1 exactly once. Report the results.`,
    decide: () => ({ behavior: "allow" }),
    during: async (handle, step) => {
      const entered = await context.harness.waitEntered(120_000);
      step.notes.push(`slow entered ${entered.call_id} at ${new Date().toISOString()}`);
      const killRequested = Date.now();
      const outcome = await handle.interrupt();
      step.notes.push(`interrupt -> ${outcome} after ${Date.now() - killRequested}ms`);
      await args.afterKill(entered, step);
    },
  });

/** Session 1: streaming, allowed tool, approval payload, effort precedence. */
export const streamApprove = async (context: ProbeContext, sessionId: string): Promise<void> => {
  await context.harness.reset();
  const step = await context.runStep({
    name: "stream-approve",
    config: context.baseConfig({ extraSettings: { effortLevel: "high" } }),
    sessionId,
    firstTurn: true,
    turnIndex: 1,
    prompt:
      "Remember the marker K7. Then call d1.read once and report the counter. Then call d1.change with delta 1 exactly once and report the new counter. Do not retry any denied call.",
    decide: () => ({ behavior: "allow" }),
  });
  const ledger = step.ledger_after?.ledger ?? [];
  const reqs = rawRequestsOf(step);
  step.checks.deltas_before_result =
    step.events.findIndex((event) => event.type === "text_delta") <
    step.events.findIndex((event) => event.type === "turn_result");
  step.checks.read_routed_through_bridge = reqs.some(
    (request) => request.tool_name === "mcp__d1__read",
  );
  step.checks.change_routed_through_bridge = reqs.some(
    (request) => request.tool_name === "mcp__d1__change",
  );
  step.checks.tool_use_id_present_on_all_requests = reqs.every(
    (request) => typeof request.tool_use_id === "string" && request.tool_use_id.length > 0,
  );
  step.checks.tool_use_id_matches_streamed_tool_use = reqs.every((request) =>
    step.events.some(
      (event) =>
        event.type === "tool_proposed" &&
        event.runtimeCallId === request.tool_use_id &&
        event.toolIdentity === request.tool_name,
    ),
  );
  step.checks.exactly_one_commit =
    ledger.filter((entry) => entry.kind === "committed").length === 1;
  const efforts = effortsOf(step.hook_evidence ?? []);
  step.checks.effort_evidence =
    efforts.length > 0 ? JSON.stringify(efforts) : "no hook evidence captured";
  step.checks.effort_flag_beats_settings_layer =
    efforts.length > 0 && efforts.every((effort) => effort === "medium");
  step.checks.init_model = step.turn?.init?.model ?? "no init";
  log("checks", step.checks);
  context.save("step-1-checks", step.checks);
};

/** Session 1 follow-up: memory across turns, per-call approval, deny rule. */
export const followupEveryCallDeny = async (
  context: ProbeContext,
  sessionId: string,
): Promise<void> => {
  let changeCount = 0;
  const step = await context.runStep({
    name: "followup-everycall-deny",
    config: context.baseConfig(),
    sessionId,
    firstTurn: false,
    turnIndex: 2,
    prompt:
      "First, what marker did I give you earlier? Then call d1.change with delta 1 twice, sequentially (two separate calls). Then call d1.forbidden once. Report what happened to each call. Do not retry any denied call.",
    decide: (request) => {
      if (request.toolName === "mcp__d1__change") {
        changeCount += 1;
        return changeCount === 1
          ? { behavior: "allow" }
          : { behavior: "deny", message: "The user rejected this call." };
      }
      return { behavior: "deny", message: "Not permitted." };
    },
  });
  const ledger = step.ledger_after?.ledger ?? [];
  const reqs = rawRequestsOf(step);
  const changeIds = reqs
    .filter((request) => request.tool_name === "mcp__d1__change")
    .map((request) => request.tool_use_id);
  step.checks.marker_recalled = step.events.some(
    (event) => event.type === "assistant_message" && JSON.stringify(event.message).includes("K7"),
  );
  step.checks.two_distinct_change_requests =
    changeIds.length === 2 && new Set(changeIds).size === 2;
  step.checks.commits_total_after_step = String(
    ledger.filter((entry) => entry.kind === "committed" && entry.tool === "change").length,
  );
  step.checks.forbidden_never_reached_bridge = !reqs.some(
    (request) => request.tool_name === "mcp__d1__forbidden",
  );
  step.checks.forbidden_never_executed = !ledger.some((entry) => entry.tool === "forbidden");
  step.checks.forbidden_proposed_by_model = step.events.some(
    (event) => event.type === "tool_proposed" && event.toolIdentity === "mcp__d1__forbidden",
  );
  step.checks.runtime_reported_denials = JSON.stringify(
    step.turn?.result?.permission_denials ?? null,
  ).slice(0, 500);
  log("checks", step.checks);
  context.save("step-2-checks", step.checks);
};

/** Session 2: cancellable interruption. */
export const interruptCancellable = async (
  context: ProbeContext,
  sessionId: string,
): Promise<void> => {
  await context.harness.reset();
  const step = await runInterruptStep(context, {
    mode: "cancellable",
    sessionId,
    afterKill: async () => {
      await context.harness.waitForState(
        (state) =>
          state.ledger.some((entry) => entry.kind === "cancelled") || !state.pending.length,
      );
    },
  });
  const ledger = step.ledger_after?.ledger ?? [];
  step.checks.slow_cancelled_in_ledger = ledger.some(
    (entry) => entry.kind === "cancelled" && entry.tool === "slow",
  );
  step.checks.zero_commits = ledger.filter((entry) => entry.kind === "committed").length === 0;
  step.checks.no_change_proposed_after_interrupt = !step.events.some(
    (event) => event.type === "tool_proposed" && event.toolIdentity === "mcp__d1__change",
  );
  step.checks.runtime_exit = JSON.stringify(step.turn?.exit);
  step.checks.runtime_cancellation = step.turn?.runtimeCancellation ?? "";
  step.checks.result_message_received = step.turn?.result !== null;
  log("checks", step.checks, step.notes);
  context.save("step-3-checks", { checks: step.checks, notes: step.notes });
};

/** Session 2 follow-up: resume after the kill. */
export const resumeAfterKill = async (context: ProbeContext, sessionId: string): Promise<void> => {
  const step = await context.runStep({
    name: "resume-after-kill",
    config: context.baseConfig(),
    sessionId,
    firstTurn: false,
    turnIndex: 2,
    prompt:
      "In one or two sentences: what happened with the tool calls in your previous turn? Do not call any tools now.",
    decide: () => ({ behavior: "deny", message: "No tools are permitted in this turn." }),
  });
  step.checks.resumed_ok = step.turn?.status === "completed";
  step.checks.no_tools_called = step.permission_requests.length === 0;
  log("checks", step.checks);
  context.save("step-4-checks", step.checks);
};

/** Session 3: an uncancellable action survives interruption. */
export const interruptUncancellable = async (context: ProbeContext): Promise<void> => {
  await context.harness.reset();
  const s3 = randomUUID();
  const step = await runInterruptStep(context, {
    mode: "uncancellable",
    sessionId: s3,
    afterKill: async (entered, step) => {
      const before = await context.harness.state();
      step.notes.push(
        `after kill, before release: counter=${before.counter} pending=${before.pending.length}`,
      );
      await context.harness.release(entered.call_id);
      await context.harness.waitForState((state) => state.counter >= 1);
    },
  });
  const ledger = step.ledger_after?.ledger ?? [];
  step.checks.slow_committed_after_release =
    ledger.filter((entry) => entry.kind === "committed" && entry.tool === "slow").length === 1;
  step.checks.no_change_commit = !ledger.some(
    (entry) => entry.kind === "committed" && entry.tool === "change",
  );
  step.checks.runtime_cancellation = step.turn?.runtimeCancellation ?? "";
  log("checks", step.checks, step.notes);
  context.save("step-5-checks", { checks: step.checks, notes: step.notes });
};

/** Control: without --effort, the injected settings layer should show through in hook evidence. */
export const effortControl = async (context: ProbeContext): Promise<void> => {
  const s4 = randomUUID();
  const config = context.baseConfig({ extraSettings: { effortLevel: "high" } });
  const runtimeDir = join(context.dirs.out, "runtime", s4);
  const plan = prepareLaunch({
    config,
    runtimeDir,
    bridgeUrl: context.services.bridge.url,
    sessionId: s4,
    resume: false,
    turnIndex: 1,
    agentPromptFile: config.agentPromptFile,
  });
  const idx = plan.args.indexOf("--effort");
  const args = [...plan.args];
  if (idx >= 0) args.splice(idx, 2);
  const callNumber = context.services.budget.take("probe:effort-control", config.model);
  log(
    `step effort-control (live call ${callNumber}/${context.services.budget.cap}) — launching without --effort`,
  );
  context.services.bridge.setHandler(async () => ({ behavior: "allow" }));
  const child = spawn(plan.command, args, {
    cwd: plan.cwd,
    env: plan.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end("Call d1.read once and report the counter.");
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  const { promise: exited, resolve: resolveExit } = Promise.withResolvers<number | null>();
  child.once("close", (code) => resolveExit(code));
  const exit = await exited;
  context.services.bridge.setHandler(null);
  const efforts = effortsOf(readHookEvidence(plan.files.hookEvidence));
  const control = { exit, efforts, stdout_lines: stdout.split("\n").filter(Boolean).length };
  writeFileSync(join(runtimeDir, "control.stream.jsonl"), stdout, { mode: 0o600 });
  context.save("step-6-effort-control", control);
  log("effort-control", control);
};
