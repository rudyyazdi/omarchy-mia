import { describe, expect, it } from "vitest";
import type { TurnResult } from "@mia/agent-adapter";
import type { TaskStatus, ToolCallPolicy, ToolCallStatus } from "@mia/protocol";
import {
  bindPermissionRequest,
  bindStreamProposal,
  bindToolResult,
  classifyActions,
  classifyTask,
  decideAbandonment,
  decideApproval,
  decideInterruption,
  evaluatePermission,
  noteAfterTurn,
  statusAfterResult,
  supersedeBinding,
  taskStatusAfterResolving,
  type CallFacts,
  type PendingTask,
} from "./transitions.ts";

const call = (status: ToolCallStatus, id = "call_1"): CallFacts => ({
  id,
  toolIdentity: "mcp__d1__change",
  status,
});

const approval = (
  overrides: Partial<Parameters<typeof decideApproval<CallFacts>>[0]> = {},
): Parameters<typeof decideApproval<CallFacts>>[0] => ({
  decision: "approve",
  ownerClientId: "client-A",
  deciderClientId: "client-A",
  call: call("awaiting_approval"),
  task: { status: "awaiting_approval", gateOpen: true, epoch: 1, otherPending: 0 },
  conversationEpoch: 1,
  ...overrides,
});

/** A task whose only pending approval is the one being resolved. */
const lastPending: PendingTask = { status: "awaiting_approval", otherPending: 0 };

type Superseding = Parameters<typeof supersedeBinding>[0];

/** supersedeBinding with the one approval_resolved event id every case here draws. */
const supersede = (
  earlier: Superseding["call"],
  next: Superseding["next"],
  task: PendingTask,
): ReturnType<typeof supersedeBinding> =>
  supersedeBinding({ call: earlier, next, task, resolvedEventId: "evt_1" });

describe("taskStatusAfterResolving", () => {
  it("resumes a task awaiting approval once none is left pending, and only then", () => {
    expect(taskStatusAfterResolving("awaiting_approval", 0)).toBe("running");
    expect(taskStatusAfterResolving("awaiting_approval", 1)).toBe("awaiting_approval");
  });

  it("leaves any other task status alone", () => {
    const others: TaskStatus[] = ["running", "interrupting", "completed", "interrupted"];
    for (const status of others) expect(taskStatusAfterResolving(status, 0)).toBe(status);
  });
});

describe("decideApproval", () => {
  it("releases an approved call while the gate is open in the task's epoch and resumes the task", () => {
    const outcome = decideApproval(approval());
    expect(outcome).toMatchObject({
      kind: "decided",
      approval: "approved",
      release: true,
      change: { callId: "call_1", status: "dispatched", settle: { behavior: "allow" } },
      taskStatus: "running",
    });
  });

  it("keeps the task awaiting approval while other approvals are pending", () => {
    expect(
      decideApproval(
        approval({
          task: { status: "awaiting_approval", gateOpen: true, epoch: 1, otherPending: 1 },
        }),
      ),
    ).toMatchObject({
      taskStatus: "awaiting_approval",
    });
  });

  it("never releases a rejected call", () => {
    expect(decideApproval(approval({ decision: "reject" }))).toMatchObject({
      kind: "decided",
      approval: "rejected",
      release: false,
      change: { status: "denied", settle: { behavior: "deny" } },
    });
  });

  it("blocks an approval after the gate closed or the epoch moved on", () => {
    const closed = decideApproval(
      approval({ task: { status: "interrupting", gateOpen: false, epoch: 1, otherPending: 0 } }),
    );
    const stale = decideApproval(approval({ conversationEpoch: 2 }));
    for (const outcome of [closed, stale])
      expect(outcome).toMatchObject({
        kind: "decided",
        approval: "approved",
        release: false,
        change: { status: "blocked_gate", settle: { behavior: "deny" } },
      });
  });

  it("rejects a stale approval of an interrupted task without releasing it", () => {
    expect(
      decideApproval(
        approval({
          call: call("invalidated"),
          task: { status: "interrupting", gateOpen: false, epoch: 1, otherPending: 0 },
          conversationEpoch: 2,
        }),
      ),
    ).toEqual({ kind: "not_pending" });
  });

  it("refuses a decision on a call that is not pending", () => {
    expect(decideApproval(approval({ call: undefined }))).toEqual({ kind: "not_pending" });
    const settled: ToolCallStatus[] = ["dispatched", "denied", "proposed"];
    for (const status of settled)
      expect(decideApproval(approval({ call: call(status) }))).toEqual({ kind: "not_pending" });
  });

  it("refuses a decision from a client that does not own the task, before anything else", () => {
    expect(decideApproval(approval({ deciderClientId: "client-B", call: undefined }))).toEqual({
      kind: "not_owner",
    });
  });
});

