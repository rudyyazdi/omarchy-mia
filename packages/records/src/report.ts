import { parseJson } from "./catalog.ts";
import type { ObjectIntegrity } from "./schema.ts";
import {
  diagnosticsViews,
  taskViews,
  type ConversationSnapshot,
  type TaskView,
} from "./queries.ts";

const esc = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** A cell whose content is already escaped markup; every other cell value is escaped as text. */
class Html {
  constructor(readonly markup: string) {}
}
const pre = (value: unknown): Html =>
  new Html(`<pre>${esc(typeof value === "string" ? value : JSON.stringify(value, null, 2))}</pre>`);

const cell = (value: unknown): string =>
  `<td>${value instanceof Html ? value.markup : esc(value)}</td>`;

const table = (headers: string[], rows: unknown[][]): string => {
  if (rows.length === 0) return "<p class=muted>none</p>";
  const head = headers.map((header) => `<th>${esc(header)}</th>`).join("");
  const body = rows.map((row) => `<tr>${row.map(cell).join("")}</tr>`).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
};

/** Parse a stored JSON column for display; null columns render as null. */
const stored = (json: string | null): unknown => (json ? parseJson(json) : null);

const taskSection = (task: TaskView): string => {
  const partialNote = task.partial ? " (partial output; task did not complete)" : "";
  const interruption = task.interruption
    ? `<details open><summary>Interruption outcome</summary>${pre(task.interruption).markup}</details>`
    : "";
  const errors = task.errors.length
    ? `<details open><summary>Errors and runtime stderr (${task.errors.length})</summary>${table(
        ["seq", "type", "payload"],
        task.errors.map((event) => [event.sequence, event.type, pre(parseJson(event.payload))]),
      )}</details>`
    : "";
  return `<section class=task><h3>Task ${esc(task.id)} <span class="badge ${esc(task.status)}">${esc(task.status)}</span></h3>
<p class=muted>${esc(task.created_at)} → ${esc(task.finished_at ?? "not finished")}</p>
<div class=user><strong>User</strong>${pre(task.text).markup}</div>
<div class=assistant><strong>Agent${partialNote}</strong>${pre(task.assistant_text || "(no text)").markup}</div>
<details><summary>Tool calls and approvals (${task.tool_calls.length})</summary>${table(
    [
      "tool",
      "runtime call",
      "rev",
      "policy",
      "status",
      "detail",
      "arguments (redacted)",
      "digest",
      "approvals",
    ],
    task.tool_calls.map((call) => [
      call.tool_identity,
      call.runtime_call_id,
      call.binding_revision,
      call.policy,
      call.status,
      call.detail ?? "",
      pre(parseJson(call.redacted_arguments)),
      String(call.argument_digest).slice(0, 16) + "…",
      pre(
        call.approvals.map((approval) => ({
          id: approval.id,
          status: approval.status,
          epoch: approval.execution_epoch,
          reason: approval.reason,
          client: approval.decision_client_id,
          consumed_at: approval.consumed_at,
        })),
      ),
    ]),
  )}</details>
${interruption}
${errors}
<details><summary>Event timeline (${task.events.length})</summary>${table(
    ["seq", "received", "type", "caused by", "payload"],
    task.events.map((event) => [
      event.sequence,
      event.received_at,
      event.type,
      event.caused_by_event_id ?? "",
      pre(parseJson(event.payload)),
    ]),
  )}</details>
</section>`;
};

/**
 * Offline, read-only whole-conversation report. No scripts, no remote content, everything escaped.
 * The CSP forbids script execution even if recorded text contains markup.
 */
