import { diagnosticsViews, taskViews, type ConversationSnapshot } from "./queries.ts";

const esc = (v: unknown): string =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** A cell whose content is already escaped markup; every other cell value is escaped as text. */
class Html {
  constructor(readonly markup: string) {}
}
const pre = (v: unknown): Html => new Html(`<pre>${esc(typeof v === "string" ? v : JSON.stringify(v, null, 2))}</pre>`);

function table(headers: string[], rows: unknown[][]): string {
  if (rows.length === 0) return "<p class=muted>none</p>";
  return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c instanceof Html ? c.markup : esc(c)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

/**
 * Offline, read-only whole-conversation report. No scripts, no remote content, everything escaped.
 * The CSP forbids script execution even if recorded text contains markup.
 */
export function renderReport(snapshot: ConversationSnapshot, options: { objectStatus?: Record<string, string> } = {}): string {
  const conv = snapshot.tables.conversations[0]!;
  const tasks = taskViews(snapshot);
  const diags = diagnosticsViews(snapshot, Date.parse(snapshot.captured_at));
  const provenance = snapshot.tables.provenance_entries;
  const artifacts = snapshot.tables.artifacts;
  const objectStatus = options.objectStatus ?? {};
  const artifactById = new Map(artifacts.map((a) => [a.id as string, a]));

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
    provenance.map((p) => {
      const art = p.artifact_id ? artifactById.get(p.artifact_id as string) : undefined;
      return [p.role, p.version, p.availability, p.artifact_id ?? "", art?.object_digest ?? "", p.reason ?? ""];
    }),
  )}
${table(
  ["execution", "task", "epoch", "requested model", "reported model", "requested effort", "reported effort", "effort evidence", "status", "usage"],
  snapshot.tables.executions.map((e) => [e.id, e.task_id, e.execution_epoch, e.requested_model, e.reported_model ?? "unreported", e.requested_effort, e.reported_effort ?? "unverified", pre(e.effort_evidence ? JSON.parse(e.effort_evidence as string) : null), e.status, pre(e.usage ? JSON.parse(e.usage as string) : null)]),
)}`);

  sections.push(`<h2>Transcript</h2>${tasks
    .map(
      (t) => `<section class=task><h3>Task ${esc(t.id)} <span class="badge ${esc(t.status)}">${esc(t.status)}</span></h3>
<p class=muted>${esc(t.created_at)} → ${esc(t.finished_at ?? "not finished")}</p>
<div class=user><strong>User</strong>${pre(t.text).markup}</div>
<div class=assistant><strong>Agent${t.partial ? " (partial output; task did not complete)" : ""}</strong>${pre(t.assistant_text || "(no text)").markup}</div>
<details><summary>Tool calls and approvals (${t.tool_calls.length})</summary>${table(
        ["tool", "runtime call", "rev", "policy", "status", "detail", "arguments (redacted)", "digest", "approvals"],
        t.tool_calls.map((c) => [c.tool_identity, c.runtime_call_id, c.binding_revision, c.policy, c.status, c.detail ?? "", pre(JSON.parse(c.redacted_arguments as string)), String(c.argument_digest).slice(0, 16) + "…", pre(c.approvals.map((a) => ({ id: a.id, status: a.status, epoch: a.execution_epoch, reason: a.reason, client: a.decision_client_id, consumed_at: a.consumed_at })))]),
      )}</details>
${t.interruption ? `<details open><summary>Interruption outcome</summary>${pre(t.interruption).markup}</details>` : ""}
${t.errors.length ? `<details open><summary>Errors and runtime stderr (${t.errors.length})</summary>${table(["seq", "type", "payload"], t.errors.map((e) => [e.sequence, e.type, pre(JSON.parse(e.payload as string))]))}</details>` : ""}
<details><summary>Event timeline (${t.events.length})</summary>${table(
        ["seq", "received", "type", "caused by", "payload"],
        t.events.map((e) => [e.sequence, e.received_at, e.type, e.caused_by_event_id ?? "", pre(JSON.parse(e.payload as string))]),
      )}</details>
</section>`,
    )
    .join("")}`);

  const conversationEvents = snapshot.tables.events.filter((e) => !e.task_id);
  sections.push(`<h2>Conversation-level events</h2>${table(["seq", "received", "type", "payload"], conversationEvents.map((e) => [e.sequence, e.received_at, e.type, pre(JSON.parse(e.payload as string))]))}`);

  sections.push(`<h2>Client diagnostics</h2>${table(
    ["client", "connection", "captured", "received", "freshness", "state"],
    diags.map((d) => [d.client_id, d.connection_id ?? "", d.captured_at, d.received_at, d.freshness, pre(d.state)]),
  )}<p class=muted>freshness: current = received within 60s of the cutoff; stale = older; disconnected = the reporting connection has closed. Absent rows mean no diagnostics were received, not that the client was healthy.</p>`);

  sections.push(`<h2>Artifact inventory (${artifacts.length})</h2>${table(
    ["artifact", "kind", "name", "mime", "size", "capture", "digest", "object", "producer", "original path / locator", "reason"],
    artifacts.map((a) => [a.id, a.kind, a.logical_name, a.mime_type ?? "", a.byte_size ?? "", a.capture_status, a.object_digest ?? "", a.object_digest ? objectStatus[a.object_digest as string] ?? "not checked" : "n/a", a.producer_execution_id ?? a.producer_event_id ?? "", a.original_path ?? a.external_locator ?? "", a.capture_reason ?? ""]),
  )}
<h3>Links</h3>${table(["artifact", "relation", "task", "event", "tool call", "provenance set"], snapshot.tables.artifact_links.map((l) => [l.artifact_id, l.relation, l.task_id ?? "", l.event_id ?? "", l.tool_call_id ?? "", l.provenance_set_id ?? ""]))}
<h3>Dependencies</h3>${table(["parent", "requires", "relation"], snapshot.tables.artifact_dependencies.map((d) => [d.parent_artifact_id, d.required_artifact_id, d.relation]))}`);

  sections.push(`<h2>Coverage and gaps</h2>${table(["gap", "detail"], [
    ...snapshot.unresolved_references.map((u) => [`${u.table} ${u.id}`, u.reason]),
    ...provenance.filter((p) => p.availability === "unavailable").map((p) => [`provenance ${p.role}`, p.reason ?? "unavailable"]),
    ...artifacts.filter((a) => a.capture_status !== "retained").map((a) => [`artifact ${a.id} (${a.logical_name})`, `${a.capture_status}: ${a.capture_reason ?? ""}`]),
  ])}<p class=muted>This report shows retained and observable evidence only. Hidden provider reasoning, the runtime's full system prompt and files the agent touched without declaring them are not captured.</p>`);

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
}
