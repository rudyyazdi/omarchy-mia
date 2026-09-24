import { match } from "ts-pattern";
import { describe, expect, it } from "vitest";
import {
  callById,
  withPending,
  withRevision,
  type CallState,
  type ConversationState,
  type TaskState,
} from "./conversation-state.ts";
import {
  decideConversation,
  releasedBy,
  type ApprovalDecisionEvent,
  type ConversationDecision,
  type ConversationEvent,
  type InterruptTaskEvent,
  type PromptAbandonedEvent,
} from "./decide-conversation.ts";
import type { EngineEffect } from "./engine-effects.ts";
import type { EngineRecord } from "./engine-records.ts";

const NOW = new Date("2026-09-24T12:00:00.000Z");
const AT = NOW.toISOString();
const ORIGIN = { clientId: "client_owner", connectionId: "conn_1" };

/** Call `call_<index>`, held awaiting the user's decision on approval `appr_<index>`. */
const held = (index: number): CallState => ({
  id: `call_${index}`,
  runtimeCallId: `toolu_${index}`,
  revision: 1,
  toolIdentity: "mcp__d1__change",
  digest: `sha256:${index}`,
  redactedArguments: { path: `file_${index}` },
  policy: "ask",
  status: "awaiting_approval",
  approvalId: `appr_${index}`,
});

/** The conversation, its task awaiting approval on `held(index)` for each index in `pending`, in that order. */
const awaiting = (pending: number[], task: Partial<TaskState> = {}): ConversationState => ({
  id: "conv_1",
  runtimeConversationId: "runtime_conv_1",
  provenanceSetId: "prov_1",
  directory: "/tmp/conversations/conv_1",
  promptFile: null,
  turnCount: 2,
  sessionStarted: true,
  epoch: 2,
  pendingNote: null,
  task: pending.reduce(
    (current, index) =>
      withPending(withRevision(current, held(index)), `appr_${index}`, `call_${index}`),
    {
      id: "task_1",
      executionId: "exec_1",
      epoch: 2,
      status: "awaiting_approval",
      gateOpen: true,
      interrupted: false,
      runtimeEnded: false,
      calls: new Map(),
      pendingApprovals: new Map(),
      abandoned: [],
      clientId: "client_owner",
      reportedModel: null,
      ...task,
    },
  ),
});

const decide = (state: ConversationState, event: ConversationEvent): ConversationDecision =>
  decideConversation({ state, event, now: NOW });

const accepted = (decision: ConversationDecision) => {
  if (decision.kind !== "accepted") throw new Error(`rejected: ${decision.rejection.kind}`);
  return decision;
};

/** Each record as its event type, or its writer operation. */
const labels = (records: readonly EngineRecord[]): string[] =>
  records.map((record) => (record.kind === "append_event" ? record.input.type : record.kind));

/** Each effect as its kind, with what it names. */
const effectLabels = (effects: readonly EngineEffect[]): string[] =>
  effects.map((effect) =>
    match(effect)
      .with({ kind: "deliver_event" }, ({ event }) => `deliver ${event.type}`)
      .with(
        { kind: "notify_tool_call" },
        ({ payload }) => `notify ${payload.tool_call_id} ${payload.status}`,
      )
      .with(
        { kind: "answer_prompt" },
        ({ approvalId, decision }) => `answer ${approvalId} ${decision.behavior}`,
      )
      .with({ kind: "interrupt_runtime" }, ({ taskId }) => `interrupt ${taskId}`)
      .exhaustive(),
  );

const decision = (overrides: Partial<ApprovalDecisionEvent> = {}): ApprovalDecisionEvent => ({
  kind: "approval_decision",
  origin: ORIGIN,
  taskId: "task_1",
  approvalId: "appr_1",
  decision: "approve",
  deciderClientId: "client_owner",
  ids: { resolved: "evt_resolved", dispatched: "evt_dispatched" },
  ...overrides,
});

