import { describe, expect, it } from "vitest";
import {
  callsOf,
  otherPending,
  pendingCall,
  withCall,
  withPending,
  withRevision,
  withTask,
  withoutPending,
  type CallState,
  type ConversationState,
  type TaskState,
} from "./conversation-state.ts";

const call = (id: string, runtimeCallId: string, revision = 1): CallState => ({
  id,
  runtimeCallId,
  revision,
  toolIdentity: "mcp__fixture__change",
  digest: `digest-${id}`,
  redactedArguments: {},
  policy: "ask",
  status: "proposed",
  approvalId: null,
});

const task = (calls: CallState[] = []): TaskState =>
  calls.reduce(withRevision, {
    id: "task-1",
    executionId: "exec-1",
    epoch: 1,
    status: "running",
    gateOpen: true,
    interrupted: false,
    runtimeEnded: false,
    calls: new Map(),
    pendingApprovals: new Map(),
    abandoned: [],
    clientId: "client-A",
    reportedModel: null,
  });

const conversation = (current: TaskState | null): ConversationState => ({
  id: "conv-1",
  runtimeConversationId: "runtime-conv-1",
  provenanceSetId: "prov-1",
  directory: "/tmp/conv-1",
  promptFile: null,
  turnCount: 1,
  sessionStarted: false,
  epoch: 1,
  pendingNote: null,
  task: current,
});

describe("conversation state", () => {
  it("keeps revisions under their runtime call id, in the order the ids were first seen", () => {
    const state = task([call("call-a1", "a"), call("call-b1", "b"), call("call-a2", "a", 2)]);
    expect([...state.calls.keys()]).toEqual(["a", "b"]);
    expect(callsOf(state).map(({ id }) => id)).toEqual(["call-a1", "call-a2", "call-b1"]);
  });

  it("changes only the named revision, and leaves the value it started from as it was", () => {
    const before = task([call("call-a1", "a"), call("call-a2", "a", 2)]);
    const after = withCall(before, "call-a1", { status: "invalidated" });
    expect(callsOf(after).map(({ id, status }) => [id, status])).toEqual([
      ["call-a1", "invalidated"],
      ["call-a2", "proposed"],
    ]);
    expect(callsOf(before).map(({ status }) => status)).toEqual(["proposed", "proposed"]);
  });

  it("refuses to change a call or task it does not hold", () => {
    expect(() => withCall(task(), "call-missing", { status: "denied" })).toThrow(
      "call call-missing is not a call of task task-1",
    );
    expect(() => withTask(conversation(null), "task-1", (current) => current)).toThrow(
      "task task-1 is not the conversation's task",
    );
    expect(() => withTask(conversation(task()), "task-2", (current) => current)).toThrow(
      "task task-2 is not the conversation's task",
    );
  });

  it("resolves a pending approval to its call as the task holds it now", () => {
    const asked = withPending(
      withCall(task([call("call-a1", "a")]), "call-a1", {
        status: "awaiting_approval",
        approvalId: "appr-1",
      }),
      "appr-1",
      "call-a1",
    );
    expect(pendingCall(asked, "appr-1")?.status).toBe("awaiting_approval");
    const moved = withCall(asked, "call-a1", { status: "dispatched" });
    expect(pendingCall(moved, "appr-1")?.status).toBe("dispatched");
    expect(pendingCall(withoutPending(moved, "appr-1"), "appr-1")).toBeUndefined();
    expect(pendingCall(asked, "appr-unknown")).toBeUndefined();
  });

  it("keeps pending approvals in the order they were requested, and counts the others", () => {
    const base = task([call("call-a1", "a"), call("call-b1", "b")]);
    const pending = withPending(withPending(base, "appr-b", "call-b1"), "appr-a", "call-a1");
    expect([...pending.pendingApprovals.keys()]).toEqual(["appr-b", "appr-a"]);
    expect(otherPending(pending, "appr-b")).toBe(1);
    expect(otherPending(pending, "appr-unknown")).toBe(2);
    expect(otherPending(pending, null)).toBe(2);
    const resolved = withoutPending(pending, "appr-b");
    expect([...resolved.pendingApprovals.keys()]).toEqual(["appr-a"]);
    expect([...pending.pendingApprovals.keys()]).toEqual(["appr-b", "appr-a"]);
  });
});
