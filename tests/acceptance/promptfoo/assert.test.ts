import { describe, expect, it } from "vitest";
import assertScenario from "./assert.ts";
import type { ScenarioName } from "./scenarios.ts";

/** Provider output as JSON would carry it: deliberately untyped, so a test can send a shape the schema refuses. */
const evidenceFor = (
  scenario: ScenarioName,
  overrides: Record<string, unknown>,
): Record<string, unknown> => ({
  scenario,
  profile: "fixture-test",
  conversation_id: "conversation",
  task_ids: ["task"],
  decisions: [],
  ledger_after: { counter: 0, commits: [], returned: [], entered: [], kinds: {} },
  events: [],
  transcript: [],
  notes: [],
  final_status: ["failed"],
  live: true,
  ...overrides,
});

const judge = (scenario: ScenarioName, evidence: Record<string, unknown>) =>
  assertScenario(JSON.stringify(evidence), { vars: { scenario } });

const reconnectDecision = {
  approval_id: "approval",
  tool: "mcp__d1__change",
  decision: "reject",
  ledger_commits_at_request: 0,
};

describe("scenario assertion", () => {
  it("passes silence-disconnect only when the reject after reconnect was accepted", () => {
    const decided = (ack: Record<string, unknown>) =>
      evidenceFor("silence-disconnect", {
        decisions: [{ ...reconnectDecision, ack: { ...ack, disposition: "accepted" } }],
      });
    expect(judge("silence-disconnect", decided({ after_reconnect: true })).pass).toBe(true);
    expect(judge("silence-disconnect", decided({ after_reconnect: false })).pass).toBe(false);
    const refused = evidenceFor("silence-disconnect", {
      decisions: [
        {
          ...reconnectDecision,
          ack: { disposition: "rejected", code: "invalid_state", after_reconnect: true },
        },
      ],
    });
    expect(judge("silence-disconnect", refused)).toMatchObject({
      pass: false,
      reason: "pending approval was not retained/decidable after reconnect",
    });
  });

  it("refuses a decision or ack outside the declared vocabularies", () => {
    const refusedShapes = [
      { ...reconnectDecision, decision: "reject-after-reconnect:accepted" },
      { ...reconnectDecision, ack: { disposition: "acepted", after_reconnect: true } },
      { ...reconnectDecision, ack: { disposition: "rejected", after_reconnect: true } },
      {
        ...reconnectDecision,
        ack: { disposition: "rejected", code: "no_such_code", after_reconnect: true },
      },
    ];
    for (const decision of refusedShapes)
      expect(
        judge("silence-disconnect", evidenceFor("silence-disconnect", { decisions: [decision] }))
          .reason,
      ).toMatch(/^provider output does not match the evidence shape/);
  });

  it("reads ledger kinds by their declared names and refuses an undeclared one", () => {
    const ledger = (kinds: Record<string, number>) =>
      evidenceFor("cancellable", {
        ledger_after: {
          counter: 0,
          commits: [],
          returned: [],
          entered: [{ tool: "slow", call_id: "call" }],
          kinds,
        },
        events: [{ type: "interruption_outcome", sequence: 1, payload: {} }],
        final_status: ["interrupted"],
      });
    expect(judge("cancellable", ledger({ entered: 1, cancelled: 1 })).pass).toBe(true);
    expect(judge("cancellable", ledger({ entered: 1 })).reason).toBe(
      "slow action was not cancelled in the ledger",
    );
    expect(judge("cancellable", ledger({ entered: 1, canceled: 1 })).reason).toMatch(
      /^provider output does not match the evidence shape/,
    );
  });
});