describe("approval decisions", () => {
  it("records an approval before releasing its call, then tells the client and answers the runtime", () => {
    const state = awaiting([1]);
    const { next, records, effects } = accepted(decide(state, decision()));
    expect(labels(records)).toEqual([
      "approval_resolved",
      "update_approval",
      "tool_dispatched",
      "update_tool_call",
      "update_task",
    ]);
    expect(records[0]).toMatchObject({
      input: {
        id: "evt_resolved",
        receivedAt: AT,
        conversationId: "conv_1",
        taskId: "task_1",
        executionId: "exec_1",
        clientId: "client_owner",
        clientConnectionId: "conn_1",
      },
    });
    expect(records[1]).toMatchObject({
      id: "appr_1",
      fields: {
        status: "approved",
        consumedAt: AT,
        decisionEventId: "evt_resolved",
        decisionClientId: "client_owner",
      },
    });
    expect(records[2]).toMatchObject({
      input: { id: "evt_dispatched", causedByEventId: "evt_resolved" },
    });
    expect(effectLabels(effects)).toEqual([
      "deliver approval_resolved",
      "notify call_1 dispatched",
      "answer appr_1 allow",
    ]);
    expect(next.task).toMatchObject({ status: "running", pendingApprovals: new Map() });
    expect(releasedBy(next, "appr_1")).toBe(true);
    // The state it decided from is left as it was: only a commit makes the next one current.
    expect(state.task?.pendingApprovals.has("appr_1")).toBe(true);
    expect(state.task && callById(state.task, "call_1")?.status).toBe("awaiting_approval");
  });

  it("records a rejection as a denial that releases nothing and keeps the task waiting on the others", () => {
    const state = awaiting([1, 2]);
    const { next, records, effects } = accepted(decide(state, decision({ decision: "reject" })));
    expect(labels(records)).toEqual([
      "approval_resolved",
      "update_approval",
      "update_tool_call",
      "update_task",
    ]);
    expect(records[3]).toMatchObject({ fields: { status: "awaiting_approval" } });
    expect(effectLabels(effects)).toEqual([
      "deliver approval_resolved",
      "notify call_1 denied",
      "answer appr_1 deny",
    ]);
    expect([...(next.task?.pendingApprovals.keys() ?? [])]).toEqual(["appr_2"]);
    expect(releasedBy(next, "appr_1")).toBe(false);
  });

  it("refuses a decision from another client, on an approval not pending, or for another task", () => {
    const state = awaiting([1]);
    const refusal = (event: ApprovalDecisionEvent) => {
      const decided = decide(state, event);
      return decided.kind === "rejected" ? decided.rejection : decided;
    };
    expect(refusal(decision({ deciderClientId: "client_other" }))).toEqual({ kind: "not_owner" });
    expect(refusal(decision({ approvalId: "appr_missing" }))).toEqual({ kind: "not_pending" });
    expect(refusal(decision({ taskId: "task_old" }))).toEqual({ kind: "no_task" });
  });
});

const interruption = (resolved: [string, string][]): InterruptTaskEvent => ({
  kind: "interrupt_task",
  origin: ORIGIN,
  taskId: "task_1",
  ids: { requested: "evt_requested", resolved: new Map(resolved) },
});

