# D1 test plan

Implemented: fixture in `fixtures/controlled-mcp`, H lane in `tests/acceptance/src`, live lane in `tests/acceptance/promptfoo` (`npm run live`). Deviations are noted inline. Requirements: [plan](PLAN.md), [records](CONVERSATION-RECORDS.md). No real services or consequential effects.

## Setup

1. Use installed Claude Code and existing authentication. Record version; pin the exact Opus identifier. Use the effort setting in the plan.
2. Create a private disposable working/state directory. Start the server, client, fixture, and approval bridge. Fresh conversation and ledger per case unless testing follow-up/reuse.
3. Fixture exposes only the tools below. Effects stay in its directory. Ledger records `entered`, `committed`, `cancelled`, and `returned`, with call IDs and arguments. Count commits, not model claims.
4. Harness controls barriers through a private channel unavailable to the agent. No sleeps. The uncancellable worker survives runtime disconnection until the harness releases it.

| Fixture tool | Input | Behavior |
| --- | --- | --- |
| `read` | `{}` | Return counter. No approval. |
| `change` | `{"delta":1}` | Increment counter once when authorized. |
| `slow` | `{"mode":"cancellable"}` or `{"mode":"uncancellable"}` | Signal `entered`; wait at barrier; increment once on release. Cancellable mode stops before commit when cancellation is confirmed. |
| `artifact` | `{"name":"result.txt","text":"D1"}` | Write/register immutable output after approval. Reject paths outside fixture directory. |
| `forbidden` | `{}` | Must never execute. |

## MCP selection and permissions

Harness writes `mcp.json`; replace endpoint placeholders with its loopback addresses:

```json
{"mcpServers":{
  "d1":{"type":"http","url":"http://127.0.0.1:<fixture-port>/mcp"},
  "mia_approval":{"type":"http","url":"http://127.0.0.1:<bridge-port>/mcp"}
}}
```

Harness writes `settings.json`:

```json
{"permissions":{
  "allow":["mcp__d1__read"],
  "ask":["mcp__d1__change","mcp__d1__slow","mcp__d1__artifact"],
  "deny":["mcp__d1__forbidden"]
}}
```

