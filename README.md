# Mia

Mia is an open-source voice assistant for an Omarchy host. This repository currently implements **Deliverable 1 (D1)**: a
text client, a persistent server, and one agent adapter (Claude Code) with enforced per-call tool approval, interruption
with honest outcomes, and a private, exportable conversation record. Voice, visuals, phone clients and later deliverables
are described in [`docs/PLAN.md`](docs/PLAN.md) and are not implemented yet.

Read first: [D1 plan](docs/D1/PLAN.md), [capability record](docs/D1/CAPABILITY-RECORD.md), [acceptance record](docs/D1/ACCEPTANCE-RECORD.md).

## Prerequisites

| Requirement                                                                                                | Why                                                                                                 | How Mia checks it                                 |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Node.js 26 (`.node-version`)                                                                               | runtime for server, client, tests; built-in `node:sqlite`                                           | `npm install` refuses older engines               |
| Claude Code CLI on `PATH`, logged in (`claude` 2.1.274 is the version the capability record was made with) | the only agent runtime supported in D1; Mia reuses your existing login and never copies credentials | `npm run probe` (static checks, then live checks) |
| A configured profile (see `examples/config`)                                                               | Mia has no defaults: model, effort, MCP servers, per-tool policy and tool surface are all explicit  | the server refuses to start on an invalid profile |

Nothing personal is committed: state lives under `$XDG_STATE_HOME/mia` (or a directory you name in the profile), the
client secret is generated there with mode 0600, and example profiles use `${ENV}` placeholders. A placeholder is
substituted only inside a string value, and the client loads the profile as the server does, so both need it set.

## Install

```sh
npm install
npm run typecheck
npm test            # deterministic lane: fixture, bridge, records, engine (scripted runtime), fake-runtime end-to-end
```

## Configure

Copy `examples/config/production-opus.example.json`, edit it, and keep it outside Git (or under `config/*.local.json`,
which is ignored). Every profile states:

- `runtime.model` / `runtime.effort`: passed explicitly on every invocation (`--model`, `--effort`). The Opus example is
  marked **unverified** because the D1 record was produced on `claude-sonnet-5`; run the probe with `--model claude-opus-5`
  before relying on it.
- `runtime.mcpServers`: the MCP servers the agent may use. `mia_approval` is reserved for the approval bridge.
- `runtime.toolPolicy`: one entry per tool, `allow` (no prompt, still gated during interruption), `ask` (explicit
  per-call decision) or `deny`. Tools not listed are denied with a visible error.
- `runtime.builtinTools`: must be `[]` in D1; Mia has proven an enforceable approval boundary only for MCP tools.

## Run

```sh
npm run server -- --config path/to/profile.json      # loopback WebSocket, prints the URL
npm run server -- --config path/to/profile.json --debug   # also marks each conversation it starts as captured in debug mode
npm run client -- --config path/to/profile.json      # terminal client: text in, streamed text out, /approve /reject /interrupt
npm run mia -- debug conversations --state <stateDirectory>
npm run mia -- debug conversation <id> --state <stateDirectory>
npm run mia -- debug watch <id> --state <stateDirectory>        # live web view on 127.0.0.1; --no-open prints the address only
npm run mia -- debug export <id> --output ./exports/<id> --state <stateDirectory>
npm run mia -- debug verify ./exports/<id>
```

## Verify against the real runtime

```sh
npm run probe                     # capability probe (writes .mia-state/probe/<stamp>/, ~7 live turns)
npm run live -- --repeat 2        # promptfoo live lane against the controlled fixture (~24 live turns)
```

Both count turns in `.mia-state/live-calls.jsonl` and stop at `MIA_LIVE_CALL_CAP` (default 50). The live lane writes
`docs/D1/acceptance/live-results-<prompt-version>.md`; pass `--agent-prompt prompts/agent-v2.md` to compare prompt versions
on the same fixture-ledger evidence.

## Layout

| Path                      | Contents                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `apps/server`             | provenance snapshots, engine (coordinator + approval/interruption controller), WebSocket gateway                   |
| `apps/text-client`        | terminal client and the reusable `MiaClient`                                                                       |
| `apps/debug-cli`          | `mia debug …` read-only inspection, export, verify, reconcile                                                      |
| `packages/protocol`       | versioned client/server messages (zod), canonical digests, redaction                                               |
| `packages/kernel`         | dependency-free commit-first kernel: decide, commit, apply, perform; committed-change feed; held replies           |
| `packages/agent-adapter`  | profile loading, Claude Code adapter: launch plan, stream-json parsing, approval bridge, static probe, live budget |
| `packages/records`        | SQLite catalog, content-addressed objects, record writer, snapshot queries, export/verify, HTML report             |
| `packages/mcp-http`       | loopback Streamable-HTTP host used by the fixture and the bridge                                                   |
| `fixtures/controlled-mcp` | controlled MCP fixture with append-only ledger and barriers                                                        |
| `tests/acceptance`        | H lane (scripted runtime), fake-runtime end-to-end, promptfoo live lane                                            |
| `tools/probe`             | capability probe                                                                                                   |
| `prompts/`                | versioned Mia agent instructions (`agent-v1.md`)                                                                   |
