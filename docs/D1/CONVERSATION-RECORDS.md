# Conversation debugging, records, and artifact retrieval

Status: D1 foundation implemented in `packages/records` and `apps/debug-cli` (`mia debug …`). Companion to [D1](PLAN.md) and the [delivery requirements](../PLAN.md). Implement the D1 foundation now; later rows below describe storage compatibility, not authorization to implement later deliverables.

## What a whole-conversation view means

Yes: D1 needs one read-only debugging entry point per conversation, rather than requiring someone to join logs manually. Start with a CLI report and a portable static HTML report generated from the same query service. This is a developer inspection tool, not the product's interactive view or A2UI adapter.

The report includes:

- Conversation identity, start time, current status, task summaries, and an explicit observation cutoff.
- A readable transcript with links to its underlying ordered events; partial output is labelled partial rather than presented as a completed answer.
- Expandable task timelines: input, agent output, proposed tool calls, policy evaluations, approval decisions, dispatch, result, interruption, errors, and available usage/timing.
- Artifact inventory with kind, producer, originating event/task, size, digest, and retained/missing/external-only status.
- Effective configuration, requested/reported model and effort with explicit-setting evidence, prompt/contract versions, runtime/adapter versions, architecture revision, and actual client/server builds.
- Client diagnostics with capture/receipt times and freshness; a clear distinction between absent evidence, a disconnected client, and a negative result.

Filter by task, execution, tool call, client, event type, or error. Links to event IDs and artifact IDs are stable within exports. Escape all recorded text in HTML, do not execute artifact scripts, and do not load remote content automatically. Inspection must never resume an agent, approve a call, replay a tool, or contact a provider.

A whole-conversation view means **all retained and observable evidence**, not hidden provider reasoning, credentials, unexposed runtime internals, or arbitrary files the agent could access. Each capture gap must be visible. Conversation completion is not required to inspect it, and later task/job events can extend its history.

## Proposed D1 operator interface

Command names are interface proposals, not commands available today:

```text
mia debug conversations
mia debug conversation <conversation-id>
mia debug artifacts <conversation-id>
mia debug export <conversation-id> --output <directory>
mia debug verify <export-directory>
```

The export creates a self-contained directory:

```text
manifest.json             # schema versions, cutoff, coverage, hashes, counts, gaps
conversation.json         # conversation and related structured records
records/*.jsonl           # table-oriented records with stable primary/foreign IDs
events.jsonl              # ordered event history through the cutoff
report.html               # offline, read-only whole-conversation view
objects/sha256/<prefix>/<digest>
```

The default local export includes all retained, registered artifact bytes reachable from the conversation, including shared prompt/build snapshots and artifacts from its tasks, without duplicating identical bytes. It must not export unrelated conversations merely because they share an artifact. Record links to outside conversations without traversing their histories. Future jobs contribute only linked runs observed through the cutoff; an ongoing job cannot have a permanently complete export.

The export is credential-redacted, but it can still contain private conversation content and generated files. It remains local; sharing is a separate action. Do not silently omit a large retained artifact: either include it, report a copy failure, or explicitly label a requested metadata-only export as incomplete.

## Sources of truth and physical layout

Use one private SQLite catalog plus immutable content-addressed objects. Conversation directories hold manifests/reports, not independent copies of every shared object:

```text
$XDG_STATE_HOME/mia/
  catalog.sqlite
  objects/sha256/<prefix>/<digest>
  conversations/<utc-start>_<conversation-id>/
    manifest.json
  staging/
```

The database owns identities, relationships, operational state, and the append-only normalized event history. Objects own retained bytes. The conversation manifest is a regenerable index into the catalog; the directory name or an original file path is never the relational key. Reports, transcript projections, search indexes, and exports are derived data.

Redact before persistence. A digest addresses the retained bytes, not an inaccessible unredacted original. Keep the approval argument binding digest separate from the artifact digest. Changing an artifact creates a new artifact identity/version; do not overwrite a retained object. Identical bytes may be deduplicated, but two production events still have distinct logical artifact records.

Generated files must be explicitly registered by the adapter/tool result or an output collector for a declared task output directory. Copy a completed, stable version into the object store and retain its producer and original-path metadata. A path or URL in model prose alone is not proof of an artifact or its contents. Do not crawl the user's filesystem to infer outputs. Code edits can be represented by a retained patch, base revision and relevant snapshots; this does not promise a full copy of a working repository. External-only outputs carry a locator, capture status, and reason they were not retained.

