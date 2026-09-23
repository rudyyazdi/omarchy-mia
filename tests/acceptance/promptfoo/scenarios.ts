/**
 * Live-lane scenarios from docs/D1/TEST-PLAN.md, driven through the real client protocol against a running
 * Mia server and the controlled MCP fixture. Each scenario returns evidence: client events, ledger, decisions.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { FixtureHarness, type FixtureState } from "@mia/controlled-mcp";
import { MiaClient, type AckPayload } from "@mia/text-client";
import type { ServerEvent } from "@mia/protocol";

export interface ScenarioContext {
  client: MiaClient;
  harness: FixtureHarness;
  reconnect: () => Promise<MiaClient>;
  budget: (label: string) => void;
}

/** Every live scenario, declared once; `SCENARIOS` defines each, the provider runs it, the assertion judges it. */
export const ScenarioNameSchema = z.enum([
  "stream-context",
  "allowed",
  "approve-reject",
  "every-call",
  "denied",
  "silence-disconnect",
  "cancellable",
  "uncancellable",
  "allow-policy-no-prompt",
  "artifact-export",
]);
export type ScenarioName = z.infer<typeof ScenarioNameSchema>;

/** Reads a promptfoo `vars.scenario` value; an unknown name comes back as an error that names it. */
export const readScenarioName = (
  value: unknown,
): { ok: true; name: ScenarioName } | { ok: false; error: string } => {
  const parsed = ScenarioNameSchema.safeParse(value);
  return parsed.success
    ? { ok: true, name: parsed.data }
    : { ok: false, error: `unknown scenario ${JSON.stringify(value)}` };
};

/** Reads a comma-separated `--scenarios` value; any entry that is not a declared name is an error naming it. */
export const readScenarioList = (
  value: string,
): { ok: true; names: ScenarioName[] } | { ok: false; error: string } => {
  const names: ScenarioName[] = [];
  for (const entry of value.split(",")) {
    const read = readScenarioName(entry);
    if (!read.ok)
      return {
        ok: false,
        error: `${read.error}; declared: ${ScenarioNameSchema.options.join(", ")}`,
      };
    names.push(read.name);
  }
  return { ok: true, names };
};

const LedgerRefSchema = z.object({ tool: z.string(), call_id: z.string() });

/** Evidence one scenario produces; also what the promptfoo assertion parses back from the provider's JSON output. */
export const ScenarioEvidenceSchema = z.object({
  scenario: ScenarioNameSchema,
  profile: z.string(),
  conversation_id: z.string(),
  task_ids: z.array(z.string()),
  decisions: z.array(
    z.object({
      approval_id: z.string(),
      tool: z.string(),
      decision: z.string(),
      ledger_commits_at_request: z.number(),
    }),
  ),
  ledger_before: z.unknown().optional(),
  ledger_after: z.object({
    counter: z.number(),
    commits: z.array(LedgerRefSchema),
    returned: z.array(LedgerRefSchema),
    entered: z.array(LedgerRefSchema),
    kinds: z.record(z.string(), z.number()),
  }),
  events: z.array(
    z.object({
      type: z.string(),
      sequence: z.number().nullable(),
      payload: z.unknown().optional(),
    }),
  ),
  transcript: z.array(z.string()),
  notes: z.array(z.string()),
  final_status: z.array(z.string()),
  live: z.literal(true),
});
export type ScenarioEvidence = z.infer<typeof ScenarioEvidenceSchema>;

export interface Scenario {
  name: ScenarioName;
  profile: "fixture-test" | "fixture-test-interrupt";
  run(
    ctx: ScenarioContext,
  ): Promise<
    Omit<
      ScenarioEvidence,
      "scenario" | "profile" | "live" | "ledger_after" | "ledger_before" | "events"
    >
  >;
}

type Decider = (request: {
  tool: string;
  approval_id: string;
  index: number;
}) => "approve" | "reject" | "ignore";