describe("decideInterruption", () => {
  const pending = [
    { approvalId: "appr_1", call: call("awaiting_approval", "call_1"), resolvedEventId: "evt_1" },
    { approvalId: "appr_2", call: call("awaiting_approval", "call_2"), resolvedEventId: "evt_2" },
  ];

  it("closes the gate, advances the epoch, and invalidates every pending approval without release", () => {
    const outcome = decideInterruption({
      taskStatus: "awaiting_approval",
      runtimeEnded: false,
      conversationEpoch: 3,
      pending,
    });
    if (outcome.kind !== "interrupt")
      throw new Error(`expected an interruption, got ${outcome.kind}`);
    expect(outcome.epoch).toBe(4);
    expect(outcome.task).toEqual({ status: "interrupting", gateOpen: false, interrupted: true });
    expect(
      outcome.approvals.map((change) => [change.approvalId, change.eventId, change.status]),
    ).toEqual([
      ["appr_1", "evt_1", "invalidated"],
      ["appr_2", "evt_2", "invalidated"],
    ]);
    for (const { change } of outcome.calls) {
      expect(change.status).toBe("invalidated");
      expect(change.settle).toMatchObject({ behavior: "deny", interrupt: true });
    }
  });

  it("is idempotent while interrupting and refuses a finished task", () => {
    expect(
      decideInterruption({
        taskStatus: "interrupting",
        runtimeEnded: false,
        conversationEpoch: 3,
        pending,
      }),
    ).toEqual({ kind: "already_interrupting" });
    const finished: TaskStatus[] = ["completed", "failed", "interrupted", "outcome_unknown"];
    for (const taskStatus of finished)
      expect(
        decideInterruption({ taskStatus, runtimeEnded: false, conversationEpoch: 3, pending }),
      ).toEqual({
        kind: "invalid",
        taskStatus,
      });
  });

  it("interrupts nothing once the runtime has ended, unless an interruption is already under way", () => {
    for (const taskStatus of ["running", "awaiting_approval"] satisfies TaskStatus[])
      expect(
        decideInterruption({ taskStatus, runtimeEnded: true, conversationEpoch: 3, pending }),
      ).toEqual({ kind: "runtime_ended" });
    expect(
      decideInterruption({
        taskStatus: "interrupting",
        runtimeEnded: true,
        conversationEpoch: 3,
        pending,
      }),
    ).toEqual({ kind: "already_interrupting" });
  });
});

describe("decideAbandonment", () => {
  it("expires a pending approval and invalidates its call; the prompt is always refused", () => {
    const outcome = decideAbandonment({
      call: call("awaiting_approval"),
      approvalId: "appr_1",
      pending: true,
      task: lastPending,
      resolvedEventId: "evt_1",
    });
    expect(outcome.expire).toMatchObject({
      approval: { approvalId: "appr_1", eventId: "evt_1", status: "expired" },
      call: { callId: "call_1", status: "invalidated" },
    });
    expect(outcome.settle.behavior).toBe("deny");
  });

  it("resumes the task when the abandoned approval was the last pending, and not while others are", () => {
    const abandon = (task: PendingTask) =>
      decideAbandonment({
        call: call("awaiting_approval"),
        approvalId: "appr_1",
        pending: true,
        task,
        resolvedEventId: "evt_1",
      }).expire?.taskStatus;
    expect(abandon(lastPending)).toBe("running");
    expect(abandon({ status: "awaiting_approval", otherPending: 1 })).toBe("awaiting_approval");
  });

  it("changes nothing for an approval already resolved, and still refuses the prompt", () => {
    const outcome = decideAbandonment({
      call: call("denied"),
      approvalId: "appr_1",
      pending: false,
      task: { status: "running", otherPending: 0 },
      resolvedEventId: "evt_1",
    });
    expect(outcome.expire).toBeNull();
    expect(outcome.settle.behavior).toBe("deny");
  });
});

