# D1 acceptance record

Status: implementation complete; **awaiting the maintainer's live user acceptance checkpoint**. Each row names the D1
requirement, the evidence, and whether it was demonstrated live (**L**, real Claude Code on `claude-sonnet-5`), verified
with a substitute (**H**, scripted runtime or fake runtime process), or is **blocked**/limited. Substitute evidence is
never labelled a live pass.

Versions: Claude Code `2.1.274`; model `claude-sonnet-5` requested and reported; effort `medium` requested explicitly and
reported by the PreToolUse hook on every turn that used a tool; protocol version 1; adapter `0.1.0`; Node 26.8.1. Build
identities and prompt digests are in each conversation's provenance (see the live-results table's conversation ids and
`mia debug conversation <id>`). The generated live rows are in [`acceptance/live-results-agent-v1.md`](acceptance/live-results-agent-v1.md);
the offline suite is `npm test` (37 tests) and the capability probe is documented in [`CAPABILITY-RECORD.md`](CAPABILITY-RECORD.md).

Live lane summary: 10 scenarios × 2 repeats = **20/20 rows passed** on `claude-sonnet-5` (`agent-v1`), including export plus
offline verification of both `artifact-export` conversations (complete, 12 artifacts, 12 objects each). The whole D1 effort
used 42 live turns (12 probe, 30 acceptance and harness debugging), all on Sonnet.

## Parent D1 pass conditions

| Pass condition (docs/PLAN.md) | Lane | Evidence | Result |
| --- | --- | --- | --- |
| No execution before required approval | L + H | live `approve-reject`; H "holds a call until approval, releases exactly once" (decision persisted before `tool_dispatched`, checked by event order) | pass |
| New consequential actions are blocked during interruption | H (gate) + L (no proposal) | H "blocks a policy-allowed action proposed after the gate closed" (`blocked_gate`); live `cancellable`. A live proposal after gate closure never occurred because interruption is SIGKILL, so live gate coverage rests on the H lane and the SIGKILL evidence in the capability record (F1) | pass (H) / live gate coverage unproven by construction |
| In-flight actions that cannot stop are reported honestly | L + H | live `uncancellable`, whose ledger shows the commit happened after release; H "release before interruption" | pass |
| Failures are visible | L + H | unreachable approval tool → runtime failed closed with visible error (probe run `13-46-52`); H: malformed events → `error` event; unlisted tool → `configuration_error`; runtime crash → `task_finished` with error and `outcome_unknown` for released calls | pass |
| Unsupported approval policies are not silently weakened | H | `validateRuntimeConfig` rejects `builtinTools`, unknown servers in `toolPolicy`, credential-like env; unresolved `${VAR}` placeholders fail profile load; unlisted tools are denied at the bridge with an error event | pass |
| Logs identify the actual agent, prompts and builds | L | every conversation snapshots agent prompt (digest), redacted configuration, tool contracts, model selection, runtime identity (`2.1.274`), architecture revision, server build (commit + dirty diff snapshot), client build; executions record requested vs reported model/effort with hook evidence | pass |
| Retained snapshots survive later edits | H | "retains immutable provenance snapshots that survive later edits"; records test edits the prompt and the generated file after export and re-verifies | pass |
| Controlled fixtures for consequential tests | L + H | `fixtures/controlled-mcp` with append-only ledger, barriers, cancellable/uncancellable actions; effects confined to its directory | pass |

## Test-plan scenarios

| Case (docs/D1/TEST-PLAN.md) | Lane | Evidence | Result |
| --- | --- | --- | --- |
| Stream/context | L | `stream-context` rows | pass (2/2 repeats) |
| Allowed | L | `allowed` rows | pass (2/2 repeats) |
| Approve/reject | L | `approve-reject` rows | pass (2/2 repeats) |
| Every call | L | `every-call` rows | pass (2/2 repeats) |
| Denied | L + H | live `denied` (`init.tools` omitted the tool, so it was never proposed); H "denies unlisted tools, policy-denied proposals…" injects a forbidden proposal through the bridge | pass |
| Binding/dedup | H | "invalidates an approval when arguments change…", "rejects decisions with wrong task, wrong client, or foreign ids", command-id dedup and conflict | pass |
| Silence/disconnect | L + H | live `silence-disconnect`; H "treats disconnection as no decision" | pass (2/2 repeats) / pass |
| Interrupt first | H | "interrupt before release: gate closes, approval is stale, nothing dispatches" | pass |
| Release first | H | "release before interruption: …unknown outcome, and the next turn carries a note" | pass |
| Cancellable | L + H | live `cancellable`; fake-runtime e2e "SIGKILL interruption…" | pass (2/2 repeats) / pass |
| Uncancellable | L | live `uncancellable` | pass (2/2 repeats) |
| Allowed action while interrupted | H (+ L partial) | H gate test; live `allow-policy-no-prompt` proves the policy-allow path on profile 2 without interruption. No live proposal after gate closure occurred (SIGKILL), so this remains H-proven only | pass (H); live unproven |
| Unknown result | H | "reports unknown when a released call never returns a result" | pass |
| Record failure | H | "keeps the call held when the decision cannot be persisted" | pass |
| Setup/protocol | H + probe | static probe (missing runtime/credential/flags), unsupported protocol version, invalid JSON, oversized text, busy; effort precedence and control run in the capability record | pass |
| Artifact/export | L + H | live `artifact-export` rows include export + offline verification by the runner; records tests cover consistent snapshot, shared prompt bytes, missing/corrupt objects, orphan reconciliation, tamper detection, HTML escaping, seeded-credential absence | pass (2/2 repeats) / pass |

## Known limitations carried forward

- Live gate coverage after interruption is unproven by construction (SIGKILL leaves no runtime to propose anything); the gate is enforced in the controller and proven by the H lane.
- The runtime may re-send an in-flight MCP call after any connection loss during that call, bypassing the permission tool (capability record F1). Mia avoids the SIGTERM trigger; other triggers are outside Mia's control and are recorded as a runtime limitation for production MCP servers.
- The production model pin (`claude-opus-5`) is unverified in this record.
- After an interruption the runtime's own memory of the killed turn is incomplete; Mia's records are authoritative and the next turn carries a Mia-authored note (limitation L1). The harness does not change the configured policy after an unknown outcome (an earlier build escalated `allow` to `ask` for that tool; removed 2026-09-21 as unnecessary friction — `allow` is already the user's judgement that unprompted repeats are acceptable, and consequential tools are `ask` regardless). Avoiding a duplicate effect after an interruption rests on the model reading that note.
- Two independent Codex review passes (`gpt-6-astra`) were run over the tree; their confirmed findings were fixed and the remaining ones are recorded above.
- Diagnostics are text-client only (voice/display explicitly `not_applicable`).
