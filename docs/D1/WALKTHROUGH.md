# Reading and hand-testing the D1 code

A guided tour for one person with three terminals. Every step names the code it exercises so you can read
the file right after watching it behave. No automated tests are involved; every live step costs Claude turns
on your account (noted as "live").

## 1. The mental model (five moving parts)

```
 you ──▶ text client ──WebSocket──▶ Mia server ──spawns per turn──▶ claude (CLI, stream-json on stdout)
             ▲                        │  ▲                                  │
             │                        │  └── approval bridge (MCP over HTTP, ◀── asks "may I run this tool?"
             └── events, approvals ───┘      inside the server process)     │
                                      │                                     ▼
                                   SQLite catalog + object store        fixture MCP server (read/change/slow/…)
                                   ($stateDirectory)                    with an append-only ledger you can inspect
```

Rules that everything else hangs off:

1. Claude Code never runs a tool without asking the bridge first (`--permission-prompt-tool`), except tools the
   profile marks `deny`, which it never even sees. The bridge is Mia; Mia decides.
2. Nothing is told to the client, and no held tool call is released, before its record is committed to SQLite.
3. Interruption = close the gate, invalidate pending approvals, then SIGKILL the runtime. What already left is
   reported as `unknown`, never as "stopped".

## 2. Reading order

| Step | File | What to notice |
| --- | --- | --- |
| 1 | `packages/protocol/src/messages.ts` | The whole client/server vocabulary: 6 commands, 11 events. Everything else exists to produce or consume these. |
| 2 | `packages/agent-adapter/src/launch.ts` | `prepareLaunch` builds the exact `claude` command line, the settings layer (`deny` rules, `ask` for everything else) and the MCP config that adds the bridge. |
| 3 | `packages/agent-adapter/src/bridge.ts` | ~100 lines. One MCP tool, `request`, that awaits a handler. No handler ⇒ deny. |
| 4 | `packages/agent-adapter/src/adapter.ts` | `submitTurn`: spawn, parse stdout lines into `AdapterEvent`s, kill on `interrupt()`. |
| 5 | `apps/server/src/engine.ts` | Read top to bottom: `tx`/`emit`/`record` plumbing, then the six commands, then `onAdapterEvent`, `handlePermission`, `finishTurn`. |
| 6 | `packages/records/src/schema.ts` and `writer.ts` | Tables and the only code that writes them. |
| 7 | `packages/records/src/export.ts` | Snapshot → files → manifest → verify → rename. |
| 8 | `fixtures/controlled-mcp/src/fixture.ts` | The test double you will poke by hand below. |

Skip on a first read: `provenance.ts` (a list of snapshots), `report.ts` (HTML), `gateway.ts` (validation and
plumbing), `tests/`.

## 3. Hands-on, offline first (no Claude turns)

### 3.1 The fixture and its ledger

Terminal A:

```sh
npm run fixture -- --dir /tmp/mia-play --mcp-port 47331 --harness-port 47332
```

Terminal B, the private harness API (`fixture.ts`, "harnessServer"):

```sh
curl -s localhost:47332/state | jq          # counter 0, empty ledger
```

Call a tool the way Claude Code would, over MCP Streamable HTTP. Define a helper once (the transport insists on
both media types in `Accept`, with a space):

```sh
mcp() { curl -s -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' localhost:47331/mcp -d "$1"; echo; }
mcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"me","version":"0"}}}'
mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | grep -o '"name":"[a-z]*"'
mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"change","arguments":{"delta":1}}}'
curl -s localhost:47332/state | jq '.counter, [.ledger[].kind]'   # 1, ["entered","committed","returned"]
cat /tmp/mia-play/ledger.jsonl
```

Now the barrier. Start a slow call and leave it hanging:

```sh
mcp '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"slow","arguments":{"mode":"uncancellable"}}}' &
sleep 1; curl -s localhost:47332/state | jq '.pending'          # one entered, unreleased call
kill %1                                                         # drop the connection: uncancellable ignores it
curl -s localhost:47332/state | jq '.pending | length'          # still 1
curl -s -XPOST localhost:47332/release; curl -s localhost:47332/state | jq '.counter'   # commits: 2
```

Repeat with `"mode":"cancellable"` and kill the curl: the ledger gets `cancelled`, the counter does not move.
That is the whole trick the interruption tests rely on (`fixture.ts`, the `slow` tool handler: `extra.signal` and
`ctx.connectionClosed`).

### 3.2 The approval bridge on its own

The bridge only exists inside a server, so start one against the fixture (Terminal C):

```sh
MIA_FIXTURE_MCP_URL=http://127.0.0.1:47331/mcp MIA_FIXTURE_DIR=/tmp/mia-play \
  npm run server -- --config examples/config/fixture-test.json
```

Its log prints `listening on ws://127.0.0.1:48731`. The bridge port is not printed; read it from the launch
description after the first turn (`mia debug conversation`, event `runtime_started` → `launch.mcp_config`).
The point to remember from `bridge.ts`: with no active task the handler is `null`, so any call returns
`{"behavior":"deny"}`. You will see this indirectly in 4.3.

### 3.3 The gateway's front door

```sh
curl -si -H 'connection: upgrade' -H 'upgrade: websocket' -H 'sec-websocket-version: 13' \
  -H 'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==' http://127.0.0.1:48731/ | head -1   # 401: no bearer secret
cat .mia-state/fixture-test/client-secret                                             # the secret it wanted
```

`gateway.ts` → `authenticate`. The secret file is created by the server with mode 0600.

## 4. Hands-on with the real runtime (live)

Keep A (fixture) and C (server) running. Terminal B:

```sh
npm run client -- --config examples/config/fixture-test.json
```

