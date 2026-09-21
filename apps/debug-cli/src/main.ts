/**
 * mia debug: read-only inspection of the private conversation catalog. Works offline, never contacts a
 * runtime or provider, never approves or replays anything.
 */
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import {
  Catalog,
  defaultStateDir,
  exportConversation,
  listConversations,
  reconcileObjects,
  snapshotConversation,
  taskViews,
  diagnosticsViews,
  verifyExport,
} from "@mia/records";

const { values, positionals } = parseArgs({
  options: {
    state: { type: "string" },
    output: { type: "string" },
    json: { type: "boolean", default: false },
  },
  allowPositionals: true,
});
const [group, command, arg] = positionals;
const stateDir = resolve(values.state ?? defaultStateDir());
const out = (v: unknown) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));

function usage(): never {
  console.error(`usage:
  mia debug conversations                       [--state DIR]
  mia debug conversation <conversation-id>      [--state DIR] [--json]
  mia debug artifacts <conversation-id>         [--state DIR]
  mia debug export <conversation-id> --output <directory> [--state DIR]
  mia debug verify <export-directory>
  mia debug reconcile                           [--state DIR]`);
  process.exit(2);
}

if (group !== "debug" || !command) usage();

if (command === "verify") {
  if (!arg) usage();
  const result = verifyExport(resolve(arg));
  out(result);
  process.exit(result.ok ? 0 : 1);
}

const catalog = new Catalog(stateDir, {
  readonly: command !== "export" && command !== "reconcile" ? true : false,
});
try {
  switch (command) {
    case "conversations": {
      const list = listConversations(catalog);
      if (values.json) out(list);
      else
        for (const c of list)
          out(
            `${c.started_at}  ${c.id}  ${c.status}  tasks=${c.task_count}  events=${c.last_sequence}`,
          );
      break;
    }
    case "conversation": {
      if (!arg) usage();
      const snapshot = snapshotConversation(catalog, arg);
      if (values.json) {
        out(snapshot);
        break;
      }
      const conv = snapshot.tables.conversations[0]!;
      out(
        `conversation ${conv.id}  started ${conv.started_at}  status ${conv.status}  cutoff seq ${snapshot.cutoff_sequence}`,
      );
      out(`provenance:`);
      for (const p of snapshot.tables.provenance_entries)
        out(
          `  ${p.role}: ${p.availability}${p.version ? ` v=${p.version}` : ""}${p.artifact_id ? ` artifact=${p.artifact_id}` : ""}${p.reason ? ` (${p.reason})` : ""}`,
        );
      for (const e of snapshot.tables.executions)
        out(
          `execution ${e.id} task=${e.task_id} epoch=${e.execution_epoch} model requested=${e.requested_model} reported=${e.reported_model ?? "unreported"} effort requested=${e.requested_effort} reported=${e.reported_effort ?? "unverified"} status=${e.status}`,
        );
      for (const t of taskViews(snapshot)) {
        out(`\n== task ${t.id} [${t.status}] ${t.created_at}`);
        out(`user> ${t.text}`);
        out(`agent${t.partial ? " (partial)" : ""}> ${t.assistant_text || "(no text)"}`);
        for (const c of t.tool_calls)
          out(
            `  tool ${c.tool_identity} call=${c.runtime_call_id} rev=${c.binding_revision} policy=${c.policy} status=${c.status}${c.detail ? ` (${c.detail})` : ""} approvals=${JSON.stringify(c.approvals.map((a) => `${a.id}:${a.status}`))}`,
          );
        if (t.interruption) out(`  interruption: ${JSON.stringify(t.interruption)}`);
        for (const e of t.errors) out(`  ${e.type}: ${e.payload}`);
      }
      out(`\ndiagnostics:`);
      for (const d of diagnosticsViews(snapshot))
        out(
          `  ${d.received_at} client=${d.client_id} ${d.freshness} ${JSON.stringify(d.state).slice(0, 160)}`,
        );
      if (snapshot.unresolved_references.length)
        out(`unresolved references: ${JSON.stringify(snapshot.unresolved_references)}`);
      break;
    }
    case "artifacts": {
      if (!arg) usage();
      const snapshot = snapshotConversation(catalog, arg);
      if (values.json) {
        out({
          artifacts: snapshot.tables.artifacts,
          links: snapshot.tables.artifact_links,
          dependencies: snapshot.tables.artifact_dependencies,
          objects: snapshot.tables.objects,
        });
        break;
      }
      for (const a of snapshot.tables.artifacts)
        out(
          `${a.id}  ${a.kind}  ${a.logical_name}  ${a.capture_status}  ${a.byte_size ?? "-"}B  ${a.object_digest ?? "no object"}${a.capture_reason ? `  (${a.capture_reason})` : ""}`,
        );
      out(
        `links: ${snapshot.tables.artifact_links.length}, dependencies: ${snapshot.tables.artifact_dependencies.length}, objects: ${snapshot.tables.objects.length}`,
      );
      break;
    }
    case "export": {
      if (!arg || !values.output) usage();
      const result = exportConversation(catalog, arg, resolve(values.output));
      out(
        `exported to ${result.directory}; complete=${result.manifest.complete}; events=${result.manifest.record_counts.events}; objects=${result.manifest.objects.included}${result.manifest.partial_reasons.length ? `; partial: ${result.manifest.partial_reasons.join(", ")}` : ""}`,
      );
      break;
    }
    case "reconcile": {
      out(reconcileObjects(catalog));
      break;
    }
    default:
      usage();
  }
} finally {
  catalog.close();
}