/** Commits are the fixture's own count of executed actions; model prose never establishes one. */
const commitCount = (state: FixtureState): number =>
  state.ledger.filter((entry) => entry.kind === "committed").length;

const taskIdOf = (ack: AckPayload): string => {
  const taskId = ack.result?.task_id;
  if (typeof taskId !== "string") throw new Error("accepted submission carried no task id");
  return taskId;
};

const conversationIdOf = (client: MiaClient): string => {
  if (!client.conversationId) throw new Error("client has no conversation");
  return client.conversationId;
};

const runTask = async (
  ctx: ScenarioContext,
  task: { text: string; decide: Decider; during?: (taskId: string) => Promise<void> },
): Promise<{
  taskId: string;
  transcript: string;
  status: string;
  decisions: ScenarioEvidence["decisions"];
}> => {
  const { client } = ctx;
  ctx.budget(task.text.slice(0, 40));
  const ack = await client.submitText(task.text);
  if (ack.disposition !== "accepted")
    throw new Error(`submit rejected: ${ack.error?.code} ${ack.error?.message}`);
  const taskId = taskIdOf(ack);
  const decisions: ScenarioEvidence["decisions"] = [];
  let index = 0;
  const onApproval = async (event: ServerEvent) => {
    if (event.type !== "approval_requested" || event.payload.task_id !== taskId) return;
    const state = await ctx.harness.state();
    const choice = task.decide({
      tool: event.payload.tool_identity,
      approval_id: event.payload.approval_id,
      index: index++,
    });
    decisions.push({
      approval_id: event.payload.approval_id,
      tool: event.payload.tool_identity,
      decision: choice,
      ledger_commits_at_request: commitCount(state),
    });
    if (choice === "ignore") return;
    const decided = await client.decide({
      taskId: taskId,
      approvalId: event.payload.approval_id,
      decision: choice,
    });
    if (decided.disposition !== "accepted")
      decisions.push({
        approval_id: event.payload.approval_id,
        tool: event.payload.tool_identity,
        decision: `ack:${decided.disposition}:${decided.error?.code ?? ""}`,
        ledger_commits_at_request: -1,
      });
  };
  client.on("approval_requested", onApproval);
  const duringPromise = task.during ? task.during(taskId) : Promise.resolve();
  const finished = await client.waitFor(
    "task_finished",
    (event) => event.payload.task_id === taskId,
    600_000,
  );
  await duringPromise;
  client.off("approval_requested", onApproval);
  const transcript = client.events
    .flatMap((event) =>
      event.type === "text_delta" && event.payload.task_id === taskId ? [event.payload.text] : [],
    )
    .join("");
  return { taskId, transcript, status: finished.payload.status, decisions };
};

type TaskResult = Awaited<ReturnType<typeof runTask>>;
type ScenarioResult = Awaited<ReturnType<Scenario["run"]>>;

/** What a task's `during` hook can reach: the live context, the task it belongs to, the notes it may add to. */
interface TaskContext {
  ctx: ScenarioContext;
  taskId: string;
  notes: string[];
}

interface TaskSpec {
  text: string;
  decide: Decider;
  during?: (context: TaskContext) => Promise<void>;
}

const evidenceOf = (
  ctx: ScenarioContext,
  tasks: TaskResult[],
  notes: string[],
): ScenarioResult => ({
  conversation_id: conversationIdOf(ctx.client),
  task_ids: tasks.map((task) => task.taskId),
  decisions: tasks.flatMap((task) => task.decisions),
  transcript: tasks.map((task) => task.transcript),
  notes,
  final_status: tasks.map((task) => task.status),
});

/**
 * Every scenario below is "submit these tasks in this conversation, decide their approvals this
 * way, report the evidence". Defining that once leaves each scenario stating only what is specific
 * to it, and keeps every scenario's evidence assembled identically.
 */