Each step below drives one live-lane scenario by hand. Type the prompt the named scenario submits
([`scenarios.ts`](../../tests/acceptance/promptfoo/scenarios.ts)); what the run must produce is what that scenario's
assertion already checks ([`assert.ts`](../../tests/acceptance/promptfoo/assert.ts)), so this tour only shows where to
look. `npm run live` runs the same four unattended.

### 4.1 One streamed turn (1 live turn)

Prompt: the `stream-context` scenario's first turn.

In the code: `engine.submitText` → `adapter.submitTurn` → `onAdapterEvent("text_delta")` → `emit("text_delta")`. Now
look at what was recorded:

```sh
sqlite3 .mia-state/fixture-test/catalog.sqlite \
  "select sequence, type, substr(payload,1,60) from events order by sequence"
ls .mia-state/fixture-test/conversations/*/runtime/          # mcp.json, settings.json, turn-001.stream.jsonl
jq . .mia-state/fixture-test/conversations/*/runtime/settings.json   # the deny/ask rules Mia wrote
```

`turn-001.stream.jsonl` is the raw (redacted) stream-json the CLI produced; compare it with `stream.ts`.

### 4.2 An approval, held then released (1 live turn)

Prompt: the `approve-reject` scenario's.

Before answering the approval panel, and again after `/approve <id>`, read the two independent records:

```sh
curl -s localhost:47332/state | jq '[.ledger[].kind]'
sqlite3 .mia-state/fixture-test/catalog.sqlite "select status from approvals"
```

In `engine.approvalDecision` the transaction records `approval_resolved` then `tool_dispatched`, and only after commit
calls `settle(call, allow)`, which resolves the promise the bridge is awaiting. Check the order:

```sh
sqlite3 .mia-state/fixture-test/catalog.sqlite \
  "select sequence, type from events where type in ('approval_requested','approval_resolved','tool_dispatched','tool_result') order by sequence"
```

Try `/approve <same id>` again: `invalid_state`, because an approval authorises exactly one call once.

### 4.3 Interruption (1 live turn)

Prompt: the `cancellable` scenario's. Approve `slow`. When `curl -s localhost:47332/state | jq .pending` shows the
entered call, type `/interrupt`.

Code path: `engine.interruptTask` (gate closed + epoch advanced + pending invalidated, in one transaction) →
`adapter.interrupt` (SIGKILL of the process group). Mia's own classification of the released call comes from
`classifyActions`, and the fixture's `cancelled` entry is independent evidence. Then ask a follow-up, e.g.
`What happened?`: the runtime's prompt now starts with a Mia note; see it with

```sh
sqlite3 .mia-state/fixture-test/catalog.sqlite "select payload from events where type='task_submitted' order by sequence desc limit 1" | jq -r .runtime_prompt
```

Repeat with the `uncancellable` scenario's prompt, interrupt at `entered`, then
`curl -s -XPOST localhost:47332/release`. The next turn's prompt carries a Mia note listing the unknown outcome (see
the `runtime_prompt` query above); the configured policy for `d1.slow` is unchanged.

### 4.4 Denied tool and unlisted tool (1 live turn)

Prompt: the `denied` scenario's. The model does not see the tool at all; check `settings.json`
(`permissions.deny`) and the `runtime_init` event's `tools` list:

```sh
sqlite3 .mia-state/fixture-test/catalog.sqlite "select payload from events where type='runtime_init'" | jq .tools
```

## 5. The record, offline again

```sh
npm run mia -- debug conversations --state .mia-state/fixture-test
npm run mia -- debug conversation <id> --state .mia-state/fixture-test        # transcript, tools, approvals, provenance
npm run mia -- debug artifacts <id> --state .mia-state/fixture-test
npm run mia -- debug export <id> --output /tmp/mia-export --state .mia-state/fixture-test
npm run mia -- debug verify /tmp/mia-export
xdg-open /tmp/mia-export/report.html
```

Now tamper and re-verify: `echo x >> /tmp/mia-export/events.jsonl; npm run mia -- debug verify /tmp/mia-export`
(checksum mismatch). Edit `prompts/agent-v1.md`, re-run `debug conversation`: the `agent_prompt` provenance
digest is unchanged, because `provenance.ts` stored bytes, not a path, and `engine.startConversation` copied the
prompt into the conversation directory for later turns.

Where the bytes live:

```sh
ls .mia-state/fixture-test/objects/sha256/*/ | head        # content-addressed, mode 0400
sqlite3 .mia-state/fixture-test/catalog.sqlite "select role, availability, version from provenance_entries"
```

## 6. Things worth breaking on purpose

| Do | Expect | Code |
| --- | --- | --- |
| Put `"builtinTools": ["Bash"]` in a profile | server refuses to start with the reason | `config.ts` → `validateRuntimeConfig` |
| Add a tool to `mcpServers` but not to `toolPolicy`, then ask for it | bridge denies, client gets `configuration_error` | `handlePermission`, `policy === "unlisted"` |
| Kill the server while an approval is pending | runtime's held call times out or aborts; nothing committed | bridge handler abandoned → `abandon()` |
| Close the client while an approval is pending, reopen it | approval still pending and decidable | `onDisconnect`, `adoptConnection` |
| Run a second client while a task runs | `busy` | `guard()` |
| Send `protocol_version: 2` (node one-liner with `ws`) | `unsupported_protocol_version` with an actionable message | `gateway.ts` |

## 7. If a Claude Code upgrade changes behaviour

Run `npm run probe` (about 7 live turns). It re-checks the permission payload shape, streaming, resume, effort
precedence and the SIGTERM/SIGKILL behaviour, and rewrites `docs/D1/protocol-examples/`. Compare against
`CAPABILITY-RECORD.md`.