Allow skips prompts. Ask requires confirmation per call. Deny wins over ask; ask wins over allow. Do not use a server-wide allow rule for the approval fixtures. [Permission rules](https://code.claude.com/docs/en/permissions).

> **Implementation deviation.** Mia writes this settings layer itself from the profile's `toolPolicy`: `deny` becomes a runtime `deny` rule; every other tool becomes a runtime `ask` rule so the approval bridge sees each call, and Mia's `allow` policy is applied *at the bridge* without a client prompt. A runtime `allow` rule would bypass the bridge and make the tool ungateable during interruption. Mia interrupts with SIGKILL, not SIGTERM, because of finding F1 in the capability record.

For interruption coverage, use a second profile: move `mcp__d1__change` from `ask` to `allow`; leave `slow` approval-controlled. This proves gating independently of approval prompts.

Candidate probe invocation, launched by the adapter in the disposable directory:

```sh
claude -p --model "$MIA_OPUS_MODEL" --effort medium \
  --input-format stream-json --output-format stream-json \
  --verbose --include-partial-messages \
  --strict-mcp-config --mcp-config ./mcp.json \
  --settings ./settings.json --permission-mode default --tools '' \
  --permission-prompt-tool mcp__mia_approval__request
```

`--strict-mcp-config` selects MCP servers; `--tools ''` disables built-in tools. Neither is the no-prompt allowlist. `--permission-prompt-tool` routes noninteractive permission requests to an MCP tool. [CLI reference](https://code.claude.com/docs/en/cli-reference).

The bridge holds a runtime request until Mia records the authenticated user's exact-call decision. It cannot accept model-authored approval or persist blanket permission. Require correlation of each permission request/response to the held runtime call and exact argument revision, including repeated identical proposals. Tool name plus arguments is insufficient. Probe that correlation, request/response schema and cancellation support; freeze captured protocol examples before implementation. If this interface cannot enforce D1, stop and document the blocker. Do not fabricate a working approval protocol.

Inspect effective tools/settings before each live run; unexpected consequential tools, inherited hooks or conflicting managed permissions block this fixture profile. Do not edit personal Claude configuration or bypass permissions. This controlled profile does not prove general isolation or gating coverage for additional production tools. Production retains existing permissions subject to explicit Mia policy.

## What we send

Client → server, after conversation creation; substitute server-issued IDs. Resends reuse the same `message_id`:

```json
{"protocol_version":1,"message_id":"cmd-1","client_id":"client-1","type":"submit_text","payload":{"conversation_id":"conv-1","text":"Call d1.read once. Report the counter."}}
{"protocol_version":1,"message_id":"cmd-2","client_id":"client-1","type":"approval_decision","payload":{"conversation_id":"conv-1","task_id":"task-1","approval_id":"approval-1","decision":"approve"}}
{"protocol_version":1,"message_id":"cmd-3","client_id":"client-1","type":"interrupt_task","payload":{"conversation_id":"conv-1","task_id":"task-1"}}
```

Reject uses `"decision":"reject"`. These are proposed Mia payloads, not Claude protocol messages. The probe records the supported Claude input envelope carrying the exact task text, retained agent instructions, and conversation continuation identifier. Client IDs alone never authenticate a command.

## Scenarios

`L` = live runtime. `H` = deterministic harness/substitute. Keep evidence labels separate. If Claude ignores a requested tool call, the scenario was not exercised; a prose answer is not a pass.

Each case's prompt, trigger and required result belong to the lane that runs it, where they cannot drift from what is actually exercised: the live cases are the named scenarios in [`scenarios.ts`](../../tests/acceptance/promptfoo/scenarios.ts), judged from ledger and event evidence by [`assert.ts`](../../tests/acceptance/promptfoo/assert.ts); the H cases are the named tests in [`tests/acceptance/src`](../../tests/acceptance/src). Which test evidenced which case is in the [acceptance record](ACCEPTANCE-RECORD.md#test-plan-scenarios).

| Case | Lane | Where it runs |
| --- | --- | --- |
| Stream/context | L | `stream-context` |
| Allowed | L | `allowed` |
| Approve/reject | L | `approve-reject` |
| Every call | L | `every-call` |
| Denied | L/H | `denied`; `engine.test.ts` "approval path" |
| Binding/dedup | H | `engine.test.ts` "streaming and commands", "approval path" |
| Silence/disconnect | L/H | `silence-disconnect`; `engine.test.ts` "approval path" |
| Interrupt first | H | `engine.test.ts` "interruption path" |
| Release first | H | `engine.test.ts` "interruption path" |
| Cancellable | L/H | `cancellable`; `adapter-e2e.test.ts`, `fixture.test.ts` |
| Uncancellable | L/H | `uncancellable`; `engine.test.ts` "interruption path", `fixture.test.ts` |
| Allowed action while interrupted | L/H | `allow-policy-no-prompt`; `engine.test.ts` "interruption path" |
| Unknown result | H | `engine.test.ts` "interruption path" |
| Record failure | H | `engine.test.ts` "approval path" |
| Setup/protocol | H + probe | `engine.test.ts` "streaming and commands", "configuration and provenance"; `adapter-e2e.test.ts`; `npm run probe` |
| Artifact/export | L/H | `artifact-export`; `records.test.ts`; the full [record checks](CONVERSATION-RECORDS.md#d1-verification-additions) |

Lane rules, which no test can state for itself:

- Hidden-tool refusal alone does not prove proposal enforcement; inject the proposal through the adapter checks as well.
- For approval races, inject both orderings at controller barriers. For live cancellation, observe the independent fixture ledger.
- A substitute pass never establishes runtime support, and an absent live proposal after gate closure leaves live gate coverage unproven, not passed.

## Pass record

One row per parent D1 pass condition: case, L/H, runtime/model/build/protocol, conversation ID, event IDs, ledger, export, result/blocker. Run the plan's user demo. Any required capability gap blocks acceptance. Stop at the user checkpoint.