## D1 logical records

Each record below exists for a reason the schema cannot express; its columns, types and constraints are the SQL in [`packages/records/src/schema.ts`](../../packages/records/src/schema.ts). Every table has a stable primary key, schema-versioned payloads where used, and explicit timestamps. Scoped relationships must reject cross-conversation mismatches, using composite foreign keys where appropriate. Enable foreign-key enforcement on every connection; SQLite requires applications to enable it. [SQLite foreign-key documentation](https://www.sqlite.org/foreignkeys.html).

| Record | Why it exists |
| --- | --- |
| `conversations` | Stable debugging and retrieval root. |
| `tasks` | Work retains its originating conversation even if another becomes active later. |
| `executions` | Attribute actual runtime attempts and builds; do not assume a task always has only one execution. D1 runs one at a time. |
| `events` | Ordered history plus causal links across different clocks. Unknown or unobservable timing remains unknown. |
| `commands` | Detect duplicate commands and reject reuse of an ID with a different payload. |
| `tool_calls` | Distinguish intent, authorization, dispatch, result, and uncertain side effects. |
| `approvals` | Single-use exact-call authorization; denial and invalidation are evidence too. |
| `clients`, `client_connections` | Differentiate stable devices from process/connection lifetimes and changing builds. |
| `diagnostics` | Freshness and reconstruction without repeatedly storing unchanged detail. Retain all referenced bases. |
| `provenance_sets`, `provenance_entries` | Prompt, configuration, contract, architecture, source/build and adapter snapshots; missing entries have explicit reasons. |
| `artifacts` | Inventory of generated outputs, tool payloads, runtime transcripts if exposed, diagnostic data and snapshots. |
| `objects` | Immutable retained bytes; storage location is independent of original paths. |
| `artifact_links` | Enumerate every artifact needed by a conversation, including shared snapshots and large event payloads. Typed references avoid an unverifiable generic owner string. |
| `artifact_dependencies` | Include referenced data, bases and attachments needed to interpret an artifact. Traverse with cycle detection. |

Make artifact-link registration part of the same database transaction that introduces a reference. Use check constraints to validate link roles and required typed IDs. A snapshot shared across conversations gets a link in each conversation. Add indexes for other foreign-key child columns where the actual joins/integrity checks require them; avoid redundant indexes already covered by a leading key below.

Normalized events and affected state rows commit together. Events describe the evidence of state transitions; they do not make a distributed tool effect transactional. An action can complete even if its result never reaches Mia. Never infer exactly-once external effects from a uniqueness constraint.

## D1 indexes and the queries they serve

`UNIQUE` entries are correctness constraints as well as indexes. IDs have primary-key indexes; do not add duplicate ID indexes. Nullable scoped fields require deliberate constraints rather than assuming uniqueness treats missing values as identical.

| Table and key | Kind | Query / invariant |
| --- | --- | --- |
| `conversations(started_at, id)` | Index | List conversations with stable cursor pagination. |
| `tasks(conversation_id, created_at, id)` | Index | List all tasks belonging to the conversation. |
| `executions(task_id, started_at, id)` | Index | Follow attempts and the actual model/build for a task. |
| `events(conversation_id, sequence)` | Unique | Ordered, paged timeline and an unambiguous export watermark. |
| `events(task_id, sequence)` | Index | Task timeline; a task belongs to one conversation. |
| `events(execution_id, sequence)` | Index | Runtime attempt trace. |
| `events(conversation_id, type, sequence)` | Index | Errors, approvals, interruptions, usage and timing without scanning all deltas. |
| `events(producer_id, producer_event_id)` where producer event ID is present | Partial unique | Deduplicate inbound events only when the source supplies stable event identities; never deduplicate equal text by content. |
| `events(caused_by_event_id)` | Index | Find effects of a user command, decision or tool result. |
| `commands(client_connection_id, client_command_id)` | Unique | D1 command deduplication inside an authenticated connection lifetime. D3 extends this to durable retry identity across reconnects. |
| `tool_calls(execution_id, runtime_call_id, binding_revision)` | Unique | Preserve immutable argument bindings under a runtime call ID; the probe establishes ID scope. Only the current revision can be released. |
| `tool_calls(task_id, proposal_event_id)` | Index | List calls and uncertain outcomes for a task. |
| `approvals(tool_call_id, execution_epoch)` | Unique | One decision lifecycle for each immutable call binding in an epoch. A changed tool or changed arguments create a new binding at the next revision, supersede the old binding, invalidate its pending approval and require a fresh decision. Never mutate approved arguments or release a superseded revision. |
| `approvals(status, id)` where status is pending | Partial index | Enumerate unresolved approval requests. |
| `client_connections(client_id, connected_at, id)` | Index | Connection history and build changes. |
| `diagnostics(conversation_id, client_id, received_at, id)` | Index | Latest and historical diagnostic state by client in a conversation. |
| `artifacts(object_digest)` | Index | Trace stored bytes back to their logical outputs. |
| `artifact_links(conversation_id, artifact_id)` | Index | Full conversation inventory and export roots. Multiple relationships may refer to the same artifact. |
| `artifact_links(artifact_id, conversation_id)` | Index | Locate artifact usages and verify shared-object reachability. |
| `artifact_links(task_id, artifact_id)` and `artifact_links(event_id, artifact_id)` | Indexes | Show attachments beside a task or event. |
| `provenance_entries(provenance_set_id, role, ordinal)` | Unique | Resolve a versioned, possibly multi-part snapshot role deterministically. |
| `artifact_dependencies(parent_artifact_id, required_artifact_id, relation)` | Unique | Traverse the export dependency closure without duplicate edges. |
| `artifact_dependencies(required_artifact_id, parent_artifact_id)` | Index | Find dependants when a stored object is missing or corrupt. |

These are access-pattern proposals, not performance guarantees. Check query plans and representative histories during implementation; add an index only for a demonstrated query or integrity need. Partial indexes can restrict an index to matching rows, such as pending approvals. [SQLite partial-index documentation](https://www.sqlite.org/partialindex.html).

## Consistent collection and completeness

1. Finalize artifact bytes in a staging file, hash them, then durably publish the immutable object before committing its catalog row, reference links and associated event. A crash may leave an unreferenced object; it must not produce a catalog entry claiming unwritten bytes are available. Reconcile orphans and missing/corrupt objects without silently deleting evidence.
2. Export from one consistent database read snapshot. Select the conversation's maximum committed sequence and all associated rows from that same snapshot; do not read mutable task status after releasing it. For a large export, a private temporary database backup is an alternative, using SQLite's supported backup API; never package the whole multi-conversation backup as the user's single-conversation export. The backup API provides a consistent live-database snapshot. [SQLite backup documentation](https://www.sqlite.org/backup.html).
3. Traverse conversation artifact links, provenance entries, and artifact dependencies. Include the scoped records referenced by exported records. Retain outside-conversation references as clearly labelled stubs, not a reason to export unrelated private histories. Typed links and dependency validation must prevent shared artifacts from smuggling unrelated conversation data into the closure.
4. Copy immutable referenced objects, verifying size and digest. Do not fetch external URLs, read arbitrary original paths, or re-execute tools to fill gaps. Pending file captures and in-progress streaming objects appear as pending at the cutoff; finalized chunks are included independently.
5. Write a manifest with export/schema versions, root conversation ID, capture time, cutoff sequence, record/artifact counts, coverage by evidence type, checksums, unresolved references, missing/corrupt/external-only objects, redaction information, and ongoing tasks. Finalize the export directory only after verification. Any partial export is explicitly labelled partial and reports an unsuccessful completeness check.

Completeness has two dimensions: every **registered reference** is accounted for, and the runtime's **capture coverage** states what it can expose. A clean manifest cannot prove an agent never created an undisclosed file. Optional unavailable internals do not fail D1 acceptance, but missing evidence required for a D1 pass condition does. No export is a replay script or a guarantee of reproducible provider output.

## Compatibility with later requirements

The D1 foundation preserves identity, chronology, provenance and artifact reachability. It does **not** by itself fulfill all future requirements. Add the following typed records and indexes when each capability is implemented; indexes cannot replace execution control, access control, cancellation or external-service guarantees.

| Requirement | Reuse from D1 | Later addition and access path | Remaining limitation |
| --- | --- | --- | --- |
| D2: audio, transcripts, generated versus played speech | Artifact objects, events, client connections and producer sequences | Voice connections and utterances; audio chunks indexed by `(utterance_id, track, chunk_sequence)`; playback receipts by `(client_connection_id, utterance_id, sequence)`; transcript segments linked to audio offsets and source events | Generated audio is not evidence of playback; missing playback receipts remain unknown. |
| D3: Close, reconnect, Continue/New, notifications, Quit/restart | Stable conversation/task IDs, pending decisions, durable events and outcomes | Durable client command retry IDs independent of connection; unique retry key scoped to client identity; notification/outbox records indexed by delivery state/next attempt and originating conversation; recovery checkpoints and ownership fences | D1 inspection/export works offline, but D1 does not promise safe task resumption. Never recover execution by replaying historical events. |
| D4: versioned visual content, updates, dimensions and clicks | Artifact dependencies, content types, causal event links | Views/revisions indexed uniquely by `(view_id, revision)`; view events by `(view_id, sequence)`; unique client interaction IDs; diagnostics linked to view/revision; retained base data and patches | Must retain the base and every required patch, or a materialized snapshot. Ordinary HTML report output is not the product UI adapter. |
| D5: phone, handoff, active device and diagnostics | Client/connection IDs, actual build references and pending approvals | Device authorization, handoff records and ownership epochs indexed by `(conversation_id, epoch)`; diagnostic lookup by connection/time; persisted active-client transitions | Ownership and authorization must be enforced at command handling; client timestamps do not establish cross-device order. |
| D6: workers, escalation, task transfers and concurrency | Multiple execution identities per task, actual model/effort/provenance, causal links | Parent-task/delegation links indexed by parent ID; ownership history and unique active owner per task; resource leases with fencing; actual agent role recorded per execution | Storage alone cannot prevent conflicting effects or stop a former owner. Apply new effort/model rules per configured role rather than hard-coding D1's choice globally. |
| D7: recall, sourced answers, diagnostics and richer workflows | Immutable source event/artifact IDs, typed content, queryable diagnostic records | Derived search documents and full-text index over redacted transcript/results/metadata; citations map exact event IDs, artifact versions and offsets. Optional semantic index only if needed; agent diagnostic API uses existing indexed queries | Search indexes are rebuildable projections, never authority or automatically inherited context. OCR/transcription would be needed to search otherwise opaque binary content. |
| D8: external jobs, runs, notifications and recovery | Originating conversation links, execution provenance, artifact registry | Unique `(service_id, external_job_id)` and `(service_id, external_run_id)`; job-run indexes by `(job_id, started_at)` and `(conversation_id, started_at)`; service-event deduplication keys, latest monitoring observation, and notification/outbox links | External service owns schedules/recovery semantics. Exports cover observed linked runs through a cutoff, not future runs or unavailable service internals. |
| Cross-cutting: indefinite retention, tuning and usage | Immutable snapshots and object digests, typed events, requested/reported model and effort | Metrics projection indexed by model/prompt version/time; migrations with schema versions; storage monitoring, backup/restore checks, and later partitioning only if volume warrants it | Indefinite retention requires capacity management; an index does not provide a backup or recover evidence never captured. Disk-full conditions must be visible. |

Use a versioned search projection when recall arrives; SQLite FTS5 is an available full-text implementation, with sources retained outside the index. [SQLite FTS5 documentation](https://www.sqlite.org/fts5.html). No vector database or audio index is needed for D1's conversation inspection.

## D1 verification additions

- Produce a conversation containing streamed output, both approval outcomes, interruption, an error, diagnostics, a generated file, and shared provenance. Inspect it through one report.
- Export it while another task event is being written; all included mutable rows and events reflect the same snapshot/cutoff. Later events must not leak into the export's report.
- Create an unrelated conversation sharing a prompt artifact. Export the first; include that prompt's bytes once and no unrelated transcript or records.
- Remove/change the original generated file after registration; the retained artifact remains retrievable and verifiable. Two outputs with identical bytes preserve distinct producer records.
- Detect a missing/corrupt object, unresolved dependency, unavailable runtime artifact, and pending file capture. Show precise completeness/coverage status without rerunning a tool.
- Simulate crashes between object publication and database commit; reconcile orphan files. Simulate record-write failure; never authorize a call whose required approval record was not committed.
- Verify seeded credentials are absent from persisted records and exports, and recorded HTML/script text cannot execute in the report.
- Validate foreign keys, artifact closure, manifest hashes and record counts. Confirm paginated transcript reconstruction and indexed query plans on representative long conversations, with no fixed latency target yet.
- Open and verify the exported report without a server, agent runtime, provider connection, or access to original file paths. Capture this as D1 acceptance evidence.