export const renderReport = (
  snapshot: ConversationSnapshot,
  options: { objectStatus?: Record<string, ObjectIntegrity> } = {},
): string => {
  const conv = snapshot.tables.conversations[0];
  if (!conv) throw new Error(`snapshot ${snapshot.conversation_id} has no conversation row`);
  const tasks = taskViews(snapshot);
  const diags = diagnosticsViews(snapshot, Date.parse(snapshot.captured_at));
  const provenance = snapshot.tables.provenance_entries;
  const artifacts = snapshot.tables.artifacts;
  const objectStatus = options.objectStatus ?? {};
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));

  const sections: string[] = [];
  sections.push(`<h1>Conversation ${esc(conv.id)}</h1>
<table class=kv>
<tr><th>started</th><td>${esc(conv.started_at)}</td></tr>
<tr><th>status</th><td>${esc(conv.status)}</td></tr>
<tr><th>runtime conversation</th><td>${esc(conv.runtime_conversation_id)}</td></tr>
<tr><th>observation cutoff</th><td>event sequence ${snapshot.cutoff_sequence}, captured ${esc(snapshot.captured_at)}</td></tr>
<tr><th>ongoing tasks at cutoff</th><td>${snapshot.ongoing_tasks.length ? esc(snapshot.ongoing_tasks.join(", ")) : "none"}</td></tr>
<tr><th>tasks</th><td>${tasks.length}</td></tr>
</table>`);

  sections.push(`<h2>Provenance and builds</h2>${table(
    ["role", "version", "availability", "artifact", "digest", "reason"],
    provenance.map((entry) => {
      const artifact = entry.artifact_id ? artifactById.get(entry.artifact_id) : undefined;
      return [
        entry.role,
        entry.version,
        entry.availability,
        entry.artifact_id ?? "",
        artifact?.object_digest ?? "",
        entry.reason ?? "",
      ];
    }),
  )}
${table(
  [
    "execution",
    "task",
    "epoch",
    "requested model",
    "reported model",
    "requested effort",
    "reported effort",
    "effort evidence",
    "status",
    "usage",
  ],
  snapshot.tables.executions.map((execution) => [
    execution.id,
    execution.task_id,
    execution.execution_epoch,
    execution.requested_model,
    execution.reported_model ?? "unreported",
    execution.requested_effort,
    execution.reported_effort ?? "unverified",
    pre(stored(execution.effort_evidence)),
    execution.status,
    pre(stored(execution.usage)),
  ]),
)}`);

  sections.push(`<h2>Transcript</h2>${tasks.map(taskSection).join("")}`);

  const conversationEvents = snapshot.tables.events.filter((event) => !event.task_id);
  sections.push(
    `<h2>Conversation-level events</h2>${table(
      ["seq", "received", "type", "payload"],
      conversationEvents.map((event) => [
        event.sequence,
        event.received_at,
        event.type,
        pre(parseJson(event.payload)),
      ]),
    )}`,
  );

  sections.push(
    `<h2>Client diagnostics</h2>${table(
      ["client", "connection", "captured", "received", "freshness", "state"],
      diags.map((diagnostic) => [
        diagnostic.client_id,
        diagnostic.connection_id ?? "",
        diagnostic.captured_at,
        diagnostic.received_at,
        diagnostic.freshness,
        pre(diagnostic.state),
      ]),
    )}<p class=muted>freshness: current = received within 60s of the cutoff; stale = older; disconnected = the reporting connection has closed. Absent rows mean no diagnostics were received, not that the client was healthy.</p>`,
  );

  sections.push(`<h2>Artifact inventory (${artifacts.length})</h2>${table(
    [
      "artifact",
      "kind",
      "name",
      "mime",
      "size",
      "capture",
      "digest",
      "object",
      "producer",
      "original path / locator",
      "reason",
    ],
    artifacts.map((artifact) => [
      artifact.id,
      artifact.kind,
      artifact.logical_name,
      artifact.mime_type ?? "",
      artifact.byte_size ?? "",
      artifact.capture_status,
      artifact.object_digest ?? "",
      artifact.object_digest ? (objectStatus[artifact.object_digest] ?? "not checked") : "n/a",
      artifact.producer_execution_id ?? artifact.producer_event_id ?? "",
      artifact.original_path ?? artifact.external_locator ?? "",
      artifact.capture_reason ?? "",
    ]),
  )}
<h3>Links</h3>${table(
    ["artifact", "relation", "task", "event", "tool call", "provenance set"],
    snapshot.tables.artifact_links.map((link) => [
      link.artifact_id,
      link.relation,
      link.task_id ?? "",
      link.event_id ?? "",
      link.tool_call_id ?? "",
      link.provenance_set_id ?? "",
    ]),
  )}
<h3>Dependencies</h3>${table(
    ["parent", "requires", "relation"],
    snapshot.tables.artifact_dependencies.map((dependency) => [
      dependency.parent_artifact_id,
      dependency.required_artifact_id,
      dependency.relation,
    ]),
  )}`);

  sections.push(
    `<h2>Coverage and gaps</h2>${table(
      ["gap", "detail"],
      [
        ...snapshot.unresolved_references.map((unresolved) => [
          `${unresolved.table} ${unresolved.id}`,
          unresolved.reason,
        ]),
        ...provenance
          .filter((entry) => entry.availability === "unavailable")
          .map((entry) => [`provenance ${entry.role}`, entry.reason ?? "unavailable"]),
        ...artifacts
          .filter((artifact) => artifact.capture_status !== "retained")
          .map((artifact) => [
            `artifact ${artifact.id} (${artifact.logical_name})`,
            `${artifact.capture_status}: ${artifact.capture_reason ?? ""}`,
          ]),
      ],
    )}<p class=muted>This report shows retained and observable evidence only. Hidden provider reasoning, the runtime's full system prompt and files the agent touched without declaring them are not captured.</p>`,
  );

  return `<!doctype html>
<html lang=en><head><meta charset=utf-8>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;">
<title>Mia conversation ${esc(conv.id)}</title>
<style>
body{font:14px/1.4 system-ui,sans-serif;margin:24px;color:#111;background:#fff}
table{border-collapse:collapse;margin:8px 0;max-width:100%}
th,td{border:1px solid #ccc;padding:4px 6px;vertical-align:top;text-align:left}
th{background:#f3f3f3}
pre{margin:0;white-space:pre-wrap;word-break:break-word;max-width:60ch;font-size:12px}
.kv th{width:12em}
.muted{color:#666}
.task{border:1px solid #ddd;padding:12px;margin:12px 0}
.badge{font-size:12px;padding:2px 6px;border-radius:4px;background:#eee}
.badge.completed{background:#d7f5dd}.badge.interrupted,.badge.outcome_unknown{background:#ffe9c7}.badge.failed{background:#ffd6d6}
details{margin:6px 0}
</style></head><body>${sections.join("\n")}</body></html>`;
};
