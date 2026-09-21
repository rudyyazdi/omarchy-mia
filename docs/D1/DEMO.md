# D1 live demo script

Repeatable user acceptance demo from the D1 plan. Everything below uses the test profile (`claude-sonnet-5`, effort
`medium`) and the controlled fixture; nothing touches real services.

1. **Clean ledger, server, client.** In three terminals from the repository root:
   ```sh
   npm run fixture -- --dir /tmp/mia-demo-fixture --mcp-port 47331 --harness-port 47332
   MIA_FIXTURE_MCP_URL=http://127.0.0.1:47331/mcp MIA_FIXTURE_DIR=/tmp/mia-demo-fixture npm run server -- --config examples/config/fixture-test.json
   npm run client -- --config examples/config/fixture-test.json
   ```
   Inspect capabilities and provenance: `npm run mia -- debug conversation <id> --state .mia-state/fixture-test` shows the
   requested/reported model, the explicit effort with hook evidence after the first tool use, and every provenance entry
   (agent prompt digest, configuration, runtime identity, server build with local-changes snapshot, `runtime_instructions:
   unavailable`).
2. **Streamed text and follow-up.** Type `Remember marker K7. Explain approval in five sentences.` and watch deltas
   stream. Then `What marker did I give you?` — same conversation, same runtime session.
3. **Every-call approval.** `Call d1.change with delta 1 exactly once.` The approval panel shows tool, intended action,
   redacted arguments, and the binding (runtime call id, revision, epoch, digest). Check `cat /tmp/mia-demo-fixture/counter.txt`
   is still `0`, then `/approve <id>`; the counter becomes `1` and the ledger shows exactly one `committed`.
4. **Reject and repeat.** Ask again and `/reject <id>`: no effect. Ask again: a new approval id is required. Changed-argument
   handling is demonstrated by the H lane (`npm test`, "invalidates an approval when arguments change").
5. **Interruption.** `Call d1.slow with mode cancellable exactly once, then call d1.change with delta 1 exactly once.`
   Approve `slow`; when the ledger shows `entered`, type `/interrupt`. The outcome panel lists `slow` as cancelled by the
   fixture (ledger) and Mia's own classification of the released action as `unknown` (honest: the runtime was killed);
   no `change` is proposed or committed. Repeat with `uncancellable`, then `curl -XPOST http://127.0.0.1:47332/release`:
   the ledger commits once and Mia's record still says `unknown`, which is the truthful report.
6. **Diagnostics and snapshots.** `/diag` in the client, then edit `prompts/agent-v1.md` and re-run the debug view: the
   retained prompt snapshot digest is unchanged and its bytes still verify.
7. **Report and export.** `npm run mia -- debug export <id> --output ./exports/demo --state .mia-state/fixture-test`, then
   `npm run mia -- debug verify ./exports/demo` with the server stopped. Open `exports/demo/report.html` offline.

The automated equivalent of steps 2–7 is `npm run live -- --repeat 2`; its output is the live section of
[`ACCEPTANCE-RECORD.md`](ACCEPTANCE-RECORD.md).
