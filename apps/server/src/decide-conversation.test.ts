import { match } from "ts-pattern";
import { describe, expect, it } from "vitest";
import type { TurnResult } from "@mia/agent-adapter";
import { canonicalDigest, type ClientDiagnostics } from "@mia/protocol";
import type { Retention } from "./artifact-capture.ts";
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
  type CapturedOutput,
  type ClientDisconnectedEvent,
  type ConversationStartEvent,
  type ConversationEvent,
  type DiagnosticsReportedEvent,
  type InterruptTaskEvent,
  type PermissionRequestEvent,
  type PromptAbandonedEvent,
  type RuntimeEventReceived,
  type RuntimeReport,
  type TaskSubmittedEvent,
  type TurnEndedEvent,
  turnNote,
} from "./decide-conversation.ts";
import type { EngineEffect } from "./engine-effects.ts";
import type { EngineRecord } from "./engine-records.ts";
import type { McpBodyRecord } from "./mcp-bodies.ts";
import type { NamedProvenancePlan } from "./provenance.ts";
import type { BuiltTransition } from "./transition-draft.ts";

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

/** The state a transition decided from is left as it was: only a commit makes the next one current. */
const expectStillAwaiting = (state: ConversationState): void => {
  expect(state.task?.pendingApprovals.has("appr_1")).toBe(true);
  expect(state.task && callById(state.task, "call_1")?.status).toBe("awaiting_approval");
};

/** What the conversation's machine decides, from a started conversation or from none (null). */
type Decided = ReturnType<typeof decideConversation>;

const decide = (state: ConversationState | null, event: ConversationEvent): Decided =>
  decideConversation({ state, event, now: NOW });

/** An accepted decision, whose next state is always a started conversation. */
const accepted = (decision: Decided): BuiltTransition => {
  if (decision.kind !== "accepted") throw new Error(`rejected: ${decision.rejection.kind}`);
  const { next } = decision;
  if (next === null) throw new Error("accepted without a conversation");
  return { ...decision, next };
};

/** Each record as its event type, or its writer operation. */
const labels = (records: readonly EngineRecord[]): string[] =>
  records.map((record) => (record.kind === "append_event" ? record.input.type : record.kind));

