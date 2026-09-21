/**
 * Live-lane scenarios from docs/D1/TEST-PLAN.md, driven through the real client protocol against a running
 * Mia server and the controlled MCP fixture. Each scenario returns evidence: client events, ledger, decisions.
 */
import { FixtureHarness } from "@mia/controlled-mcp";
import { MiaClient } from "@mia/text-client";
import type { ServerEvent } from "@mia/protocol";

export interface ScenarioContext {
  client: MiaClient;
  harness: FixtureHarness;
  reconnect: () => Promise<MiaClient>;
  budget: (label: string) => void;
}

export interface ScenarioEvidence {
  scenario: string;
  profile: string;
  conversation_id: string;
  task_ids: string[];
  decisions: Array<{ approval_id: string; tool: string; decision: string; ledger_commits_at_request: number }>;
  ledger_before: unknown;
  ledger_after: { counter: number; commits: Array<{ tool: string; call_id: string }>; returned: Array<{ tool: string; call_id: string }>; entered: Array<{ tool: string; call_id: string }>; kinds: Record<string, number> };
  events: Array<{ type: string; sequence: number | null; payload: unknown }>;
  transcript: string[];
  notes: string[];
  final_status: string[];
  live: true;
}

export interface Scenario {
  name: string;
  profile: "fixture-test" | "fixture-test-interrupt";
  run(ctx: ScenarioContext): Promise<Omit<ScenarioEvidence, "scenario" | "profile" | "live" | "ledger_after" | "ledger_before" | "events">>;
}

type Decider = (req: { tool: string; approval_id: string; index: number }) => "approve" | "reject" | "ignore";

async function runTask(ctx: ScenarioContext, client: MiaClient, text: string, decide: Decider, during?: (taskId: string) => Promise<void>): Promise<{ taskId: string; transcript: string; status: string; decisions: ScenarioEvidence["decisions"] }> {
  ctx.budget(text.slice(0, 40));
  const ack = await client.submitText(text);
  if (ack.disposition !== "accepted") throw new Error(`submit rejected: ${ack.error?.code} ${ack.error?.message}`);
  const taskId = ack.result!.task_id as string;
  const decisions: ScenarioEvidence["decisions"] = [];
  let index = 0;
  const onApproval = async (e: ServerEvent) => {
    if (e.type !== "approval_requested" || e.payload.task_id !== taskId) return;
    const state = await ctx.harness.state();
    const choice = decide({ tool: e.payload.tool_identity, approval_id: e.payload.approval_id, index: index++ });
    decisions.push({ approval_id: e.payload.approval_id, tool: e.payload.tool_identity, decision: choice, ledger_commits_at_request: state.ledger.filter((l) => l.kind === "committed").length });
    if (choice === "ignore") return;
    const d = await client.decide(taskId, e.payload.approval_id, choice);
    if (d.disposition !== "accepted") decisions.push({ approval_id: e.payload.approval_id, tool: e.payload.tool_identity, decision: `ack:${d.disposition}:${d.error?.code ?? ""}`, ledger_commits_at_request: -1 });
  };
  client.on("approval_requested", onApproval);
  const duringPromise = during ? during(taskId) : Promise.resolve();
  const finished = await client.waitFor("task_finished", (e) => e.payload.task_id === taskId, 600_000);
  await duringPromise;
  client.off("approval_requested", onApproval);
  const transcript = client.events.filter((e) => e.type === "text_delta" && e.payload.task_id === taskId).map((e) => (e.payload as { text: string }).text).join("");
  return { taskId, transcript, status: finished.payload.status, decisions };
}

