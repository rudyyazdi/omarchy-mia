/**
 * D1 capability probe: proves, against the real installed runtime, the behaviours the adapter relies on.
 * Every live turn is counted against the shared live-call budget. Evidence lands in an out directory;
 * redacted protocol examples are frozen under docs/D1/protocol-examples.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { Command } from "commander";
import { match } from "ts-pattern";
import { z } from "zod";
import {
  ApprovalBridge,
  ClaudeCodeAdapter,
  LiveCallBudget,
  probeStaticCapabilities,
  prepareLaunch,
  readHookEvidence,
  validateRuntimeConfig,
  type AdapterEvent,
  type PermissionDecision,
  type PermissionRequest,
  type RuntimeConfig,
  type TurnResult,
} from "@mia/agent-adapter";
import { FixtureHarness, startFixture, type FixtureState } from "@mia/controlled-mcp";
import { redactValue } from "@mia/protocol";

const program = new Command()
  .name("probe")
  .option("--model <model>", "runtime model to probe", "claude-sonnet-5")
  .option(
    "--out <dir>",
    "evidence directory (a timestamped subdirectory is created)",
    ".mia-state/probe",
  )
  .option(
    "--examples <dir>",
    "where redacted protocol examples are frozen",
    "docs/D1/protocol-examples",
  )
  .option("--only <names>", "comma-separated step names to run");
program.parse();
const values = program.opts<{ model: string; out: string; examples: string; only?: string }>();

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = resolve(values.out, stamp);
mkdirSync(outDir, { recursive: true, mode: 0o700 });
const examplesDir = resolve(values.examples);
mkdirSync(examplesDir, { recursive: true });
const budget = LiveCallBudget.fromEnv(resolve(".mia-state/live-calls.jsonl"));

const fixtureDir = join(outDir, "fixture");
const fixture = await startFixture({ dir: fixtureDir });
const harness = new FixtureHarness(fixture.harnessUrl);
const bridge = new ApprovalBridge();
await bridge.start();

const shutdown = async (code: number): Promise<never> => {
  await bridge.close();
  await fixture.close();
  process.exit(code);
};

const baseConfig = (overrides: Partial<RuntimeConfig> = {}): RuntimeConfig => ({
  kind: "claude-code",
  executable: "claude",
  model: values.model,
  effort: "medium",
  workingDirectory: join(outDir, "work"),
  builtinTools: [],
  mcpServers: { d1: { type: "http", url: fixture.mcpUrl } },
  toolPolicy: {
    mcp__d1__read: "allow",
    mcp__d1__change: "ask",
    mcp__d1__slow: "ask",
    mcp__d1__artifact: "ask",
    mcp__d1__forbidden: "deny",
  },
  agentPromptFile: resolve("prompts/agent-v1.md"),
  outputDirectories: [join(fixtureDir, "artifacts")],
  env: {},
  extraSettings: {},
  ...overrides,
});

interface StepRecord {
  name: string;
  session_id: string;
  first_turn: boolean;
  prompt: string;
  events: AdapterEvent[];
  permission_requests: {
    /** The runtime's raw permission payload, snake_case as it arrived. */
    request: unknown;
    decision: PermissionDecision;
    abandoned: boolean;
  }[];
  turn: TurnResult | null;
  ledger_after: FixtureState | null;
  hook_evidence: Record<string, unknown>[] | null;
  notes: string[];
  checks: Record<string, boolean | string>;
}

const records: StepRecord[] = [];
const log = (...args: unknown[]) => console.log(`[probe]`, ...args);

const save = (name: string, data: unknown) => {
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(redactValue(data), null, 2), {
    mode: 0o600,
  });
};

/** The raw permission payload the runtime sent to the bridge; fields it did not send read as undefined. */
const RawPermissionRequest = z.looseObject({
  tool_name: z.string().optional(),
  tool_use_id: z.string().optional(),
});
const rawRequestsOf = (step: StepRecord): { tool_name?: string; tool_use_id?: string }[] =>
  step.permission_requests.map((entry) => {
    const parsed = RawPermissionRequest.safeParse(entry.request);
    return parsed.success ? parsed.data : {};
  });

/** Effort level per PreToolUse hook record: the hook's `effort` (object or string), else the env var it saw. */
const HookEffort = z.looseObject({
  effort: z.union([z.looseObject({ level: z.string().optional() }), z.string()]).optional(),
  env_claude_effort: z.string().optional(),
});
const effortsOf = (hooks: Record<string, unknown>[]): (string | undefined)[] =>
  hooks.map((hook) => {
    const parsed = HookEffort.safeParse(hook);
    if (!parsed.success) return undefined;
    const { effort, env_claude_effort: envEffort } = parsed.data;
    const level = typeof effort === "object" ? effort.level : effort;
    return level ?? envEffort;
  });

