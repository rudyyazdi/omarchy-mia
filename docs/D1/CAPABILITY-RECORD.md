# D1 capability record: Claude Code adapter

Status: **go**. Every behaviour the adapter relies on was demonstrated against the real installed runtime. One hazard was found and is mitigated in the adapter (see "Findings"). Evidence directories live under `.mia-state/probe/<utc-stamp>/` (private, outside Git); redacted protocol examples are frozen in [`protocol-examples/`](protocol-examples/).

## Pinned environment

| Item | Value | Evidence |
| --- | --- | --- |
| Runtime | Claude Code `2.1.274` (installed via mise, `claude` on PATH) | `static-capabilities.json`, `init.claude_code_version` |
| Structured interface | `claude -p` with `--output-format stream-json --verbose --include-partial-messages`; prompt on stdin; one process per turn; continuation with `--session-id` (first turn) / `--resume` (later turns) | `launch_description` in captured examples |
| Approval interface | `--permission-prompt-tool mcp__mia_approval__request`: an MCP server hosted in the Mia server process, called for every non-denied tool call | `permission_request_payload` |
| Permission rules | Mia-owned `--settings` layer: `permissions.deny` for policy `deny`; `permissions.ask` for every other configured tool so the bridge sees every call (an inherited `allow` cannot bypass it); `--permission-mode default`; `--strict-mcp-config`; `--tools ""` | `settings` in `launch_description`; runtime debug log lines "Applying permission update" |
| Model (test lane) | `claude-sonnet-5`, explicitly `--effort medium` | `init.model`, hook evidence |
| Model (production example) | `claude-opus-5`, `--effort medium` | **Not exercised live** in this record; the maintainer chose to test the harness on Sonnet only. `examples/config` marks Opus as unverified. |
| Credential source | Runtime reported `apiKeySource: none` (claude.ai login); nothing copied into Mia configuration or logs | `init.apiKeySource` |
| MCP SDK (Mia servers) | `@modelcontextprotocol/sdk` 1.30.0, Streamable HTTP, stateless mode, standalone GET stream refused (405) | `packages/mcp-http` |
| Node | 26.8.1 | `static-capabilities.json` |

## What was proven live (Sonnet, 12 turns)

| # | Behaviour | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Text streams before the turn result (`stream_event` / `text_delta` precede `result`) | pass | run `13-48-20`, step 1, `deltas_before_result: true` |
| 2 | The approval tool is called for a policy-`allow` tool without any client prompt, and for a policy-`ask` tool | pass | step 1, `read_routed_through_bridge`, `change_routed_through_bridge` |
| 3 | Every permission request carries `tool_use_id`, matching the `tool_use` block streamed earlier in the same turn | pass | step 1, `tool_use_id_matches_streamed_tool_use: true` |
| 4 | Approved call executes exactly once (fixture ledger, not model prose) | pass | step 1, `exactly_one_commit: true` |
| 5 | Explicit `--effort medium` wins over a conflicting `effortLevel: high` settings layer; control run without the flag shows `high` | pass | step 1 hook evidence `["medium","medium"]`; step 6 control `efforts: ["high"]` |
| 6 | Follow-up turn resumes the same runtime conversation (marker K7 recalled) | pass | run `13-48-20`, step 2, `marker_recalled: true` |
| 7 | Two identical sequential calls produce two distinct permission requests; denying the second leaves exactly one new commit; the runtime reports the denial in `result.permission_denials` with the tool_use_id | pass | step 2, `two_distinct_change_requests`, `commits_total_after_step: 2` |
| 8 | A `deny` rule hides the tool from the model (`init.tools` omits it); the model did not propose it | pass (hidden-tool refusal only; proposal enforcement is proven in the H lane by injecting a proposal through the bridge) | step 2 |
| 9 | If the approval tool is unreachable, the runtime fails closed: the tool call errors, nothing executes, the process exits non-zero | pass | run `13-46-52` (bridge misconfigured): ledger empty, exit 1 |
| 10 | Interruption while an action is in flight (cancellable): SIGKILL stops the runtime in ~17 ms, the fixture observes the dropped connection and cancels before commit, zero commits, no later proposal | pass | run `14-01-13`, `slow_cancelled_in_ledger`, `zero_commits`, one `tools/call` on the fixture |
| 11 | Interruption while an uncancellable action is in flight: killing the runtime does not stop the action; it commits when released | pass (honest outcome) | run `13-49-05`, `slow_committed_after_release: true`, `no_change_commit: true` |
| 12 | The conversation can be resumed after SIGKILL | pass, with limitation L1 | run `14-01-13`, step `resume-after-kill` |