describe("interruptions", () => {
  it("closes the gate, advances the epoch and invalidates every pending approval in request order", () => {
    const state = awaiting([2, 1]);
    const { next, records, effects } = accepted(
      decide(
        state,
        interruption([
          ["appr_1", "evt_resolved_1"],
          ["appr_2", "evt_resolved_2"],
        ]),
      ),
    );
    expect(labels(records)).toEqual([
      "interruption_requested",
      "update_approval",
      "approval_resolved",
      "update_approval",
      "approval_resolved",
      "update_task",
      "update_tool_call",
      "update_tool_call",
    ]);
    expect(records.filter((record) => record.kind === "update_approval")).toMatchObject([
      { id: "appr_2", fields: { status: "invalidated", decisionEventId: "evt_requested" } },
      { id: "appr_1", fields: { status: "invalidated", decisionEventId: "evt_requested" } },
    ]);
    expect(records[2]).toMatchObject({
      input: { id: "evt_resolved_2", causedByEventId: "evt_requested" },
    });
    expect(effectLabels(effects)).toEqual([
      "deliver interruption_requested",
      "deliver approval_resolved",
      "deliver approval_resolved",
      "notify call_2 invalidated",
      "answer appr_2 deny",
      "notify call_1 invalidated",
      "answer appr_1 deny",
      "interrupt task_1",
    ]);
    expect(next.epoch).toBe(3);
    expect(next.task).toMatchObject({
      status: "interrupting",
      gateOpen: false,
      interrupted: true,
      pendingApprovals: new Map(),
    });
    expect(state.epoch).toBe(2);
  });

  it("refuses to interrupt twice, a runtime that has ended, a finished task, or another task", () => {
    const refusal = (state: ConversationState, event = interruption([])) => {
      const decided = decide(state, event);
      return decided.kind === "rejected" ? decided.rejection : decided;
    };
    expect(refusal(awaiting([], { status: "interrupting" }))).toEqual({
      kind: "already_interrupting",
    });
    expect(refusal(awaiting([], { status: "running", runtimeEnded: true }))).toEqual({
      kind: "runtime_ended",
    });
    expect(refusal(awaiting([], { status: "completed" }))).toEqual({
      kind: "invalid",
      taskStatus: "completed",
    });
    expect(refusal(awaiting([]), { ...interruption([]), taskId: "task_old" })).toEqual({
      kind: "no_task",
    });
  });

  it("fails when the boundary drew no approval_resolved id for a pending approval", () => {
    expect(() => decide(awaiting([1]), interruption([]))).toThrow("no id was drawn for appr_1");
  });
});

const abandonment = (callId: string): PromptAbandonedEvent => ({
  kind: "prompt_abandoned",
  origin: ORIGIN,
  taskId: "task_1",
  callId,
  ids: { resolved: "evt_expired" },
});

describe("prompt abandonment", () => {
  it("expires the pending approval, invalidates its call and remembers it as abandoned, answering nothing", () => {
    const state = awaiting([1]);
    const { next, records, effects } = accepted(decide(state, abandonment("call_1")));
    expect(labels(records)).toEqual([
      "update_approval",
      "approval_resolved",
      "update_tool_call",
      "update_task",
    ]);
    expect(records[0]).toMatchObject({
      id: "appr_1",
      fields: { status: "expired", reason: "runtime abandoned the prompt" },
    });
    expect(records[3]).toMatchObject({ fields: { status: "running" } });
    // The runtime already has its denial, and the client learns of the call through approval_resolved alone.
    expect(effectLabels(effects)).toEqual(["deliver approval_resolved"]);
    expect(next.task).toMatchObject({
      status: "running",
      pendingApprovals: new Map(),
      abandoned: ["call_1"],
    });
    expect(next.task && callById(next.task, "call_1")?.status).toBe("invalidated");
  });

  it("changes nothing for an approval no longer pending, or a call or task it does not hold", () => {
    const decided = accepted(decide(awaiting([1]), decision({ decision: "reject" })));
    const refusal = (state: ConversationState, event: PromptAbandonedEvent) => {
      const abandoned = decide(state, event);
      return abandoned.kind === "rejected" ? abandoned.rejection : abandoned;
    };
    expect(refusal(decided.next, abandonment("call_1"))).toEqual({ kind: "not_pending" });
    expect(refusal(decided.next, abandonment("call_missing"))).toEqual({ kind: "no_call" });
    expect(refusal(decided.next, { ...abandonment("call_1"), taskId: "task_old" })).toEqual({
      kind: "no_task",
    });
  });
});