const staticReport = probeStaticCapabilities(baseConfig());
save("static-capabilities", staticReport);
log("static:", JSON.stringify(staticReport, null, 1));
if (staticReport.errors.length > 0) {
  console.error(
    "Static probe found blockers:\n" +
      staticReport.errors.map((problem) => ` - ${problem}`).join("\n"),
  );
  await shutdown(1);
}

type Decider = (
  request: PermissionRequest,
  step: StepRecord,
) => Promise<PermissionDecision> | PermissionDecision;

const describeEvent = (event: AdapterEvent): string =>
  match(event)
    .with(
      { type: "tool_proposed" },
      (proposed) => `${proposed.toolIdentity} ${proposed.runtimeCallId}`,
    )
    .with({ type: "runtime_stderr" }, (stderr) => stderr.text.trim())
    .otherwise(() => "");

const runStep = async (opts: {
  name: string;
  config: RuntimeConfig;
  sessionId: string;
  firstTurn: boolean;
  prompt: string;
  turnIndex: number;
  decide: Decider;
  during?: (handle: ReturnType<ClaudeCodeAdapter["submitTurn"]>, step: StepRecord) => Promise<void>;
}): Promise<StepRecord> => {
  validateRuntimeConfig(opts.config);
  const step: StepRecord = {
    name: opts.name,
    session_id: opts.sessionId,
    first_turn: opts.firstTurn,
    prompt: opts.prompt,
    events: [],
    permission_requests: [],
    turn: null,
    ledger_after: null,
    hook_evidence: null,
    notes: [],
    checks: {},
  };
  const callNumber = budget.take(`probe:${opts.name}`, opts.config.model);
  log(`step ${opts.name} (live call ${callNumber}/${budget.cap})`);
  const adapter = new ClaudeCodeAdapter(opts.config, bridge);
  const runtimeDir = join(outDir, "runtime", opts.sessionId);
  const handle = adapter.submitTurn({
    text: opts.prompt,
    runtimeConversationId: opts.sessionId,
    firstTurn: opts.firstTurn,
    runtimeDir,
    turnIndex: opts.turnIndex,
    onEvent: (event) => {
      step.events.push(event);
      if (event.type === "text_delta") process.stdout.write(event.text);
      else if (event.type !== "assistant_message") log(event.type, describeEvent(event));
    },
    permissionHandler: async (request) => {
      const decision = await opts.decide(request, step);
      step.permission_requests.push({
        request: request.raw,
        decision,
        abandoned: request.abandoned.aborted,
      });
      log("permission", request.toolName, request.toolUseId, "->", decision.behavior);
      return decision;
    },
  });
  if (opts.during) await opts.during(handle, step);
  step.turn = await handle.result;
  process.stdout.write("\n");
  step.ledger_after = await harness.state();
  step.hook_evidence = readHookEvidence(step.turn.hookEvidencePath);
  records.push(step);
  save(`step-${opts.turnIndex}-${opts.name}`, step);
  return step;
};

const only = values.only ? new Set(values.only.split(",")) : null;
const want = (name: string) => !only || only.has(name);