## Findings

**F1: SIGTERM causes a duplicate tool dispatch (mitigated).** Observed on SIGTERM in runs `13-49-05`, `13-56-46` and `13-59-33`: the runtime logged "HTTP connection closed ... (cleanly)" and then "MCP session expired during tool call ... Retrying tool 'slow' after session recovery", and the fixture recorded two `entered` events for one approval. The SIGKILL run shows exactly one `tools/call`. Why that happens and what Mia does about it is documented where it is enforced, on `interrupt` in `packages/agent-adapter/src/adapter.ts`. The same retry can be triggered by any connection loss during a call, outside Mia's control; this is recorded as a runtime limitation for production MCP servers.

**F2: Standalone SSE stream refused.** Mia-owned MCP servers answer GET with 405 (permitted by the Streamable HTTP spec). The runtime accepted this in every subsequent run. It was introduced while diagnosing F1 and kept because it removes an idle connection with no function for these servers.

**F3: Permission tool contract (undocumented, frozen).** Request: `{ "tool_name": string, "input": object, "tool_use_id": string }`. Response: a single `text` content block whose text is JSON `{ "behavior": "allow", "updatedInput"?: object }` or `{ "behavior": "deny", "message": string }`. A malformed response is treated as deny by the runtime. Source: CLI bundle inspection plus live capture (`protocol-examples/captured-examples.json`). If a future runtime version changes this, the bridge's parser fails closed (deny) and the probe must be rerun.

**F4: Held-approval timeout.** The runtime's per-call MCP timeout applies to the permission tool call. Mia sets `MCP_TOOL_TIMEOUT=86400000` (24 h) for the spawned process so a pending human decision is not timed out by the runtime. Confirmed in the runtime debug log (`timeoutMs: 86400000`).

**F4 addendum (2.1.278, 2026-09-21).** Claude Code 2.1.278 adds a second, independent *idle* timeout: a tool call with "no response or progress for 300s" is aborted even when `MCP_TOOL_TIMEOUT` is 24 h (observed live: `MCP server "mia_approval" tool "request" sent no response or progress for 300s; aborting`). A held approval prompt is exactly such a call, so under 2.1.278 an undecided approval expired after 5 minutes (`approval_resolved: expired, runtime abandoned the prompt`; the call stayed `invalidated`, never released — the boundary held, the hold did not). Mia now also sets `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=86400000`. The runtime's error text for an aborted prompt reads as uncertainty to the model ("I don't know whether the increment happened"), so Mia now also tells the runtime the call never ran when it abandons a prompt, and prepends a note to the next turn correcting any such claim; `prompts/agent-v2.md` adds the matching rule. The probe has no step that holds an approval for over 5 minutes, so this class of regression is not caught by `npm run probe`.

## Limitations recorded

- **L1: runtime memory after a kill.** After SIGKILL the resumed session did not remember the interrupted turn's tool call ("I have no record of any tool calls in a previous turn"). Mia's records are authoritative; the server prefixes the next user turn with a Mia-authored interruption summary so the agent is not misled.
- **L2: hidden runtime internals.** The runtime's full system prompt and any inherited `CLAUDE.md` content are not exposed by the stream; only Mia's appended agent instructions are retained as a snapshot. Recorded as unavailable, not captured.
- **L3: effective-effort evidence** comes from a Mia-configured `PreToolUse` hook (`effort.level`, `CLAUDE_EFFORT`) and therefore exists only for turns that use a tool. The `init` message reports the model but not the effort.
- **L4: `--tools ""` scope.** The flag disables built-in tools; MCP tools remain (`init.tools` lists only `mcp__d1__*`). Gating coverage is proven for MCP tools only; `builtinTools` must stay empty in D1 profiles and the config validator enforces it.
- **L5: production model unverified.** `claude-opus-5` was not called in this record.

## Decision

Go for work items 2–6 with the adapter as specified above. Any change of runtime version invalidates rows 3, 7, 9, 10 and F1–F4 until the probe (`npm run probe`) is rerun.
