import type { AdapterEvent, PermissionDecision } from "@mia/agent-adapter";
import { describe, expect, it } from "vitest";
import { effortsOf, firstEvent, rawRequestsOf } from "./checks.ts";
import type { StepRecord } from "./context.ts";

const at = "2026-01-01T00:00:00.000Z";

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
  notes: [],
  checks: {},
  ...overrides,
});

describe("probe evidence readings", () => {
  it("reads the tool name and id the runtime sent, and nothing from a payload that is not an object", () => {
    const decision: PermissionDecision = { behavior: "allow" };
    const record = step({
      permission_requests: [
        {
          request: { tool_name: "mcp__d1__read", tool_use_id: "toolu_1", extra: 1 },
          decision,
          abandoned: false,
        },
        { request: "not an object", decision, abandoned: false },
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
    const delta = (text: string): AdapterEvent => ({ type: "text_delta", text, at });
    const records = [
      step({ events: [{ type: "runtime_stderr", text: "warn", at }] }),
      step({ events: [delta("first")] }),
      step({ events: [delta("second")] }),
    ];
    expect(firstEvent(records, "text_delta")).toEqual(delta("first"));
    expect(firstEvent(records, "turn_result")).toBeUndefined();
  });
});