// ---- Session 1: streaming, allowed tool, approval payload, effort precedence, follow-up, every-call, deny rule ----
const s1 = randomUUID();
if (want("stream-approve")) {
  await harness.reset();
  const step = await runStep({
    name: "stream-approve",
    config: baseConfig({ extraSettings: { effortLevel: "high" } }),
    sessionId: s1,
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
  save("step-1-checks", step.checks);
}

if (want("followup-everycall-deny")) {
  let changeCount = 0;
  const step = await runStep({
    name: "followup-everycall-deny",
    config: baseConfig(),
    sessionId: s1,
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
  save("step-2-checks", step.checks);
}

// ---- Session 2: cancellable interruption then resume after kill ----
const s2 = randomUUID();
if (want("interrupt-cancellable")) {
  await harness.reset();
  const step = await runStep({
    name: "interrupt-cancellable",
    config: baseConfig(),
    sessionId: s2,
    firstTurn: true,
    turnIndex: 1,
    prompt:
      "Call d1.slow with mode cancellable exactly once. After it returns, call d1.change with delta 1 exactly once. Report the results.",
    decide: () => ({ behavior: "allow" }),
    during: async (handle, step) => {
      const entered = await harness.waitEntered(120_000);
      step.notes.push(`slow entered ${entered.call_id} at ${new Date().toISOString()}`);
      const t0 = Date.now();
      const outcome = await handle.interrupt();
      step.notes.push(`interrupt -> ${outcome} after ${Date.now() - t0}ms`);
      // wait for the ledger to settle (cancelled entry) without sleeping arbitrarily long
      for (let attempt = 0; attempt < 200; attempt++) {
        const state = await harness.state();
        if (state.ledger.some((entry) => entry.kind === "cancelled") || state.pending.length === 0)
          break;
        await sleep(25);
      }
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
  save("step-3-checks", { checks: step.checks, notes: step.notes });
}

if (want("resume-after-kill")) {
  const step = await runStep({
    name: "resume-after-kill",
    config: baseConfig(),
    sessionId: s2,
    firstTurn: false,
    turnIndex: 2,
    prompt:
      "In one or two sentences: what happened with the tool calls in your previous turn? Do not call any tools now.",
    decide: () => ({ behavior: "deny", message: "No tools are permitted in this turn." }),
  });
  step.checks.resumed_ok = step.turn?.status === "completed";
  step.checks.no_tools_called = step.permission_requests.length === 0;
  log("checks", step.checks);
  save("step-4-checks", step.checks);
}

// ---- Session 3: uncancellable action survives interruption ----
if (want("interrupt-uncancellable")) {
  await harness.reset();
  const s3 = randomUUID();
  const step = await runStep({
    name: "interrupt-uncancellable",
    config: baseConfig(),
    sessionId: s3,
    firstTurn: true,
    turnIndex: 1,
    prompt:
      "Call d1.slow with mode uncancellable exactly once. After it returns, call d1.change with delta 1 exactly once. Report the results.",
    decide: () => ({ behavior: "allow" }),
    during: async (handle, step) => {
      const entered = await harness.waitEntered(120_000);
      step.notes.push(`slow entered ${entered.call_id}`);
      const outcome = await handle.interrupt();
      step.notes.push(`interrupt -> ${outcome}`);
      const before = await harness.state();
      step.notes.push(
        `after kill, before release: counter=${before.counter} pending=${before.pending.length}`,
      );
      await harness.release(entered.call_id);
      for (let attempt = 0; attempt < 200; attempt++) {
        const state = await harness.state();
        if (state.counter >= 1) break;
        await sleep(25);
      }
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
  save("step-5-checks", { checks: step.checks, notes: step.notes });
}

// ---- Control: without --effort, the injected settings layer should show through in hook evidence ----
if (want("effort-control")) {
  const s4 = randomUUID();
  const config = baseConfig({ extraSettings: { effortLevel: "high" } });
  const runtimeDir = join(outDir, "runtime", s4);
  const plan = prepareLaunch({
    config,
    runtimeDir,
    bridgeUrl: bridge.url,
    sessionId: s4,
    resume: false,
    turnIndex: 1,
    agentPromptFile: config.agentPromptFile,
  });
  const idx = plan.args.indexOf("--effort");
  const args = [...plan.args];
  if (idx >= 0) args.splice(idx, 2);
  const callNumber = budget.take("probe:effort-control", config.model);
  log(`step effort-control (live call ${callNumber}/${budget.cap}) — launching without --effort`);
  bridge.setHandler(async () => ({ behavior: "allow" }));
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
  bridge.setHandler(null);
  const efforts = effortsOf(readHookEvidence(plan.files.hookEvidence));
  const control = { exit, efforts, stdout_lines: stdout.split("\n").filter(Boolean).length };
  writeFileSync(join(runtimeDir, "control.stream.jsonl"), stdout, { mode: 0o600 });
  save("step-6-effort-control", control);
  log("effort-control", control);
}

// ---- Freeze redacted protocol examples ----
const firstEvent = <T extends AdapterEvent["type"]>(
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
const examples: Record<string, unknown> = {
  captured_at: new Date().toISOString(),
  runtime_version: staticReport.runtime_version,
  adapter_version: staticReport.adapter_version,
  model: values.model,
  init: firstEvent("runtime_init")?.init ?? null,
  tool_proposed: firstEvent("tool_proposed") ?? null,
  permission_request_payload:
    records.find((record) => record.permission_requests.length > 0)?.permission_requests[0]
      ?.request ?? null,
  permission_response_examples: [
    { behavior: "allow" },
    { behavior: "deny", message: "The user rejected this call." },
  ],
  tool_result: firstEvent("tool_result") ?? null,
  turn_result: firstEvent("turn_result")?.result ?? null,
  hook_evidence: records[0]?.hook_evidence ?? null,
  launch_description: records[0]?.turn?.launch ?? null,
};
writeFileSync(
  join(examplesDir, "captured-examples.json"),
  JSON.stringify(redactValue(examples), null, 2),
);
// stream sample: first 40 raw lines of the first turn
const firstStream = records[0]?.turn?.streamLogPath;
if (firstStream && existsSync(firstStream)) {
  const lines = readFileSync(firstStream, "utf8").split("\n").filter(Boolean);
  writeFileSync(join(examplesDir, "stream-sample.jsonl"), lines.slice(0, 40).join("\n") + "\n");
}
save("summary", {
  static: staticReport,
  steps: records.map((record) => ({
    name: record.name,
    checks: record.checks,
    notes: record.notes,
    status: record.turn?.status,
    error: record.turn?.error,
  })),
  live_calls_used: budget.used(),
});
log("done. evidence in", outDir);
await shutdown(0);