describe("evaluatePermission", () => {
  const toolIdentity = "mcp__d1__change";

  it("denies by policy before looking at the gate", () => {
    expect(
      evaluatePermission({ policy: "deny", gateOpen: false, toolIdentity, promptsFull: false }),
    ).toMatchObject({
      kind: "deny",
      status: "denied",
      interrupt: false,
    });
    expect(
      evaluatePermission({ policy: "unlisted", gateOpen: true, toolIdentity, promptsFull: false }),
    ).toMatchObject({
      kind: "deny",
      unlisted: true,
    });
  });

  it("blocks an allowed or asked call once the gate is closed", () => {
    const permitted: ToolCallPolicy[] = ["allow", "ask"];
    for (const policy of permitted)
      expect(
        evaluatePermission({ policy, gateOpen: false, toolIdentity, promptsFull: false }),
      ).toMatchObject({
        kind: "deny",
        status: "blocked_gate",
        interrupt: true,
      });
  });

  it("dispatches an allowed call and asks for an asked one while the gate is open", () => {
    expect(
      evaluatePermission({ policy: "allow", gateOpen: true, toolIdentity, promptsFull: false }),
    ).toEqual({
      kind: "dispatch",
    });
    expect(
      evaluatePermission({ policy: "ask", gateOpen: true, toolIdentity, promptsFull: false }),
    ).toEqual({
      kind: "ask",
    });
  });

  it("denies an asked call without asking while the held prompts are full, and still dispatches an allowed one", () => {
    expect(
      evaluatePermission({ policy: "ask", gateOpen: true, toolIdentity, promptsFull: true }),
    ).toMatchObject({
      kind: "deny",
      status: "denied",
      interrupt: false,
      unlisted: false,
      message: expect.stringContaining("too many approval prompts"),
    });
    expect(
      evaluatePermission({ policy: "allow", gateOpen: true, toolIdentity, promptsFull: true }),
    ).toEqual({
      kind: "dispatch",
    });
  });
});

