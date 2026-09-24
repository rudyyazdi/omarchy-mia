import { match } from "ts-pattern";
import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "@mia/agent-adapter";
import { canonicalDigest } from "@mia/protocol";
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
  type ConversationDecision,
  type ConversationEvent,
  type InterruptTaskEvent,
  type PermissionRefusedEvent,
  type PermissionRequestEvent,
  type PromptAbandonedEvent,
  type RuntimeEventReceived,
} from "./decide-conversation.ts";
import type { EngineEffect } from "./engine-effects.ts";
import type { EngineRecord } from "./engine-records.ts";
import type { McpBodyRecord } from "./mcp-bodies.ts";

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
      .with({ kind: "answer_permission" }, ({ answer }) =>
        match(answer)
          .with({ kind: "answer" }, ({ decision }) => `answer request ${decision.behavior}`)
          .with({ kind: "hold" }, ({ approvalId }) => `hold request ${approvalId}`)
          .exhaustive(),
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
    // The hold is the last effect: the boundary places it once the commit has returned.
    expect(effectLabels(effects)).toEqual([
      "deliver approval_requested",
      "notify call_new awaiting_approval",
      "hold request appr_new",
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
    expect(effectLabels(effects)).toEqual(["notify call_1 dispatched", "answer request allow"]);
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
    expect(effectLabels(unlisted.effects)).toEqual([
      "deliver error",
      "notify call_new denied",
      "answer request deny",
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
      "deliver approval_resolved",
      "answer appr_1 deny",
      "deliver approval_requested",
      "notify call_new awaiting_approval",
      "hold request appr_new",
    ]);
    expect(next.task?.pendingApprovals).toEqual(new Map([["appr_new", "call_new"]]));
    expect(next.task && callById(next.task, "call_1")?.status).toBe("invalidated");
  });

  it("refuses a request with no runtime call id, a duplicate of one awaiting approval, or for another task", () => {
    const refusal = (state: ConversationState, event: PermissionRequestEvent) => {
      const decided = decide(state, event);
      return decided.kind === "rejected" ? decided.rejection : decided;
    };
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

  it("records a refusal as a runtime failure the client is told of", () => {
    const refused: PermissionRefusedEvent = {
      kind: "permission_refused",
      origin: ORIGIN,
      taskId: "task_1",
      detail: "refused for a reason",
      ids: { event: "evt_refused" },
    };
    const { next, records, effects } = accepted(decide(running(), refused));
    expect(records).toMatchObject([
      {
        kind: "append_event",
        input: {
          id: "evt_refused",
          type: "error",
          taskId: "task_1",
          payload: { code: "runtime_failure", message: "refused for a reason" },
        },
      },
    ]);
    expect(effectLabels(effects)).toEqual(["deliver error"]);
    expect(next).toEqual(running());
  });
});

const RUNTIME_IDS = {
  event: "evt_runtime",
  resolved: "evt_superseded",
  call: "call_new",
  unmatched: "evt_unmatched",
};

const NOTHING_READ = { output: null, bodies: null, policy: null };

const reported = (
  event: RuntimeEvent,
  reads: Partial<RuntimeEventReceived["reads"]> = {},
): RuntimeEventReceived => ({
  kind: "runtime_event",
  origin: ORIGIN,
  taskId: "task_1",
  event,
  reads: { ...NOTHING_READ, ...reads },
  ids: RUNTIME_IDS,
});

const AT_RUNTIME = "2026-09-24T11:59:59.000Z";

describe("runtime events", () => {
  it("records an init's model and marks the session started", () => {
    const state = { ...running(), sessionStarted: false };
    const init = { model: "claude-x", evidence: { session: 1 } };
    const { next, records } = accepted(
      decide(state, reported({ type: "runtime_init", init, at: AT_RUNTIME })),
    );
    expect(labels(records)).toEqual(["runtime_init", "update_execution"]);
    expect(records[1]).toMatchObject({ id: "exec_1", fields: { reportedModel: "claude-x" } });
    expect(next.sessionStarted).toBe(true);
    expect(next.task?.reportedModel).toBe("claude-x");
    expect(state.sessionStarted).toBe(false);
  });

  it("proposes a revision for a complete proposal with the policy read for its tool, and attaches a repeat to it", () => {
    const args = { delta: 1 };
    const proposal: RuntimeEvent = {
      type: "tool_proposed",
      runtimeCallId: "toolu_9",
      toolIdentity: "mcp__d1__change",
      arguments: args,
      complete: true,
      at: AT_RUNTIME,
    };
    const proposed = accepted(decide(running(), reported(proposal, { policy: "ask" })));
    expect(labels(proposed.records)).toEqual(["tool_proposed", "create_tool_call"]);
    expect(proposed.records[1]).toMatchObject({
      input: { id: "call_new", policy: "ask", status: "proposed", proposalEventId: "evt_runtime" },
    });
    expect(effectLabels(proposed.effects)).toEqual(["notify call_new proposed"]);
    const attached = accepted(decide(proposed.next, reported(proposal, { policy: "ask" })));
    expect(labels(attached.records)).toEqual(["tool_proposed", "update_tool_call"]);
    expect(attached.records[1]).toMatchObject({
      id: "call_new",
      fields: { proposalEventId: "evt_runtime" },
    });
    expect(attached.effects).toEqual([]);
    expect(() => decide(running(), reported(proposal))).toThrow(
      "no policy was read for mcp__d1__change",
    );
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
      reported(
        {
          type: "tool_result",
          runtimeCallId,
          isError: false,
          content: "ok",
          raw: {},
          at: AT_RUNTIME,
        },
        { output, bodies },
      );
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
    const stderr = reported({ type: "runtime_stderr", text: "late", at: AT_RUNTIME });
    expect(refusal(running([], { runtimeEnded: true }), stderr)).toEqual({ kind: "runtime_ended" });
    expect(refusal(running(), { ...stderr, taskId: "task_old" })).toEqual({ kind: "no_task" });
  });
});
