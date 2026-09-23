import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  hookEvidenceFrom,
  prepareLaunch,
  readRuntimeFile,
  writeLaunchFiles,
} from "@mia/agent-adapter";
import type { SlowMode } from "@mia/controlled-mcp";
import {
  effortsOf,
  followupChecks,
  interruptCancellableChecks,
  interruptUncancellableChecks,
  resumeChecks,
  streamApproveChecks,
} from "./checks.ts";
import { log, type ProbeContext } from "./context.ts";
import type { StepRecord } from "./record.ts";

// Each step is one live experiment: it runs its turn(s), then records and saves its checks.

/**
 * The two interruption steps are the same experiment twice: same profile, everything allowed, kill
 * the runtime the moment the fixture reports `entered`. Only the fixture mode and what the harness
 * does after the kill differ, so those are the only arguments.
 */
const runInterruptStep = (
  context: ProbeContext,
  args: {
    mode: SlowMode;
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
      const entered = await context.harness.waitEntered({
        signal: context.deadlines.slowEntered(),
      });
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
  Object.assign(step.checks, streamApproveChecks(step));
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
  Object.assign(step.checks, followupChecks(step));
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
        { signal: context.deadlines.ledgerSettled() },
      );
    },
  });
  Object.assign(step.checks, interruptCancellableChecks(step));
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
  Object.assign(step.checks, resumeChecks(step));
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
      await context.harness.waitForState((state) => state.counter >= 1, {
        signal: context.deadlines.ledgerSettled(),
      });
    },
  });
  Object.assign(step.checks, interruptUncancellableChecks(step));
  log("checks", step.checks, step.notes);
  context.save("step-5-checks", { checks: step.checks, notes: step.notes });
};

/** Control: without --effort, the injected settings layer should show through in hook evidence. */
export const effortControl = async (context: ProbeContext): Promise<void> => {
  const s4 = randomUUID();
  const config = context.baseConfig({ extraSettings: { effortLevel: "high" } });
  const runtimeDir = context.runtimeDir(s4);
  const plan = prepareLaunch({
    config,
    runtimeDir,
    bridgeUrl: context.bridgeUrl,
    sessionId: s4,
    resume: false,
    turnIndex: 1,
    agentPromptFile: config.agentPromptFile,
    env: context.env,
  });
  await writeLaunchFiles(plan.setup);
  const idx = plan.args.indexOf("--effort");
  const args = [...plan.args];
  if (idx >= 0) args.splice(idx, 2);
  context.takeLiveCall("effort-control", config.model);
  log("effort-control launches without --effort");
  const { stdout, exit } = await context.withBridgeHandler(
    async () => ({ behavior: "allow" }),
    async () => {
      const child = spawn(plan.command, args, {
        cwd: plan.cwd,
        env: plan.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin.end("Call d1.read once and report the counter.");
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (output += chunk));
      const { promise: exited, resolve: resolveExit } = Promise.withResolvers<number | null>();
      child.once("close", (code) => resolveExit(code));
      return { stdout: output, exit: await exited };
    },
  );
  const hooks = hookEvidenceFrom(await readRuntimeFile(plan.files.hookEvidence));
  const control = {
    exit,
    efforts: effortsOf(hooks.records),
    hook_evidence_malformed_lines: hooks.malformedLines,
    hook_evidence_read_error: hooks.readError,
    stdout_lines: stdout.split("\n").filter(Boolean).length,
  };
  writeFileSync(join(runtimeDir, "control.stream.jsonl"), stdout, { mode: 0o600 });
  context.save("step-6-effort-control", control);
  log("effort-control", control);
};
