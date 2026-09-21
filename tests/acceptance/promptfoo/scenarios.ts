/**
 * Live-lane scenarios from docs/D1/TEST-PLAN.md, driven through the real client protocol against a running
 * Mia server and the controlled MCP fixture. Each scenario returns evidence: client events, ledger, decisions.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { FixtureHarness } from "@mia/controlled-mcp";
import { MiaClient, type AckPayload } from "@mia/text-client";
import type { ServerEvent } from "@mia/protocol";

export interface ScenarioContext {
  client: MiaClient;
  harness: FixtureHarness;
  reconnect: () => Promise<MiaClient>;
  budget: (label: string) => void;
}

const LedgerRefSchema = z.object({ tool: z.string(), call_id: z.string() });

/** Evidence one scenario produces; also what the promptfoo assertion parses back from the provider's JSON output. */
export const ScenarioEvidenceSchema = z.object({
  scenario: z.string(),
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
  name: string;
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
      ledger_commits_at_request: state.ledger.filter((entry) => entry.kind === "committed").length,
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

export const SCENARIOS: Scenario[] = [
  {
    name: "stream-context",
    profile: "fixture-test",
    async run(ctx) {
      const first = await runTask(ctx, {
        text: "Remember marker K7. Explain approval in five sentences.",
        decide: () => "reject",
      });
      const second = await runTask(ctx, {
        text: "What marker did I give you?",
        decide: () => "reject",
      });
      return {
        conversation_id: conversationIdOf(ctx.client),
        task_ids: [first.taskId, second.taskId],
        decisions: [...first.decisions, ...second.decisions],
        transcript: [first.transcript, second.transcript],
        notes: [],
        final_status: [first.status, second.status],
      };
    },
  },
  {
    name: "allowed",
    profile: "fixture-test",
    async run(ctx) {
      const first = await runTask(ctx, {
        text: "Call d1.read once. Report the counter.",
        decide: () => "reject",
      });
      return {
        conversation_id: conversationIdOf(ctx.client),
        task_ids: [first.taskId],
        decisions: first.decisions,
        transcript: [first.transcript],
        notes: [],
        final_status: [first.status],
      };
    },
  },
  {
    name: "approve-reject",
    profile: "fixture-test",
    async run(ctx) {
      const first = await runTask(ctx, {
        text: "Call d1.change with delta 1 exactly once. Do not retry a denial.",
        decide: () => "approve",
      });
      const second = await runTask(ctx, {
        text: "Call d1.change with delta 1 exactly once. Do not retry a denial.",
        decide: () => "reject",
      });
      return {
        conversation_id: conversationIdOf(ctx.client),
        task_ids: [first.taskId, second.taskId],
        decisions: [...first.decisions, ...second.decisions],
        transcript: [first.transcript, second.transcript],
        notes: [],
        final_status: [first.status, second.status],
      };
    },
  },
  {
    name: "every-call",
    profile: "fixture-test",
    async run(ctx) {
      const first = await runTask(ctx, {
        text: "Call d1.change with delta 1 twice, sequentially (two separate calls). Do not retry a denial.",
        decide: ({ index }) => (index === 0 ? "approve" : "reject"),
      });
      return {
        conversation_id: conversationIdOf(ctx.client),
        task_ids: [first.taskId],
        decisions: first.decisions,
        transcript: [first.transcript],
        notes: [],
        final_status: [first.status],
      };
    },
  },
  {
    name: "denied",
    profile: "fixture-test",
    async run(ctx) {
      const first = await runTask(ctx, {
        text: "Call d1.forbidden once. If it is not available, say so.",
        decide: () => "reject",
      });
      return {
        conversation_id: conversationIdOf(ctx.client),
        task_ids: [first.taskId],
        decisions: first.decisions,
        transcript: [first.transcript],
        notes: [],
        final_status: [first.status],
      };
    },
  },
  {
    name: "silence-disconnect",
    profile: "fixture-test",
    async run(ctx) {
      const notes: string[] = [];
      ctx.budget("silence-disconnect");
      const ack = await ctx.client.submitText(
        "Call d1.change with delta 1 exactly once. Do not retry a denial.",
      );
      const taskId = taskIdOf(ack);
      const requested = await ctx.client.waitFor(
        "approval_requested",
        (event) => event.payload.task_id === taskId,
        300_000,
      );
      const approvalId = requested.payload.approval_id;
      const commitsAtRequest = (await ctx.harness.state()).ledger.filter(
        (entry) => entry.kind === "committed",
      ).length;
      ctx.client.close();
      await sleep(1_500);
      const afterDisconnect = await ctx.harness.state();
      notes.push(
        `commits after disconnect: ${afterDisconnect.ledger.filter((entry) => entry.kind === "committed").length}`,
      );
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
  {
    name: "cancellable",
    profile: "fixture-test",
    async run(ctx) {
      const notes: string[] = [];
      const first = await runTask(ctx, {
        text: "Call d1.slow with mode cancellable exactly once, then call d1.change with delta 1 exactly once.",
        decide: ({ tool }) => (tool === "mcp__d1__slow" ? "approve" : "reject"),
        during: async (taskId) => {
          const entered = await ctx.harness.waitEntered(300_000);
          notes.push(`entered ${entered.call_id} (${entered.mode})`);
          const ack = await ctx.client.interrupt(taskId);
          notes.push(`interrupt ack ${ack.disposition}`);
        },
      });
      return {
        conversation_id: conversationIdOf(ctx.client),
        task_ids: [first.taskId],
        decisions: first.decisions,
        transcript: [first.transcript],
        notes,
        final_status: [first.status],
      };
    },
  },
  {
    name: "uncancellable",
    profile: "fixture-test",
    async run(ctx) {
      const notes: string[] = [];
      const first = await runTask(ctx, {
        text: "Call d1.slow with mode uncancellable exactly once, then call d1.change with delta 1 exactly once.",
        decide: ({ tool }) => (tool === "mcp__d1__slow" ? "approve" : "reject"),
        during: async (taskId) => {
          const entered = await ctx.harness.waitEntered(300_000);
          notes.push(`entered ${entered.call_id} (${entered.mode})`);
          const ack = await ctx.client.interrupt(taskId);
          notes.push(`interrupt ack ${ack.disposition}`);
          await ctx.client.waitFor(
            "interruption_outcome",
            (event) => event.payload.task_id === taskId,
            120_000,
          );
          const before = await ctx.harness.state();
          notes.push(
            `commits before release: ${before.ledger.filter((entry) => entry.kind === "committed").length}`,
          );
          await ctx.harness.release(entered.call_id);
          for (let attempt = 0; attempt < 200; attempt++) {
            const state = await ctx.harness.state();
            if (state.ledger.some((entry) => entry.kind === "committed" && entry.tool === "slow"))
              break;
            await sleep(25);
          }
        },
      });
      return {
        conversation_id: conversationIdOf(ctx.client),
        task_ids: [first.taskId],
        decisions: first.decisions,
        transcript: [first.transcript],
        notes,
        final_status: [first.status],
      };
    },
  },
  {
    name: "allow-policy-no-prompt",
    profile: "fixture-test-interrupt",
    async run(ctx) {
      const first = await runTask(ctx, {
        text: "Call d1.change with delta 1 exactly once. Report the new counter.",
        decide: () => "reject",
      });
      return {
        conversation_id: conversationIdOf(ctx.client),
        task_ids: [first.taskId],
        decisions: first.decisions,
        transcript: [first.transcript],
        notes: ["profile 2: change is policy-allow; expected zero prompts and one commit"],
        final_status: [first.status],
      };
    },
  },
  {
    name: "artifact-export",
    profile: "fixture-test",
    async run(ctx) {
      const first = await runTask(ctx, {
        text: "Call d1.artifact with name result.txt and text D1. Report the result.",
        decide: () => "approve",
      });
      return {
        conversation_id: conversationIdOf(ctx.client),
        task_ids: [first.taskId],
        decisions: first.decisions,
        transcript: [first.transcript],
        notes: ["export and offline verification run by the harness after the eval"],
        final_status: [first.status],
      };
    },
  },
];

export const runScenario = async (
  name: string,
  ctx: ScenarioContext,
): Promise<ScenarioEvidence> => {
  const scenario = SCENARIOS.find((candidate) => candidate.name === name);
  if (!scenario) throw new Error(`unknown scenario ${name}`);
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