describe("binding", () => {
  const latest: { status: ToolCallStatus; toolIdentity: string; digest: string } = {
    status: "proposed",
    toolIdentity: "mcp__d1__change",
    digest: "d1",
  };
  const held: typeof latest = { ...latest, status: "awaiting_approval" };
  const same = { toolIdentity: "mcp__d1__change", digest: "d1" };
  const next = { ...same, digest: "d2" };

  it("reuses the latest revision only while it is proposed with the same tool and arguments", () => {
    expect(bindPermissionRequest(latest, same)).toEqual({ kind: "reuse", call: latest });
    expect(bindPermissionRequest(latest, { ...same, digest: "d2" })).toEqual({ kind: "propose" });
    expect(bindPermissionRequest(latest, { ...same, toolIdentity: "mcp__d1__read" })).toEqual({
      kind: "propose",
    });
    expect(bindPermissionRequest({ ...latest, status: "dispatched" }, same)).toEqual({
      kind: "propose",
    });
    expect(bindPermissionRequest(undefined, same)).toEqual({ kind: "propose" });
  });

  it("refuses a request identical to one already awaiting approval, without a second approval", () => {
    expect(bindPermissionRequest(held, same)).toMatchObject({
      kind: "duplicate",
      settle: { behavior: "deny" },
    });
    expect(bindPermissionRequest(held, { ...same, digest: "d2" })).toEqual({ kind: "propose" });
    expect(bindPermissionRequest(held, { ...same, toolIdentity: "mcp__d1__read" })).toEqual({
      kind: "propose",
    });
  });

  it("attaches a stream proposal to a revision only when tool and arguments both match", () => {
    expect(bindStreamProposal([latest], same)).toEqual({ kind: "attach", call: latest });
    expect(bindStreamProposal([held], same)).toEqual({ kind: "attach", call: held });
    expect(bindStreamProposal([latest], { ...same, digest: "d2" })).toEqual({ kind: "propose" });
    expect(bindStreamProposal([held], { ...same, toolIdentity: "mcp__d1__read" })).toEqual({
      kind: "propose",
    });
    expect(bindStreamProposal([], same)).toEqual({ kind: "propose" });
  });

  it.each<ToolCallStatus>(["dispatched", "denied", "invalidated", "blocked_gate"])(
    "attaches a matching stream proposal to a %s call, since the request can come first",
    (status) => {
      const settled: typeof latest = { ...latest, status };
      expect(bindStreamProposal([settled], same)).toEqual({ kind: "attach", call: settled });
      expect(bindStreamProposal([settled], { ...same, digest: "d2" })).toEqual({
        kind: "propose",
      });
      expect(bindStreamProposal([settled], { ...same, toolIdentity: "mcp__d1__read" })).toEqual({
        kind: "propose",
      });
    },
  );

  it("attaches a late stream line to the earlier revision it announces, not the later one awaiting approval", () => {
    const earlier: typeof latest = { ...latest, status: "invalidated" };
    const later: typeof latest = { ...held, digest: "d2" };
    expect(bindStreamProposal([earlier, later], same)).toEqual({ kind: "attach", call: earlier });
    expect(bindStreamProposal([earlier, later], next)).toEqual({ kind: "attach", call: later });
    expect(bindStreamProposal([earlier, later], { ...same, digest: "d3" })).toEqual({
      kind: "propose",
    });
  });

  it("attaches to the latest of several revisions with the same binding", () => {
    const first: typeof latest = { ...latest, status: "invalidated" };
    const middle: typeof latest = { ...latest, status: "invalidated", digest: "d2" };
    const last: typeof latest = { ...held };
    expect(bindStreamProposal([first, middle, last], same)).toEqual({ kind: "attach", call: last });
  });

  it("invalidates a held binding and its approval, and leaves a released one alone", () => {
    const revision = (status: ToolCallStatus, approvalId: string | null) => ({
      ...call(status),
      digest: "d1",
      approvalId,
    });
    expect(supersede(revision("awaiting_approval", "appr_1"), next, lastPending)).toMatchObject({
      approval: {
        approvalId: "appr_1",
        eventId: "evt_1",
        status: "invalidated",
        reason: "arguments changed",
      },
      call: { status: "invalidated", settle: { behavior: "deny" } },
    });
    expect(supersede(revision("proposed", null), next, lastPending)?.approval).toBeNull();
    expect(supersede(revision("dispatched", null), next, lastPending)).toBeNull();
  });

  it("resumes the task when it supersedes the last pending approval, and not while others are pending", () => {
    const held = { ...call("awaiting_approval"), digest: "d1", approvalId: "appr_1" };
    expect(supersede(held, next, lastPending)?.taskStatus).toBe("running");
    expect(
      supersede(held, next, { status: "awaiting_approval", otherPending: 1 })?.taskStatus,
    ).toBe("awaiting_approval");
    const proposed = { ...call("proposed"), digest: "d1", approvalId: null };
    expect(supersede(proposed, next, { status: "running", otherPending: 0 })?.taskStatus).toBe(
      "running",
    );
  });

  it("says whether the tool or the arguments changed", () => {
    const held = { ...call("awaiting_approval"), digest: "d1", approvalId: "appr_1" };
    expect(
      supersede(held, { toolIdentity: "mcp__d1__read", digest: "d1" }, lastPending),
    ).toMatchObject({
      approval: { reason: "tool changed" },
      call: { settle: { message: expect.stringContaining("the tool changed") } },
    });
    expect(supersede(held, next, lastPending)).toMatchObject({
      call: { settle: { message: expect.stringContaining("the arguments changed") } },
    });
  });
});