const taskScenario = (spec: {
  name: ScenarioName;
  profile: Scenario["profile"];
  tasks: TaskSpec[];
  notes?: string[];
}): Scenario => ({
  name: spec.name,
  profile: spec.profile,
  async run(ctx) {
    const notes = [...(spec.notes ?? [])];
    const results: TaskResult[] = [];
    for (const task of spec.tasks) {
      const during = task.during;
      results.push(
        await runTask(ctx, {
          text: task.text,
          decide: task.decide,
          ...(during ? { during: (taskId: string) => during({ ctx, taskId, notes }) } : {}),
        }),
      );
    }
    return evidenceOf(ctx, results, notes);
  },
});

const rejectEverything: Decider = () => "reject";
const approveEverything: Decider = () => "approve";
const approveSlowOnly: Decider = ({ tool }) => (tool === "mcp__d1__slow" ? "approve" : "reject");

const CHANGE_ONCE = "Call d1.change with delta 1 exactly once. Do not retry a denial.";
const slowThenChange = (mode: "cancellable" | "uncancellable"): string =>
  `Call d1.slow with mode ${mode} exactly once, then call d1.change with delta 1 exactly once.`;

/** Interrupt the moment the fixture reports the slow action entered: the shared part of both interruption scenarios. */
const interruptAtEntered = async ({
  ctx,
  taskId,
  notes,
}: TaskContext): Promise<{ call_id: string }> => {
  const entered = await ctx.harness.waitEntered(300_000);
  notes.push(`entered ${entered.call_id} (${entered.mode})`);
  const ack = await ctx.client.interrupt(taskId);
  notes.push(`interrupt ack ${ack.disposition}`);
  return entered;
};

export const SCENARIOS: Scenario[] = [
  taskScenario({
    name: "stream-context",
    profile: "fixture-test",
    tasks: [
      { text: "Remember marker K7. Explain approval in five sentences.", decide: rejectEverything },
      { text: "What marker did I give you?", decide: rejectEverything },
    ],
  }),
  taskScenario({
    name: "allowed",
    profile: "fixture-test",
    tasks: [{ text: "Call d1.read once. Report the counter.", decide: rejectEverything }],
  }),
  taskScenario({
    name: "approve-reject",
    profile: "fixture-test",
    tasks: [
      { text: CHANGE_ONCE, decide: approveEverything },
      { text: CHANGE_ONCE, decide: rejectEverything },
    ],
  }),
  taskScenario({
    name: "every-call",
    profile: "fixture-test",
    tasks: [
      {
        text: "Call d1.change with delta 1 twice, sequentially (two separate calls). Do not retry a denial.",
        decide: ({ index }) => (index === 0 ? "approve" : "reject"),
      },
    ],
  }),
  taskScenario({
    name: "denied",
    profile: "fixture-test",
    tasks: [
      { text: "Call d1.forbidden once. If it is not available, say so.", decide: rejectEverything },
    ],
  }),
  {
    name: "silence-disconnect",
    profile: "fixture-test",
    async run(ctx) {
      const notes: string[] = [];
      ctx.budget("silence-disconnect");
      const ack = await ctx.client.submitText(CHANGE_ONCE);
      const taskId = taskIdOf(ack);
      const requested = await ctx.client.waitFor(
        "approval_requested",
        (event) => event.payload.task_id === taskId,
        300_000,
      );
      const approvalId = requested.payload.approval_id;
      const commitsAtRequest = commitCount(await ctx.harness.state());
      ctx.client.close();
      await sleep(1_500);
      notes.push(`commits after disconnect: ${commitCount(await ctx.harness.state())}`);
      const again = await ctx.reconnect();
      again.conversationId = ctx.client.conversationId;
      const decided = await again.decide({
        taskId: taskId,
        approvalId: approvalId,
        decision: "reject",
      });
      notes.push(`decision after reconnect: ${decided.disposition} ${decided.error?.code ?? ""}`);
      const finished = await again.waitFor(
        "task_finished",
        (event) => event.payload.task_id === taskId,
        300_000,
      );
      again.close();
      return {
        conversation_id: conversationIdOf(ctx.client),
        task_ids: [taskId],
        decisions: [
          {
            approval_id: approvalId,
            tool: requested.payload.tool_identity,
            decision: `reject-after-reconnect:${decided.disposition}`,
            ledger_commits_at_request: commitsAtRequest,
          },
        ],
        transcript: [],
        notes,
        final_status: [finished.payload.status],
      };
    },
  },
  taskScenario({
    name: "cancellable",
    profile: "fixture-test",
    tasks: [
      {
        text: slowThenChange("cancellable"),
        decide: approveSlowOnly,
        during: async (context) => {
          await interruptAtEntered(context);
        },
      },
    ],
  }),
  taskScenario({
    name: "uncancellable",
    profile: "fixture-test",
    tasks: [
      {
        text: slowThenChange("uncancellable"),
        decide: approveSlowOnly,
        during: async (context) => {
          const entered = await interruptAtEntered(context);
          const { ctx, taskId, notes } = context;
          await ctx.client.waitFor(
            "interruption_outcome",
            (event) => event.payload.task_id === taskId,
            120_000,
          );
          notes.push(`commits before release: ${commitCount(await ctx.harness.state())}`);
          await ctx.harness.release(entered.call_id);
          await ctx.harness.waitForState((state) =>
            state.ledger.some((entry) => entry.kind === "committed" && entry.tool === "slow"),
          );
        },
      },
    ],
  }),
  taskScenario({
    name: "allow-policy-no-prompt",
    profile: "fixture-test-interrupt",
    tasks: [
      {
        text: "Call d1.change with delta 1 exactly once. Report the new counter.",
        decide: rejectEverything,
      },
    ],
    notes: ["profile 2: change is policy-allow; expected zero prompts and one commit"],
  }),
  taskScenario({
    name: "artifact-export",
    profile: "fixture-test",
    tasks: [
      {
        text: "Call d1.artifact with name result.txt and text D1. Report the result.",
        decide: approveEverything,
      },
    ],
    notes: ["export and offline verification run by the harness after the eval"],
  }),
];

