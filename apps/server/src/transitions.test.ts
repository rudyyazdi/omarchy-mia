import { describe, expect, it } from "vitest";
import type { TurnResult } from "@mia/agent-adapter";
import type { TaskStatus, ToolCallStatus } from "@mia/protocol";
import type { ToolCallPolicy } from "@mia/records";
import {
  bindPermissionRequest,
  bindStreamProposal,
  classifyActions,
  classifyTask,
  decideAbandonment,
  decideApproval,
  decideInterruption,
  evaluatePermission,
  noteAfterTurn,
  statusAfterResult,
  supersedeBinding,
  type CallFacts,
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
  task: { status: "awaiting_approval", gateOpen: true, epoch: 1 },
  conversationEpoch: 1,
  otherPending: 0,
  ...overrides,
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
    expect(decideApproval(approval({ otherPending: 1 }))).toMatchObject({
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
      approval({ task: { status: "interrupting", gateOpen: false, epoch: 1 } }),
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
          task: { status: "interrupting", gateOpen: false, epoch: 1 },
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
    { approvalId: "appr_1", call: call("awaiting_approval", "call_1") },
    { approvalId: "appr_2", call: call("awaiting_approval", "call_2") },
  ];

  it("closes the gate, advances the epoch, and invalidates every pending approval without release", () => {
    const outcome = decideInterruption({
      taskStatus: "awaiting_approval",
      conversationEpoch: 3,
      pending,
    });
    if (outcome.kind !== "interrupt")
      throw new Error(`expected an interruption, got ${outcome.kind}`);
    expect(outcome.epoch).toBe(4);
    expect(outcome.task).toEqual({ status: "interrupting", gateOpen: false, interrupted: true });
    expect(outcome.approvals.map((change) => [change.approvalId, change.status])).toEqual([
      ["appr_1", "invalidated"],
      ["appr_2", "invalidated"],
    ]);
    for (const { change } of outcome.calls) {
      expect(change.status).toBe("invalidated");
      expect(change.settle).toMatchObject({ behavior: "deny", interrupt: true });
    }
  });

  it("is idempotent while interrupting and refuses a finished task", () => {
    expect(
      decideInterruption({ taskStatus: "interrupting", conversationEpoch: 3, pending }),
    ).toEqual({ kind: "already_interrupting" });
    const finished: TaskStatus[] = ["completed", "failed", "interrupted", "outcome_unknown"];
    for (const taskStatus of finished)
      expect(decideInterruption({ taskStatus, conversationEpoch: 3, pending })).toEqual({
        kind: "invalid",
        taskStatus,
      });
  });
});

describe("decideAbandonment", () => {
  it("expires a pending approval and invalidates its call; the prompt is always refused", () => {
    const outcome = decideAbandonment({
      call: call("awaiting_approval"),
      approvalId: "appr_1",
      pending: true,
    });
    expect(outcome.expire).toMatchObject({
      approval: { approvalId: "appr_1", status: "expired" },
      call: { callId: "call_1", status: "invalidated" },
    });
    expect(outcome.settle.behavior).toBe("deny");
  });

  it("changes nothing for an approval already resolved, and still refuses the prompt", () => {
    const outcome = decideAbandonment({
      call: call("denied"),
      approvalId: "appr_1",
      pending: false,
    });
    expect(outcome.expire).toBeNull();
    expect(outcome.settle.behavior).toBe("deny");
  });
});

describe("evaluatePermission", () => {
  const toolIdentity = "mcp__d1__change";

  it("denies by policy before looking at the gate", () => {
    expect(evaluatePermission({ policy: "deny", gateOpen: false, toolIdentity })).toMatchObject({
      kind: "deny",
      status: "denied",
      interrupt: false,
    });
    expect(evaluatePermission({ policy: "unlisted", gateOpen: true, toolIdentity })).toMatchObject({
      kind: "deny",
      unlisted: true,
    });
  });

  it("blocks an allowed or asked call once the gate is closed", () => {
    const permitted: ToolCallPolicy[] = ["allow", "ask"];
    for (const policy of permitted)
      expect(evaluatePermission({ policy, gateOpen: false, toolIdentity })).toMatchObject({
        kind: "deny",
        status: "blocked_gate",
        interrupt: true,
      });
  });

  it("dispatches an allowed call and asks for an asked one while the gate is open", () => {
    expect(evaluatePermission({ policy: "allow", gateOpen: true, toolIdentity })).toEqual({
      kind: "dispatch",
    });
    expect(evaluatePermission({ policy: "ask", gateOpen: true, toolIdentity })).toEqual({
      kind: "ask",
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

  it("attaches a stream proposal to the latest revision only when tool and arguments both match", () => {
    expect(bindStreamProposal(latest, same)).toEqual({ kind: "attach", call: latest });
    expect(bindStreamProposal(held, same)).toEqual({ kind: "attach", call: held });
    expect(bindStreamProposal(latest, { ...same, digest: "d2" })).toEqual({ kind: "propose" });
    expect(bindStreamProposal(held, { ...same, toolIdentity: "mcp__d1__read" })).toEqual({
      kind: "propose",
    });
    expect(bindStreamProposal(undefined, same)).toEqual({ kind: "propose" });
  });

  it("attaches a matching stream proposal to a call already released, since the request can come first", () => {
    const released: typeof latest = { ...latest, status: "dispatched" };
    expect(bindStreamProposal(released, same)).toEqual({ kind: "attach", call: released });
    expect(bindStreamProposal(released, { ...same, toolIdentity: "mcp__d1__read" })).toEqual({
      kind: "propose",
    });
  });

  it("invalidates a held binding and its approval, and leaves a released one alone", () => {
    expect(supersedeBinding({ ...call("awaiting_approval"), approvalId: "appr_1" })).toMatchObject({
      approval: { approvalId: "appr_1", status: "invalidated" },
      call: { status: "invalidated", settle: { behavior: "deny" } },
    });
    expect(supersedeBinding({ ...call("proposed"), approvalId: null })?.approval).toBeNull();
    expect(supersedeBinding({ ...call("dispatched"), approvalId: null })).toBeNull();
  });
});

describe("completion", () => {
  it("settles a released call with its result and never revives a terminal one", () => {
    expect(statusAfterResult("dispatched", false)).toBe("completed");
    expect(statusAfterResult("dispatched", true)).toBe("failed");
    expect(statusAfterResult("denied", false)).toBe("denied");
    expect(statusAfterResult("invalidated", false)).toBe("invalidated");
  });

  it("classifies a released call without a result as unknown and a held one as never run", () => {
    const calls = [call("dispatched", "a"), call("awaiting_approval", "b"), call("completed", "c")];
    expect(classifyActions(calls, true).map((action) => action.status)).toEqual([
      "unknown",
      "blocked_gate",
      "completed",
    ]);
    expect(classifyActions(calls, false).map((action) => action.status)).toEqual([
      "unknown",
      "invalidated",
      "completed",
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