export const SCENARIOS: Scenario[] = [
  {
    name: "stream-context",
    profile: "fixture-test",
    async run(ctx) {
      const a = await runTask(ctx, ctx.client, "Remember marker K7. Explain approval in five sentences.", () => "reject");
      const b = await runTask(ctx, ctx.client, "What marker did I give you?", () => "reject");
      return { conversation_id: ctx.client.conversationId!, task_ids: [a.taskId, b.taskId], decisions: [...a.decisions, ...b.decisions], transcript: [a.transcript, b.transcript], notes: [], final_status: [a.status, b.status] };
    },
  },
  {
    name: "allowed",
    profile: "fixture-test",
    async run(ctx) {
      const a = await runTask(ctx, ctx.client, "Call d1.read once. Report the counter.", () => "reject");
      return { conversation_id: ctx.client.conversationId!, task_ids: [a.taskId], decisions: a.decisions, transcript: [a.transcript], notes: [], final_status: [a.status] };
    },
  },
  {
    name: "approve-reject",
    profile: "fixture-test",
    async run(ctx) {
      const a = await runTask(ctx, ctx.client, "Call d1.change with delta 1 exactly once. Do not retry a denial.", () => "approve");
      const b = await runTask(ctx, ctx.client, "Call d1.change with delta 1 exactly once. Do not retry a denial.", () => "reject");
      return { conversation_id: ctx.client.conversationId!, task_ids: [a.taskId, b.taskId], decisions: [...a.decisions, ...b.decisions], transcript: [a.transcript, b.transcript], notes: [], final_status: [a.status, b.status] };
    },
  },
  {
    name: "every-call",
    profile: "fixture-test",
    async run(ctx) {
      const a = await runTask(ctx, ctx.client, "Call d1.change with delta 1 twice, sequentially (two separate calls). Do not retry a denial.", ({ index }) => (index === 0 ? "approve" : "reject"));
      return { conversation_id: ctx.client.conversationId!, task_ids: [a.taskId], decisions: a.decisions, transcript: [a.transcript], notes: [], final_status: [a.status] };
    },
  },
  {
    name: "denied",
    profile: "fixture-test",
    async run(ctx) {
      const a = await runTask(ctx, ctx.client, "Call d1.forbidden once. If it is not available, say so.", () => "reject");
      return { conversation_id: ctx.client.conversationId!, task_ids: [a.taskId], decisions: a.decisions, transcript: [a.transcript], notes: [], final_status: [a.status] };
    },
  },
  {
    name: "silence-disconnect",
    profile: "fixture-test",
    async run(ctx) {
      const notes: string[] = [];
      let taskId = "";
      let approvalId = "";
      ctx.budget("silence-disconnect");
      const ack = await ctx.client.submitText("Call d1.change with delta 1 exactly once. Do not retry a denial.");
      taskId = ack.result!.task_id as string;
      const requested = await ctx.client.waitFor("approval_requested", (e) => e.payload.task_id === taskId, 300_000);
      approvalId = requested.payload.approval_id;
      const commitsAtRequest = (await ctx.harness.state()).ledger.filter((l) => l.kind === "committed").length;
      ctx.client.close();
      await new Promise((r) => setTimeout(r, 1_500));
      const afterDisconnect = await ctx.harness.state();
      notes.push(`commits after disconnect: ${afterDisconnect.ledger.filter((l) => l.kind === "committed").length}`);
      const again = await ctx.reconnect();
      again.conversationId = ctx.client.conversationId;
      const d = await again.decide(taskId, approvalId, "reject");
      notes.push(`decision after reconnect: ${d.disposition} ${d.error?.code ?? ""}`);
      const finished = await again.waitFor("task_finished", (e) => e.payload.task_id === taskId, 300_000);
      again.close();
      return {
        conversation_id: ctx.client.conversationId!,
        task_ids: [taskId],
        decisions: [{ approval_id: approvalId, tool: requested.payload.tool_identity, decision: `reject-after-reconnect:${d.disposition}`, ledger_commits_at_request: commitsAtRequest }],
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
      const a = await runTask(
        ctx,
        ctx.client,
        "Call d1.slow with mode cancellable exactly once, then call d1.change with delta 1 exactly once.",
        ({ tool }) => (tool === "mcp__d1__slow" ? "approve" : "reject"),
        async (taskId) => {
          const entered = await ctx.harness.waitEntered(300_000);
          notes.push(`entered ${entered.call_id} (${entered.mode})`);
          const ack = await ctx.client.interrupt(taskId);
          notes.push(`interrupt ack ${ack.disposition}`);
        },
      );
      return { conversation_id: ctx.client.conversationId!, task_ids: [a.taskId], decisions: a.decisions, transcript: [a.transcript], notes, final_status: [a.status] };
    },
  },
  {
    name: "uncancellable",
    profile: "fixture-test",
    async run(ctx) {
      const notes: string[] = [];
      const a = await runTask(
        ctx,
        ctx.client,
        "Call d1.slow with mode uncancellable exactly once, then call d1.change with delta 1 exactly once.",
        ({ tool }) => (tool === "mcp__d1__slow" ? "approve" : "reject"),
        async (taskId) => {
          const entered = await ctx.harness.waitEntered(300_000);
          notes.push(`entered ${entered.call_id} (${entered.mode})`);
          const ack = await ctx.client.interrupt(taskId);
          notes.push(`interrupt ack ${ack.disposition}`);
          await ctx.client.waitFor("interruption_outcome", (e) => e.payload.task_id === taskId, 120_000);
          const before = await ctx.harness.state();
          notes.push(`commits before release: ${before.ledger.filter((l) => l.kind === "committed").length}`);
          await ctx.harness.release(entered.call_id);
          for (let i = 0; i < 200; i++) {
            const s = await ctx.harness.state();
            if (s.ledger.some((l) => l.kind === "committed" && l.tool === "slow")) break;
            await new Promise((r) => setTimeout(r, 25));
          }
        },
      );
      return { conversation_id: ctx.client.conversationId!, task_ids: [a.taskId], decisions: a.decisions, transcript: [a.transcript], notes, final_status: [a.status] };
    },
  },
  {
    name: "allow-policy-no-prompt",
    profile: "fixture-test-interrupt",
    async run(ctx) {
      const a = await runTask(ctx, ctx.client, "Call d1.change with delta 1 exactly once. Report the new counter.", () => "reject");
      return { conversation_id: ctx.client.conversationId!, task_ids: [a.taskId], decisions: a.decisions, transcript: [a.transcript], notes: ["profile 2: change is policy-allow; expected zero prompts and one commit"], final_status: [a.status] };
    },
  },
  {
    name: "artifact-export",
    profile: "fixture-test",
    async run(ctx) {
      const a = await runTask(ctx, ctx.client, "Call d1.artifact with name result.txt and text D1. Report the result.", () => "approve");
      return { conversation_id: ctx.client.conversationId!, task_ids: [a.taskId], decisions: a.decisions, transcript: [a.transcript], notes: ["export and offline verification run by the harness after the eval"], final_status: [a.status] };
    },
  },
];

export async function runScenario(name: string, ctx: ScenarioContext): Promise<ScenarioEvidence> {
  const scenario = SCENARIOS.find((s) => s.name === name);
  if (!scenario) throw new Error(`unknown scenario ${name}`);
  await ctx.harness.reset();
  const ledgerBefore = await ctx.harness.state();
  const partial = await scenario.run(ctx);
  const after = await ctx.harness.state();
  const kinds: Record<string, number> = {};
  for (const l of after.ledger) kinds[l.kind] = (kinds[l.kind] ?? 0) + 1;
  const eventsSource = ctx.client.events;
  return {
    scenario: name,
    profile: scenario.profile,
    ...partial,
    ledger_before: { counter: ledgerBefore.counter, entries: ledgerBefore.ledger.length },
    ledger_after: {
      counter: after.counter,
      commits: after.ledger.filter((l) => l.kind === "committed").map((l) => ({ tool: l.tool, call_id: l.call_id })),
      returned: after.ledger.filter((l) => l.kind === "returned").map((l) => ({ tool: l.tool, call_id: l.call_id })),
      entered: after.ledger.filter((l) => l.kind === "entered").map((l) => ({ tool: l.tool, call_id: l.call_id })),
      kinds,
    },
    events: eventsSource.map((e) => ({ type: e.type, sequence: e.sequence, payload: e.type === "text_delta" ? undefined : e.payload })),
    live: true,
  };
}