/** Each effect as its kind, with what it names. */
const effectLabels = (effects: readonly EngineEffect[]): string[] =>
  effects.map((effect) =>
    match(effect)
      .with({ kind: "activate_conversation" }, ({ origin }) => `activate ${origin.connectionId}`)
      .with({ kind: "deliver_event" }, ({ event }) => `deliver ${event.type}`)
      .with(
        { kind: "notify_tool_call" },
        ({ payload }) => `notify ${payload.tool_call_id} ${payload.status}`,
      )
      .with(
        { kind: "answer_prompt" },
        ({ approvalId, decision }) => `answer ${approvalId} ${decision.behavior}`,
      )
      .with({ kind: "answer_permission" }, ({ answer }) =>
        match(answer)
          .with({ kind: "answer" }, ({ decision }) => `answer request ${decision.behavior}`)
          .with({ kind: "hold" }, ({ approvalId }) => `hold request ${approvalId}`)
          .exhaustive(),
      )
      .with({ kind: "interrupt_runtime" }, ({ taskId }) => `interrupt ${taskId}`)
      .with({ kind: "start_turn" }, ({ turn }) => `start ${turn.taskId}`)
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
    expectStillAwaiting(state);
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

  it("records an approval that comes after the gate closed, or from an older epoch, as blocked and unreleased", () => {
    for (const state of [awaiting([1], { gateOpen: false }), awaiting([1], { epoch: 1 })]) {
      const { next, records, effects } = accepted(decide(state, decision()));
      expect(labels(records)).toEqual([
        "approval_resolved",
        "update_approval",
        "update_tool_call",
        "update_task",
      ]);
      expect(records[1]).toMatchObject({ fields: { status: "approved" } });
      expect(records[2]).toMatchObject({ fields: { status: "blocked_gate" } });
      expect(effectLabels(effects)).toEqual([
        "deliver approval_resolved",
        "notify call_1 blocked_gate",
        "answer appr_1 deny",
      ]);
      expect(releasedBy(next, "appr_1")).toBe(false);
    }
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
    expect(records[0]).toMatchObject({
      input: { id: "evt_requested", clientId: "client_owner", clientConnectionId: "conn_1" },
    });
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
    // No decision caused the expiry: the event names no cause and the approval no deciding event.
    expect(records[0]).not.toHaveProperty("fields.decisionEventId");
    expect(records[1]).toMatchObject({
      input: {
        id: "evt_expired",
        causedByEventId: null,
        clientId: "client_owner",
        clientConnectionId: "conn_1",
      },
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
    expect(state.task).toMatchObject({ status: "awaiting_approval", abandoned: [] });
    expectStillAwaiting(state);
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

  it("takes the expiry into memory alone when it could not be recorded (#165), and refuses what the expiry would", () => {
    const state = awaiting([1]);
    const unrecorded = (event: PromptAbandonedEvent): ConversationEvent => ({
      ...event,
      kind: "abandonment_unrecorded",
    });
    const expired = accepted(decide(state, abandonment("call_1")));
    expect(accepted(decide(state, unrecorded(abandonment("call_1"))))).toEqual({
      kind: "accepted",
      next: expired.next,
      records: [],
      effects: [],
    });
    expectStillAwaiting(state);
    expect(decide(state, unrecorded(abandonment("call_missing")))).toEqual({
      kind: "rejected",
      rejection: { kind: "no_call" },
    });
    expect(decide(expired.next, unrecorded(abandonment("call_1")))).toEqual({
      kind: "rejected",
      rejection: { kind: "not_pending" },
    });
    expect(decide(state, unrecorded({ ...abandonment("call_1"), taskId: "task_old" }))).toEqual({
      kind: "rejected",
      rejection: { kind: "no_task" },
    });
  });
});

/** The conversation with its task running, holding `calls` as their runtime call ids' revisions. */
const running = (calls: CallState[] = [], task: Partial<TaskState> = {}): ConversationState => {
  const state = awaiting([], { status: "running", ...task });
  return {
    ...state,
    task: state.task && calls.reduce((current, call) => withRevision(current, call), state.task),
  };
};

const PERMISSION_IDS = {
  resolved: "evt_superseded",
  proposal: "evt_proposal",
  call: "call_new",
  evaluation: "evt_evaluation",
  outcome: "evt_outcome",
  approval: "appr_new",
};

/** A permission request of the task, for `mcp__d1__change` under `toolu_9` unless `overrides` say otherwise. */
const request = (
  overrides: Partial<Omit<PermissionRequestEvent, "request">> &
    Partial<PermissionRequestEvent["request"]> = {},
): PermissionRequestEvent => {
  const {
    runtimeCallId = "toolu_9",
    toolIdentity = "mcp__d1__change",
    input = { delta: 1 },
    ...event
  } = overrides;
  return {
    kind: "permission_request",
    origin: ORIGIN,
    taskId: "task_1",
    request: { runtimeCallId, toolIdentity, input },
    policy: "ask",
    promptsFull: false,
    ids: PERMISSION_IDS,
    ...event,
  };
};

/** The one answer a permission request's transition gives the runtime. */
const answerOf = (effects: readonly EngineEffect[]) => {
  const answers = effects.flatMap((effect) =>
    effect.kind === "answer_permission" ? [effect.answer] : [],
  );
  expect(answers).toHaveLength(1);
  return answers[0];
};

describe("permission requests", () => {
  it("proposes an asked call, requests its approval, and answers by holding the prompt under it", () => {
    const state = running();
    const { next, records, effects } = accepted(decide(state, request()));
    expect(labels(records)).toEqual([
      "tool_proposed",
      "create_tool_call",
      "policy_evaluated",
      "approval_requested",
      "create_approval",
      "update_tool_call",
      "update_task",
    ]);
    expect(records[1]).toMatchObject({
      input: { id: "call_new", bindingRevision: 1, proposalEventId: "evt_proposal" },
    });
    expect(records[4]).toMatchObject({
      input: { id: "appr_new", toolCallId: "call_new", requestingEventId: "evt_outcome" },
    });
    // The hold is the first effect: the prompt is held before the client is told of its approval.
    expect(effectLabels(effects)).toEqual([
      "hold request appr_new",
      "deliver approval_requested",
      "notify call_new awaiting_approval",
    ]);
    expect(answerOf(effects)).toEqual({ kind: "hold", approvalId: "appr_new", callId: "call_new" });
    expect(next.task).toMatchObject({
      status: "awaiting_approval",
      pendingApprovals: new Map([["appr_new", "call_new"]]),
    });
    expect(next.task && callById(next.task, "call_new")).toMatchObject({
      status: "awaiting_approval",
      approvalId: "appr_new",
      policy: "ask",
    });
    expect(state.task?.calls.size).toBe(0);
  });

  it("reuses the revision the stream proposed and releases an allowed call at once", () => {
    const input = { path: "a" };
    const proposed: CallState = {
      ...held(1),
      status: "proposed",
      approvalId: null,
      policy: "allow",
      toolIdentity: "mcp__d1__read",
      digest: canonicalDigest(input),
    };
    const { next, records, effects } = accepted(
      decide(
        running([proposed]),
        request({
          runtimeCallId: "toolu_1",
          toolIdentity: "mcp__d1__read",
          input,
          policy: "allow",
        }),
      ),
    );
    expect(labels(records)).toEqual(["policy_evaluated", "tool_dispatched", "update_tool_call"]);
    expect(records[1]).toMatchObject({
      input: { id: "evt_outcome", causedByEventId: "evt_evaluation" },
    });
    expect(effectLabels(effects)).toEqual(["answer request allow", "notify call_1 dispatched"]);
    expect(answerOf(effects)).toEqual({ kind: "answer", decision: { behavior: "allow" } });
    expect(next.task && callById(next.task, "call_1")?.status).toBe("dispatched");
  });

  it("denies an unlisted tool with a configuration error, and a call past a closed gate with an interrupt", () => {
    const unlisted = accepted(decide(running(), request({ policy: "unlisted" })));
    expect(labels(unlisted.records)).toEqual([
      "tool_proposed",
      "create_tool_call",
      "policy_evaluated",
      "error",
      "update_tool_call",
    ]);
    expect(unlisted.records[3]).toMatchObject({
      input: { id: "evt_outcome", payload: { code: "configuration_error" } },
    });
    expect(effectLabels(unlisted.effects)).toEqual([
      "answer request deny",
      "deliver error",
      "notify call_new denied",
    ]);
    const gated = accepted(decide(running([], { gateOpen: false }), request()));
    expect(gated.records.at(-1)).toMatchObject({ fields: { status: "blocked_gate" } });
    expect(answerOf(gated.effects)).toMatchObject({
      kind: "answer",
      decision: { behavior: "deny", interrupt: true },
    });
  });

  it("denies a call that would ask while the held prompts are full, recording no approval", () => {
    const { next, records, effects } = accepted(decide(running(), request({ promptsFull: true })));
    expect(labels(records)).not.toContain("create_approval");
    expect(records.at(-1)).toMatchObject({ fields: { status: "denied" } });
    expect(answerOf(effects)).toMatchObject({ kind: "answer", decision: { behavior: "deny" } });
    expect(next.task?.pendingApprovals.size).toBe(0);
  });

  it("supersedes a held binding whose arguments changed, denying its prompt, then asks for the new revision", () => {
    const { next, records, effects } = accepted(
      decide(awaiting([1]), request({ runtimeCallId: "toolu_1", input: { delta: 2 } })),
    );
    expect(labels(records)).toEqual([
      "update_approval",
      "approval_resolved",
      "update_tool_call",
      "update_task",
      "tool_proposed",
      "create_tool_call",
      "policy_evaluated",
      "approval_requested",
      "create_approval",
      "update_tool_call",
      "update_task",
    ]);
    expect(records[0]).toMatchObject({ id: "appr_1", fields: { status: "invalidated" } });
    expect(records[1]).toMatchObject({ input: { id: "evt_superseded" } });
    expect(records[5]).toMatchObject({ input: { id: "call_new", bindingRevision: 2 } });
    expect(effectLabels(effects)).toEqual([
      "hold request appr_new",
      "deliver approval_resolved",
      "answer appr_1 deny",
      "deliver approval_requested",
      "notify call_new awaiting_approval",
    ]);
    expect(next.task?.pendingApprovals).toEqual(new Map([["appr_new", "call_new"]]));
    expect(next.task && callById(next.task, "call_1")?.status).toBe("invalidated");
  });

  it("refuses a request with no runtime call id, a duplicate of one awaiting approval, or for another task", () => {
    const refusal = (state: ConversationState, event: PermissionRequestEvent) => {
      const decided = decide(state, event);
      return decided.kind === "rejected" ? decided.rejection : decided;
    };
    // An empty id binds to nothing either, as the bridge accepts one.
    expect(refusal(running(), request({ runtimeCallId: "" }))).toMatchObject({
      kind: "refused",
      detail: "permission request for mcp__d1__change carried no runtime call id; rejected",
    });
    expect(refusal(running(), request({ runtimeCallId: null }))).toEqual({
      kind: "refused",
      detail: "permission request for mcp__d1__change carried no runtime call id; rejected",
      answer: {
        behavior: "deny",
        message: "Mia cannot bind this call to a runtime call id; rejected.",
      },
    });
    const state = awaiting([1]);
    const repeat = request({ runtimeCallId: "toolu_1", input: { path: "file_1" } });
    const digested = {
      ...state,
      task: state.task && {
        ...state.task,
        calls: new Map([
          ["toolu_1", [{ ...held(1), digest: canonicalDigest({ path: "file_1" }) }]],
        ]),
      },
    };
    expect(refusal(digested, repeat)).toMatchObject({
      kind: "refused",
      detail: expect.stringContaining("repeats a request already awaiting approval"),
      answer: { behavior: "deny" },
    });
    expect(refusal(running(), request({ taskId: "task_old" }))).toEqual({ kind: "no_task" });
  });
});

const RUNTIME_IDS = {
  event: "evt_runtime",
  resolved: "evt_superseded",
  call: "call_new",
  unmatched: "evt_unmatched",
};

const reported = (report: RuntimeReport): RuntimeEventReceived => ({
  kind: "runtime_event",
  origin: ORIGIN,
  taskId: "task_1",
  report,
  ids: RUNTIME_IDS,
});

const AT_RUNTIME = "2026-09-24T11:59:59.000Z";

/** A complete proposal the stream reported for `mcp__d1__change`, which the profile asks for. */
const streamed = (runtimeCallId: string, args: unknown): RuntimeReport => ({
  event: {
    type: "tool_proposed",
    runtimeCallId,
    toolIdentity: "mcp__d1__change",
    arguments: args,
    complete: true,
    at: AT_RUNTIME,
  },
  policy: "ask",
});

describe("runtime events", () => {
  it("records an init's model and marks the session started", () => {
    const state = { ...running(), sessionStarted: false };
    const init = { model: "claude-x", evidence: { session: 1 } };
    const { next, records } = accepted(
      decide(state, reported({ event: { type: "runtime_init", init, at: AT_RUNTIME } })),
    );
    expect(labels(records)).toEqual(["runtime_init", "update_execution"]);
    expect(records[1]).toMatchObject({ id: "exec_1", fields: { reportedModel: "claude-x" } });
    expect(next.sessionStarted).toBe(true);
    expect(next.task?.reportedModel).toBe("claude-x");
    expect(state.sessionStarted).toBe(false);
  });

  it("proposes a revision for a complete proposal with the policy read for its tool, and attaches a repeat to it", () => {
    const proposal = reported(streamed("toolu_9", { delta: 1 }));
    const proposed = accepted(decide(running(), proposal));
    expect(labels(proposed.records)).toEqual(["tool_proposed", "create_tool_call"]);
    expect(proposed.records[1]).toMatchObject({
      input: { id: "call_new", policy: "ask", status: "proposed", proposalEventId: "evt_runtime" },
    });
    expect(effectLabels(proposed.effects)).toEqual(["notify call_new proposed"]);
    const attached = accepted(decide(proposed.next, proposal));
    expect(labels(attached.records)).toEqual(["tool_proposed", "update_tool_call"]);
    expect(attached.records[1]).toMatchObject({
      id: "call_new",
      fields: { proposalEventId: "evt_runtime" },
    });
    expect(attached.effects).toEqual([]);
  });

  it("supersedes a held binding the stream reports changed, denying its prompt, and proposes the next revision", () => {
    const { next, records, effects } = accepted(
      decide(awaiting([1]), reported(streamed("toolu_1", { path: "changed" }))),
    );
    expect(labels(records)).toEqual([
      "tool_proposed",
      "update_approval",
      "approval_resolved",
      "update_tool_call",
      "update_task",
      "create_tool_call",
    ]);
    expect(records[1]).toMatchObject({ id: "appr_1", fields: { status: "invalidated" } });
    expect(records[2]).toMatchObject({ input: { id: "evt_superseded" } });
    expect(records[4]).toMatchObject({ fields: { status: "running" } });
    expect(records[5]).toMatchObject({ input: { id: "call_new", bindingRevision: 2 } });
    expect(effectLabels(effects)).toEqual([
      "deliver approval_resolved",
      "answer appr_1 deny",
      "notify call_new proposed",
    ]);
    expect(next.task?.pendingApprovals.size).toBe(0);
    expect(next.task && callById(next.task, "call_1")?.status).toBe("invalidated");
  });

  it("completes the call a result binds to, with its retained output and MCP bodies, and notes an unmatched one", () => {
    const dispatched: CallState = { ...held(1), status: "dispatched" };
    const output: CapturedOutput = {
      ids: {
        artifact: "art_1",
        resultLink: "link_result",
        outputLink: "link_output",
        registered: "evt_registered",
      },
      declared: { path: "/tmp/out/report.txt" },
      retention: {
        status: "retained",
        stored: { digest: "sha256:out", byteCount: 3, storageKey: "objects/out" },
      },
    };
    const bodies: McpBodyRecord[] = [
      { direction: "request", status: "recorded", body: {}, eventId: "evt_req" },
      {
        direction: "response",
        status: "unrecorded",
        reason: "none",
        eventId: "evt_res",
      },
    ];
    const result = (runtimeCallId: string) =>
      reported({
        event: {
          type: "tool_result",
          runtimeCallId,
          isError: false,
          content: "ok",
          raw: {},
          at: AT_RUNTIME,
        },
        output,
        bodies,
      });
    const { next, records, effects } = accepted(decide(running([dispatched]), result("toolu_1")));
    expect(labels(records)).toEqual([
      "tool_result",
      "update_tool_call",
      "register_artifact",
      "link_artifact",
      "link_artifact",
      "artifact_registered",
      "mcp_request",
      "mcp_response",
    ]);
    expect(records[1]).toMatchObject({
      id: "call_1",
      fields: { status: "completed", resultEventId: "evt_runtime" },
    });
    expect(records[5]).toMatchObject({
      input: { id: "evt_registered", causedByEventId: "evt_runtime" },
    });
    expect(records[6]).toMatchObject({ input: { id: "evt_req", causedByEventId: "evt_runtime" } });
    expect(effectLabels(effects)).toEqual(["notify call_1 completed"]);
    expect(next.task && callById(next.task, "call_1")?.status).toBe("completed");
    const unmatched = accepted(decide(running([dispatched]), result("toolu_other")));
    expect(labels(unmatched.records)).toEqual(["tool_result", "tool_result_unmatched"]);
    expect(unmatched.effects).toEqual([]);
  });

  it("drops an event once the task's runtime has ended, or for another task", () => {
    const refusal = (state: ConversationState, event: RuntimeEventReceived) => {
      const decided = decide(state, event);
      return decided.kind === "rejected" ? decided.rejection : decided;
    };
    const stderr = reported({ event: { type: "runtime_stderr", text: "late", at: AT_RUNTIME } });
    expect(refusal(running([], { runtimeEnded: true }), stderr)).toEqual({ kind: "runtime_ended" });
    expect(refusal(running(), { ...stderr, taskId: "task_old" })).toEqual({ kind: "no_task" });
  });
});

/** The conversation between tasks: its last turn left `pendingNote`, and nothing runs. */
const idle = (pendingNote: string | null = null): ConversationState => ({
  ...awaiting([]),
  pendingNote,
  task: null,
});

const submission = (overrides: Partial<TaskSubmittedEvent> = {}): TaskSubmittedEvent => ({
  kind: "submit_task",
  origin: ORIGIN,
  text: "hello",
  clientId: "client_owner",
  commandId: "cmd_1",
  requested: { model: "model-pin", effort: "high" },
  ids: {
    task: "task_new",
    execution: "exec_new",
    submitted: "evt_submitted",
    started: "evt_started",
  },
  ...overrides,
});

describe("task submission", () => {
  it("records the task under the next epoch, carries the last turn's note into its prompt, then starts its turn", () => {
    const state = idle("[Mia note] earlier");
    const { next, records, effects } = accepted(decide(state, submission()));
    expect(labels(records)).toEqual([
      "create_task",
      "create_execution",
      "task_submitted",
      "task_started",
    ]);
    expect(records[0]).toMatchObject({
      input: { id: "task_new", createdAt: AT, conversationId: "conv_1", clientId: "client_owner" },
    });
    expect(records[1]).toMatchObject({
      input: {
        id: "exec_new",
        taskId: "task_new",
        runtimeIdentity: "claude-code",
        runtimeConversationId: "runtime_conv_1",
        requestedModel: "model-pin",
        requestedEffort: "high",
        provenanceSetId: "prov_1",
        executionEpoch: 3,
      },
    });
    expect(records[2]).toMatchObject({
      input: {
        id: "evt_submitted",
        taskId: "task_new",
        executionId: "exec_new",
        payload: {
          text: "hello",
          runtime_prompt: "[Mia note] earlier\n\nhello",
          mia_note: "[Mia note] earlier",
          command_id: "cmd_1",
        },
      },
    });
    expect(effectLabels(effects)).toEqual(["deliver task_started", "start task_new"]);
    expect(effects.at(-1)).toEqual({
      kind: "start_turn",
      turn: { taskId: "task_new", prompt: "[Mia note] earlier\n\nhello" },
    });
    expect(next).toMatchObject({ epoch: 3, turnCount: 3, pendingNote: null });
    expect(next.task).toMatchObject({
      id: "task_new",
      executionId: "exec_new",
      epoch: 3,
      status: "running",
      gateOpen: true,
      clientId: "client_owner",
    });
    // Only a commit makes the next state current: the note stays until then.
    expect(state.pendingNote).toBe("[Mia note] earlier");
  });

  it("sends the text alone when the last turn left no note", () => {
    const { records, effects } = accepted(decide(idle(), submission()));
    expect(records[2]).toMatchObject({
      input: { payload: { runtime_prompt: "hello", mia_note: null } },
    });
    expect(effects.at(-1)).toMatchObject({ turn: { prompt: "hello" } });
  });

  it("refuses a submission while a task runs, naming its pending approvals in request order", () => {
    const decided = decide(awaiting([2, 1]), submission());
    expect(decided).toEqual({
      kind: "rejected",
      rejection: {
        kind: "busy",
        taskId: "task_1",
        status: "awaiting_approval",
        pendingApprovals: ["appr_2", "appr_1"],
      },
    });
  });
});

const turnResult = (overrides: Partial<TurnResult> = {}): TurnResult => ({
  status: "completed",
  summary: null,
  exit: { code: 0, signal: null },
  error: null,
  streamLogPath: "/tmp/runtime/turn-002.stream.jsonl",
  hookEvidencePath: "/tmp/runtime/hooks.jsonl",
  launch: {
    model: "model-pin",
    effort: "high",
    session_id: "runtime_conv_1",
    resume: true,
    builtin_tools: [],
    mcp_servers: [],
    permission_prompt_tool: "mcp__mia_approval__request",
    settings: {},
    mcp_config: {},
  },
  init: null,
  interrupted: false,
  runtimeCancellation: "not_needed",
  ...overrides,
});

const RETAINED: Retention = {
  status: "retained",
  stored: { digest: "sha256:t", byteCount: 1, storageKey: "objects/t" },
};

const turnEnded = (overrides: Partial<TurnEndedEvent> = {}): TurnEndedEvent => ({
  kind: "turn_ended",
  origin: ORIGIN,
  taskId: "task_1",
  result: turnResult(),
  transcript: null,
  hooks: { evidence: { records: [], malformedLines: 0, readError: null }, retention: null },
  unresultedBodies: [],
  stillPending: [],
  ids: {
    transcript: { artifact: "art_transcript", link: "link_transcript" },
    hooks: { artifact: "art_hooks", link: "link_hooks" },
    outcome: "evt_outcome",
    finished: "evt_finished",
    error: "evt_error",
  },
  ...overrides,
});

describe("turn end", () => {
  it("records each call's final status, expires what the records hold pending, registers evidence and ends the task", () => {
    const completed: CallState = { ...held(1), status: "completed" };
    const released: CallState = { ...held(2), status: "dispatched" };
    const state = running([completed, released]);
    const { next, records, effects } = accepted(
      decide(
        state,
        turnEnded({
          transcript: RETAINED,
          unresultedBodies: [
            {
              call: released,
              bodies: [{ direction: "request", status: "recorded", body: {}, eventId: "evt_req" }],
            },
          ],
          stillPending: ["appr_lost"],
        }),
      ),
    );
    expect(labels(records)).toEqual([
      "update_tool_call",
      "update_tool_call",
      "mcp_request",
      "update_approval",
      "register_artifact",
      "link_artifact",
      "update_execution",
      "update_task",
      "task_finished",
    ]);
    expect(records[0]).toMatchObject({ id: "call_1", fields: { status: "completed" } });
    expect(records[1]).toMatchObject({ id: "call_2", fields: { status: "unknown" } });
    expect(records[2]).toMatchObject({
      input: { id: "evt_req", taskId: "task_1", causedByEventId: null },
    });
    expect(records[3]).toMatchObject({
      id: "appr_lost",
      fields: { status: "expired", consumedAt: AT, reason: "task ended" },
    });
    expect(records[4]).toMatchObject({
      input: {
        id: "art_transcript",
        kind: "runtime_transcript",
        logicalName: "turn-2.stream.jsonl",
        originalPath: "/tmp/runtime/turn-002.stream.jsonl",
        producerExecutionId: "exec_1",
      },
    });
    expect(records[5]).toMatchObject({
      input: { id: "link_transcript", conversationId: "conv_1", relation: "runtime_transcript" },
    });
    expect(records[6]).toMatchObject({
      id: "exec_1",
      fields: {
        status: "completed",
        endedAt: AT,
        reportedEffort: null,
        effortEvidence: {
          samples: 0,
          note: "no tool use in this turn; effective effort unreported",
        },
      },
    });
    // A released call whose outcome is unknown makes the task's outcome unknown too.
    expect(records[7]).toMatchObject({
      id: "task_1",
      fields: { status: "outcome_unknown", finishedAt: AT },
    });
    expect(effectLabels(effects)).toEqual(["deliver task_finished"]);
    expect(next.task).toMatchObject({ status: "outcome_unknown", pendingApprovals: new Map() });
    expect(next.task && callById(next.task, "call_2")?.status).toBe("unknown");
    // The boundary clears the task once it has answered its held prompts.
    expect(next.task?.id).toBe("task_1");
    // The next turn is told the released call's outcome is unknown.
    expect(next.pendingNote).toContain("mcp__d1__change: unknown");
    expect(state.pendingNote).toBeNull();
  });

  it("tells the client an interrupted turn's outcome before the task finishes, and blocks a call still held", () => {
    const { next, records, effects } = accepted(
      decide(
        awaiting([1], { status: "interrupting", interrupted: true, gateOpen: false }),
        turnEnded({ result: turnResult({ status: "killed", runtimeCancellation: "forced_kill" }) }),
      ),
    );
    expect(labels(records)).toEqual([
      "update_tool_call",
      "update_execution",
      "interruption_outcome",
      "update_task",
      "task_finished",
    ]);
    expect(records[0]).toMatchObject({ id: "call_1", fields: { status: "blocked_gate" } });
    expect(records[1]).toMatchObject({ fields: { status: "killed" } });
    expect(records[2]).toMatchObject({
      input: {
        id: "evt_outcome",
        payload: {
          task_status: "interrupted",
          actions: [{ tool_call_id: "call_1", status: "blocked_gate" }],
          runtime_cancellation: "forced_kill",
        },
      },
    });
    expect(effectLabels(effects)).toEqual([
      "deliver interruption_outcome",
      "deliver task_finished",
    ]);
    expect(next.task).toMatchObject({ status: "interrupted", pendingApprovals: new Map() });
    expect(next.pendingNote).toContain("mcp__d1__change: blocked_gate");
  });

  it("reports a failed turn's error, and the one effort level its hook evidence reported", () => {
    const { next, records, effects } = accepted(
      decide(
        running(),
        turnEnded({
          result: turnResult({ status: "failed", error: "runtime crashed" }),
          hooks: {
            evidence: {
              records: [{ effort: { level: "high" } }, { effort: "high" }],
              malformedLines: 0,
              readError: null,
            },
            retention: RETAINED,
          },
        }),
      ),
    );
    expect(labels(records)).toEqual([
      "register_artifact",
      "link_artifact",
      "update_execution",
      "update_task",
      "task_finished",
      "error",
    ]);
    expect(records[0]).toMatchObject({
      input: { id: "art_hooks", kind: "effort_evidence", logicalName: "turn-2.hooks.jsonl" },
    });
    expect(records[1]).toMatchObject({ input: { id: "link_hooks", relation: "task_output" } });
    expect(records[2]).toMatchObject({
      fields: {
        status: "failed",
        reportedEffort: "high",
        effortEvidence: { values: ["high"], samples: 2, note: null },
      },
    });
    expect(records[4]).toMatchObject({
      input: { payload: { status: "failed", error: "runtime crashed" } },
    });
    expect(records[5]).toMatchObject({
      input: { id: "evt_error", payload: { code: "runtime_failure", message: "runtime crashed" } },
    });
    expect(effectLabels(effects)).toEqual(["deliver task_finished", "deliver error"]);
    // A failure with no call left unknown leaves the next turn no note.
    expect(next.pendingNote).toBeNull();
  });

  it("refuses the end of a task that is not the conversation's", () => {
    expect(decide(running(), turnEnded({ taskId: "task_old" }))).toEqual({
      kind: "rejected",
      rejection: { kind: "no_task" },
    });
    expect(decide(idle(), turnEnded())).toEqual({
      kind: "rejected",
      rejection: { kind: "no_task" },
    });
  });
});

describe("memory-only transitions", () => {
  /** What an accepted memory-only transition moved to; it records and performs nothing. */
  const memoryOnly = (decided: Decided): ConversationState => {
    const { next, records, effects } = accepted(decided);
    expect([records, effects]).toEqual([[], []]);
    return next;
  };
  const otherTask = { kind: "rejected", rejection: { kind: "no_task" } };

  it("closes the gate of a task whose runtime exited, and remembers it ended, changing nothing else", () => {
    const state = awaiting([1]);
    const next = memoryOnly(decide(state, { kind: "runtime_exited", taskId: "task_1" }));
    expect(next).toEqual({
      ...state,
      task: state.task && { ...state.task, runtimeEnded: true, gateOpen: false },
    });
    expect(state.task).toMatchObject({ runtimeEnded: false, gateOpen: true });
    expect(decide(state, { kind: "runtime_exited", taskId: "task_old" })).toEqual(otherTask);
  });

  it("leaves the note of a turn whose end was not recorded, from the task as it stands, and nothing else", () => {
    const state = awaiting([1], { interrupted: true });
    const next = memoryOnly(decide(state, { kind: "turn_unrecorded", taskId: "task_1" }));
    expect(next).toEqual({ ...state, pendingNote: state.task && turnNote(state.task) });
    expect(next.pendingNote).toContain("mcp__d1__change: blocked_gate");
    const clean = running([{ ...held(3), status: "completed" }]);
    expect(memoryOnly(decide(clean, { kind: "turn_unrecorded", taskId: "task_1" }))).toEqual(clean);
    expect(decide(state, { kind: "turn_unrecorded", taskId: "task_old" })).toEqual(otherTask);
  });

  it("clears the task of a turn that ended, keeping the rest of the conversation", () => {
    const state = { ...awaiting([1]), pendingNote: "[Mia note] kept" };
    const next = memoryOnly(decide(state, { kind: "task_cleared", taskId: "task_1" }));
    expect(next).toEqual({ ...state, task: null });
    expect(decide(state, { kind: "task_cleared", taskId: "task_old" })).toEqual(otherTask);
    expect(decide(next, { kind: "task_cleared", taskId: "task_1" })).toEqual(otherTask);
  });

  it("decides none of them before the conversation has started", () => {
    const events: ConversationEvent[] = [
      { kind: "runtime_exited", taskId: "task_1" },
      { kind: "turn_unrecorded", taskId: "task_1" },
      { kind: "task_cleared", taskId: "task_1" },
      { ...abandonment("call_1"), kind: "abandonment_unrecorded" },
    ];
    for (const event of events)
      expect(decide(null, event)).toEqual({
        kind: "rejected",
        rejection: { kind: "not_started" },
      });
  });
});

const REPORT: ClientDiagnostics = {
  build: { name: "mia-text-client", version: "0.1.0", commit: null, dirty: null },
  connection_state: "connected",
  recent_interaction_ids: [],
  recent_errors: [],
  voice: "not_applicable",
  display: "not_applicable",
  captured_at: AT_RUNTIME,
};

const diagnostics = (): DiagnosticsReportedEvent => ({
  kind: "client_diagnostics",
  origin: ORIGIN,
  from: { clientId: "client_other", connectionId: "conn_2" },
  diagnostics: REPORT,
  ids: { event: "evt_diagnostics", diagnostics: "diag_1" },
});

describe("client diagnostics", () => {
  it("records the report and the row that names it, under the task, from the client that sent it", () => {
    const state = running();
    const { next, records, effects } = accepted(decide(state, diagnostics()));
    expect(records).toEqual([
      {
        kind: "append_event",
        input: {
          id: "evt_diagnostics",
          receivedAt: AT,
          conversationId: "conv_1",
          type: "client_diagnostics",
          payload: {
            client_id: "client_other",
            captured_at: AT_RUNTIME,
            connection_state: "connected",
          },
          taskId: "task_1",
          executionId: null,
          clientId: "client_owner",
          clientConnectionId: "conn_1",
          causedByEventId: null,
        },
      },
      {
        kind: "record_diagnostics",
        input: {
          id: "diag_1",
          receivedAt: AT,
          conversationId: "conv_1",
          clientId: "client_other",
          clientConnectionId: "conn_2",
          taskId: "task_1",
          eventId: "evt_diagnostics",
          capturedAt: AT_RUNTIME,
          state: REPORT,
        },
      },
    ]);
    expect(effects).toEqual([]);
    expect(next).toBe(state);
    const between = accepted(decide(idle(), diagnostics()));
    expect(between.records).toMatchObject([
      { input: { taskId: null } },
      { input: { taskId: null } },
    ]);
  });
});

const disconnect = (): ClientDisconnectedEvent => ({
  kind: "client_disconnected",
  origin: ORIGIN,
  connectionId: "conn_1",
  ids: { event: "evt_disconnected" },
});

describe("disconnect", () => {
  it("records the disconnect with the approvals still pending in request order, and changes nothing else", () => {
    const state = awaiting([2, 1]);
    const { next, records, effects } = accepted(decide(state, disconnect()));
    expect(records).toMatchObject([
      {
        kind: "append_event",
        input: {
          id: "evt_disconnected",
          type: "client_disconnected",
          payload: { connection_id: "conn_1", pending_approvals: ["appr_2", "appr_1"] },
          taskId: "task_1",
        },
      },
    ]);
    expect(effects).toEqual([]);
    expect(next).toBe(state);
    expect(accepted(decide(idle(), disconnect())).records).toMatchObject([
      { input: { payload: { pending_approvals: [] }, taskId: null } },
    ]);
  });
});

/** A stored, named provenance plan: the agent prompt retained, the architecture document unavailable. */
const startPlan: NamedProvenancePlan = {
  setId: "prov_new",
  description: "test",
  items: [
    {
      availability: "retained",
      role: "agent_prompt",
      content: { digest: "digest_prompt", byteCount: 1, storageKey: "key_prompt" },
      version: "v1",
      mime: "text/markdown",
      logicalName: "agent_prompt",
      entryId: "pe_prompt",
      artifactId: "art_prompt",
      linkId: "link_prompt",
    },
    {
      availability: "unavailable",
      role: "architecture",
      reason: "missing",
      entryId: "pe_architecture",
    },
  ],
  summary: {
    agent_prompt_version: "v1",
    configuration_digest: "config",
    architecture_revision: null,
    server_build: {
      name: "mia",
      version: "0",
      commit: null,
      dirty: null,
      local_changes_digest: null,
      source_root: "/",
    },
    runtime_version: null,
  },
};

const start = (overrides: Partial<ConversationStartEvent> = {}): ConversationStartEvent => ({
  kind: "start_conversation",
  origin: ORIGIN,
  closes: "conv_1",
  provenance: startPlan,
  promptFile: "/tmp/objects/digest_prompt",
  conversationsRoot: "/tmp/conversations",
  debugMode: false,
  ids: {
    conversation: "conv_new",
    runtimeConversation: "runtime_conv_new",
    provenanceRecorded: "evt_provenance",
    started: "evt_started",
    captured: "evt_debug",
  },
  ...overrides,
});

describe("conversation start", () => {
  it("records the provenance, the conversation and the close of the one it replaces, then tells the client", () => {
    const { next, records, effects } = accepted(decide(null, start()));
    expect(labels(records)).toEqual([
      "create_provenance_set",
      "register_artifact",
      "add_provenance_entry",
      "add_provenance_entry",
      "create_conversation",
      "link_artifact",
      "update_conversation",
      "provenance_recorded",
      "conversation_started",
    ]);
    expect(records).toContainEqual({
      kind: "create_conversation",
      input: {
        id: "conv_new",
        startedAt: AT,
        provenanceSetId: "prov_new",
        runtimeConversationId: "runtime_conv_new",
      },
    });
    expect(records).toContainEqual({
      kind: "link_artifact",
      input: {
        id: "link_prompt",
        conversationId: "conv_new",
        artifactId: "art_prompt",
        relation: "provenance",
        provenanceSetId: "prov_new",
      },
    });
    expect(records).toContainEqual({
      kind: "update_conversation",
      id: "conv_1",
      fields: { status: "closed" },
    });
    // Both events belong to the new conversation, under the client and connection that started it.
    expect(records.filter((record) => record.kind === "append_event")).toMatchObject([
      {
        input: {
          id: "evt_provenance",
          conversationId: "conv_new",
          payload: { provenance_set_id: "prov_new", agent_prompt_digest: "digest_prompt" },
          clientId: ORIGIN.clientId,
          clientConnectionId: ORIGIN.connectionId,
          taskId: null,
        },
      },
      {
        input: {
          id: "evt_started",
          conversationId: "conv_new",
          payload: {
            conversation_id: "conv_new",
            started_at: AT,
            provenance_set_id: "prov_new",
          },
        },
      },
    ]);
    // The conversation becomes the active one, under its start's client and connection, before the client is told.
    expect(effects).toMatchObject([
      { kind: "activate_conversation", origin: ORIGIN },
      { kind: "deliver_event", eventId: "evt_started", event: { type: "conversation_started" } },
    ]);
    expect(next).toEqual({
      id: "conv_new",
      runtimeConversationId: "runtime_conv_new",
      provenanceSetId: "prov_new",
      directory: `/tmp/conversations/${AT.replace(/[:.]/g, "-")}_conv_new`,
      promptFile: "/tmp/objects/digest_prompt",
      turnCount: 0,
      sessionStarted: false,
      epoch: 0,
      pendingNote: null,
      task: null,
    });
  });

  it("closes nothing for the server's first conversation, and records debug mode after conversation_started", () => {
    const { records } = accepted(decide(null, start({ closes: null, debugMode: true })));
    expect(labels(records)).not.toContain("update_conversation");
    expect(labels(records).slice(-3)).toEqual([
      "provenance_recorded",
      "conversation_started",
      "captured_in_debug_mode",
    ]);
    expect(records.at(-1)).toEqual({
      kind: "append_event",
      input: {
        id: "evt_debug",
        receivedAt: AT,
        conversationId: "conv_new",
        type: "captured_in_debug_mode",
        payload: {},
        taskId: null,
        executionId: null,
        clientId: ORIGIN.clientId,
        clientConnectionId: ORIGIN.connectionId,
        causedByEventId: null,
      },
    });
  });

  it("refuses a second start of a started conversation, and anything but a start before one", () => {
    expect(decide(awaiting([]), start())).toEqual({
      kind: "rejected",
      rejection: { kind: "already_started" },
    });
    expect(decide(null, disconnect())).toEqual({
      kind: "rejected",
      rejection: { kind: "not_started" },
    });
  });
});
