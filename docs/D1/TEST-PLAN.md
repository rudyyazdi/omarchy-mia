# D1 test plan

Proposed harness. Fixtures and Mia commands do not exist yet. Requirements: [plan](PLAN.md), [records](CONVERSATION-RECORDS.md). No real services or consequential effects.

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

| Case | Send / trigger | Required result |
| --- | --- | --- |
| Stream/context — L | `Remember marker K7. Explain approval in five sentences.` Then `What marker did I give you?` | Deltas arrive before completion; answer K7; same agent conversation. |
| Allowed — L | `Call d1.read once. Report the counter.` | One read; zero prompts. |
| Approve/reject — L | `Call d1.change with delta 1 exactly once. Do not retry a denial.` Approve; repeat and reject. | Zero commits while pending; one after approve; none after reject. |
| Every call — L | `Call d1.change with delta 1 twice, sequentially.` Approve first, reject second. | Two approval IDs; one commit. |
| Denied — L/H | `Call d1.forbidden once.` Also inject its proposal through adapter checks. | No execution. Hidden-tool refusal alone does not prove proposal enforcement. |
| Binding/dedup — H | Change pending delta 1→2 under the same runtime call ID; deliver old approval. Repeat a decision and `cmd-1`; alter client/task/call IDs and epoch independently. | Old/foreign approval invalid; changed call needs fresh approval; no duplicate task/effect. |
| Silence/disconnect — L/H | Request change; give no decision, then disconnect. | Pending record retained; zero commits. |
| Interrupt first — H | Hold before release; send interrupt, then approval. | Gate closes; approval stale; zero dispatches. |
| Release first — H | Release approved call; hold at `entered`; interrupt. | In-flight classification, not “never executed.” |
| Cancellable — L/H | `Call d1.slow with mode cancellable once, then d1.change with delta 1.` Approve slow; interrupt at `entered`. | Confirm cancellation; zero commits; no later consequential dispatch. |
| Uncancellable — L/H | Same prompt with mode `uncancellable`; interrupt at `entered`, then release worker. | One slow commit; report actual completion; no later change. |
| Allowed action while interrupted — L/H | Use second profile. Interrupt during `slow`; harness injects a subsequent `change` proposal after gate closure. Repeat live if the runtime proposes it. | No dispatch despite allow policy. No live proposal means live gate coverage remains unproven, not passed. |
| Unknown result — H | Commit slow action; drop result channel. | Unknown outcome after timeout; no retry or conflicting work. |
| Record failure — H | Fail approval transaction before release. | No dispatch; visible error. |
| Setup/protocol — H + probe | Independently omit runtime/auth, select unavailable model, reject effort/policy support, inject malformed events, crash runtime. Inject conflicting inherited effort. | Explicit failures; no fallback. Requested/effective identities and setting precedence recorded accurately. |
| Artifact/export — L/H | `Call d1.artifact with name result.txt and text D1.` Approve; export. | Retained bytes and provenance survive source edits; offline verification passes. Run the full [record checks](CONVERSATION-RECORDS.md#d1-verification-additions). |

For approval races, inject both orderings at controller barriers. For live cancellation, observe the independent fixture ledger. A substitute pass never establishes runtime support.

## Pass record

One row per parent D1 pass condition: case, L/H, runtime/model/build/protocol, conversation ID, event IDs, ledger, export, result/blocker. Run the plan's user demo. Any required capability gap blocks acceptance. Stop at the user checkpoint.