/** The definition of a declared scenario; a unit test keeps every declared name defined exactly once. */
export const scenarioFor = (name: ScenarioName): Scenario => {
  const scenario = SCENARIOS.find((candidate) => candidate.name === name);
  if (!scenario) throw new Error(`scenario ${name} has no definition`);
  return scenario;
};

export const runScenario = async (
  scenario: Scenario,
  ctx: ScenarioContext,
): Promise<ScenarioEvidence> => {
  const name = scenario.name;
  await ctx.harness.reset();
  const ledgerBefore = await ctx.harness.state();
  const partial = await scenario.run(ctx);
  const after = await ctx.harness.state();
  const kinds: Record<string, number> = {};
  for (const entry of after.ledger) kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;
  const eventsSource = ctx.client.events;
  return {
    scenario: name,
    profile: scenario.profile,
    ...partial,
    ledger_before: { counter: ledgerBefore.counter, entries: ledgerBefore.ledger.length },
    ledger_after: {
      counter: after.counter,
      commits: after.ledger
        .filter((entry) => entry.kind === "committed")
        .map((entry) => ({ tool: entry.tool, call_id: entry.call_id })),
      returned: after.ledger
        .filter((entry) => entry.kind === "returned")
        .map((entry) => ({ tool: entry.tool, call_id: entry.call_id })),
      entered: after.ledger
        .filter((entry) => entry.kind === "entered")
        .map((entry) => ({ tool: entry.tool, call_id: entry.call_id })),
      kinds,
    },
    events: eventsSource.map((event) => ({
      type: event.type,
      sequence: event.sequence,
      payload: event.type === "text_delta" ? undefined : event.payload,
    })),
    live: true,
  };
};