describe("completion", () => {
  it("settles a released call with its result and never revives a terminal one", () => {
    expect(statusAfterResult("dispatched", false)).toBe("completed");
    expect(statusAfterResult("dispatched", true)).toBe("failed");
    expect(statusAfterResult("denied", false)).toBe("denied");
    expect(statusAfterResult("invalidated", false)).toBe("invalidated");
  });

  it.each<ToolCallStatus>(["proposed", "awaiting_approval"])(
    "never completes a %s call, which Mia never released",
    (status) => {
      expect(statusAfterResult(status, false)).toBe(status);
      expect(statusAfterResult(status, true)).toBe(status);
    },
  );

  it("binds a result to the released revision, not a later one still held", () => {
    const released = call("dispatched", "rev1");
    const heldLater = call("proposed", "rev2");
    expect(bindToolResult([released, heldLater])).toEqual({ kind: "bind", call: released });
    expect(bindToolResult([call("permitted", "rev1"), call("awaiting_approval", "rev2")])).toEqual({
      kind: "bind",
      call: call("permitted", "rev1"),
    });
  });

  it("binds a result to the latest released revision over a later refused one", () => {
    const released = call("dispatched", "rev2");
    expect(bindToolResult([call("invalidated", "rev1"), released, call("denied", "rev3")])).toEqual(
      { kind: "bind", call: released },
    );
  });

  it.each<ToolCallStatus>(["denied", "blocked_gate", "invalidated"])(
    "binds a result with nothing released to the latest %s revision",
    (status) => {
      const refused = call(status, "rev1");
      expect(bindToolResult([refused, call("proposed", "rev2")])).toEqual({
        kind: "bind",
        call: refused,
      });
    },
  );

  it.each<ToolCallStatus>(["completed", "failed"])(
    "leaves a repeated result unmatched rather than replacing a %s call's result",
    (status) => {
      expect(bindToolResult([call(status, "rev1"), call("proposed", "rev2")])).toEqual({
        kind: "unmatched",
      });
    },
  );

  it("leaves a result unmatched when every revision is still held, or there is none", () => {
    expect(bindToolResult([call("proposed", "rev1"), call("awaiting_approval", "rev2")])).toEqual({
      kind: "unmatched",
    });
    expect(bindToolResult([])).toEqual({ kind: "unmatched" });
  });

  it("classifies a released call without a result as unknown and a held one as never run", () => {
    const calls = [
      call("dispatched", "a"),
      call("awaiting_approval", "b"),
      call("completed", "c"),
      call("permitted", "d"),
    ];
    expect(classifyActions(calls, true).map((action) => action.status)).toEqual([
      "unknown",
      "blocked_gate",
      "completed",
      "unknown",
    ]);
    expect(classifyActions(calls, false).map((action) => action.status)).toEqual([
      "unknown",
      "invalidated",
      "completed",
      "unknown",
    ]);
    expect(calls[0]?.status).toBe("dispatched");
  });

  it("reports an unknown action as outcome_unknown whatever the turn's own result", () => {
    const completed: Pick<TurnResult, "status" | "error"> = { status: "completed", error: null };
    const failed: Pick<TurnResult, "status" | "error"> = { status: "failed", error: "boom" };
    expect(classifyTask({ interrupted: false, result: completed, unknown: false })).toEqual({
      status: "completed",
    });
    expect(classifyTask({ interrupted: false, result: failed, unknown: false })).toEqual({
      status: "failed",
      error: "boom",
    });
    expect(classifyTask({ interrupted: true, result: failed, unknown: false }).status).toBe(
      "interrupted",
    );
    for (const interrupted of [true, false])
      expect(classifyTask({ interrupted, result: completed, unknown: true }).status).toBe(
        "outcome_unknown",
      );
  });

  it("carries a note into the next turn only when something may have happened or was abandoned", () => {
    const quiet = { interrupted: false, actions: [], abandoned: [] };
    expect(noteAfterTurn(quiet)).toBeNull();
    const unknown = classifyActions([call("dispatched")], false);
    expect(noteAfterTurn({ ...quiet, actions: unknown })).toContain("mcp__d1__change: unknown");
    expect(
      noteAfterTurn({
        ...quiet,
        abandoned: [{ toolIdentity: "mcp__d1__change", redactedArguments: {} }],
      }),
    ).toContain("abandoned the approval prompt");
  });
});
