import type { RuntimeEvent, PermissionDecision } from "@mia/agent-adapter";
import { describe, expect, it } from "vitest";
import type { FixtureState } from "@mia/controlled-mcp";
import {
  effortsOf,
  firstEvent,
  followupChecks,
  interruptCancellableChecks,
  rawRequestsOf,
  streamApproveChecks,
} from "./checks.ts";
import type { StepRecord } from "./record.ts";

const at = "2026-01-01T00:00:00.000Z";

const allow: PermissionDecision = { behavior: "allow" };

const ledger = (
  entries: Pick<FixtureState["ledger"][number], "kind" | "tool">[],
): FixtureState => ({
  counter: 0,
  pending: [],
  ledger: entries.map((entry, index) => ({
    ...entry,
    seq: index + 1,
    at,
    call_id: `call-${index}`,
  })),
});

const step = (overrides: Partial<StepRecord>): StepRecord => ({
  name: "step",
  session_id: "session",
  first_turn: true,
  prompt: "",
  events: [],
  permission_requests: [],
  turn: null,
  ledger_after: null,
  hook_evidence: null,
  hook_evidence_malformed_lines: null,
  hook_evidence_read_error: null,
  notes: [],
  checks: {},
  ...overrides,
});

describe("probe evidence readings", () => {
  it("reads the tool name and id the runtime sent, and nothing from a payload that is not an object", () => {
    const record = step({
      permission_requests: [
        {
          request: { tool_name: "mcp__d1__read", tool_use_id: "toolu_1", extra: 1 },
          decision: allow,
          abandoned: false,
        },
        { request: "not an object", decision: allow, abandoned: false },
      ],
    });
    expect(rawRequestsOf(record)).toEqual([
      { tool_name: "mcp__d1__read", tool_use_id: "toolu_1", extra: 1 },
      {},
    ]);
  });

  it("reads effort from the hook's object or string, else the environment it saw", () => {
    expect(
      effortsOf([
        { effort: { level: "high" } },
        { effort: "low" },
        { env_claude_effort: "medium" },
        { effort: 42 },
      ]),
    ).toEqual(["high", "low", "medium", undefined]);
  });

  it("finds the first event of a type in step order", () => {
    const delta = (text: string): RuntimeEvent => ({ type: "text_delta", text, at });
    const records = [
      step({ events: [{ type: "runtime_stderr", text: "warn", at }] }),
      step({ events: [delta("first")] }),
      step({ events: [delta("second")] }),
    ];
    expect(firstEvent(records, "text_delta")).toEqual(delta("first"));
    expect(firstEvent(records, "turn_result")).toBeUndefined();
  });

  it("orders streamed text before the result and counts exactly one commit", () => {
    const record = step({
      events: [
        { type: "text_delta", text: "hi", at },
        {
          type: "tool_proposed",
          runtimeCallId: "toolu_1",
          toolIdentity: "mcp__d1__read",
          arguments: {},
          complete: true,
          at,
        },
      ],
      permission_requests: [
        {
          request: { tool_name: "mcp__d1__read", tool_use_id: "toolu_1" },
          decision: allow,
          abandoned: false,
        },
      ],
      ledger_after: ledger([{ kind: "committed", tool: "change" }]),
    });
    expect(streamApproveChecks(record)).toMatchObject({
      read_routed_through_bridge: true,
      change_routed_through_bridge: false,
      tool_use_id_matches_streamed_tool_use: true,
      exactly_one_commit: true,
      effort_evidence: "no hook evidence captured",
      effort_flag_beats_settings_layer: false,
    });
  });

  it("wants two distinct change requests and a forbidden tool that neither reached the bridge nor ran", () => {
    const change = (id: string) => ({
      request: { tool_name: "mcp__d1__change", tool_use_id: id },
      decision: allow,
      abandoned: false,
    });
    const passing = followupChecks(
      step({ permission_requests: [change("a"), change("b")], ledger_after: ledger([]) }),
    );
    expect(passing).toMatchObject({
      two_distinct_change_requests: true,
      forbidden_never_reached_bridge: true,
      forbidden_never_executed: true,
    });
    const failing = followupChecks(
      step({
        permission_requests: [
          change("a"),
          change("a"),
          { ...change("c"), request: { tool_name: "mcp__d1__forbidden" } },
        ],
        ledger_after: ledger([{ kind: "committed", tool: "forbidden" }]),
      }),
    );
    expect(failing).toMatchObject({
      two_distinct_change_requests: false,
      forbidden_never_reached_bridge: false,
      forbidden_never_executed: false,
    });
  });

  it("sees a cancelled slow call with no commits after an interrupt", () => {
    expect(
      interruptCancellableChecks(
        step({ ledger_after: ledger([{ kind: "cancelled", tool: "slow" }]) }),
      ),
    ).toMatchObject({
      slow_cancelled_in_ledger: true,
      zero_commits: true,
      no_change_proposed_after_interrupt: true,
    });
  });
});
