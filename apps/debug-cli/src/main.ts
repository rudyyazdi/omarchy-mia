/**
 * mia debug: read-only inspection of the private conversation catalog. Works offline, never contacts a
 * runtime or provider, never approves or replays anything.
 */
import { resolve } from "node:path";
import { Command } from "commander";
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
  type ConversationSnapshot,
} from "@mia/records";

interface GlobalOptions {
  state?: string;
  output?: string;
  json: boolean;
}

const USAGE = `usage:
  mia debug conversations                       [--state DIR]
  mia debug conversation <conversation-id>      [--state DIR] [--json]
  mia debug artifacts <conversation-id>         [--state DIR]
  mia debug export <conversation-id> --output <directory> [--state DIR]
  mia debug verify <export-directory>
  mia debug reconcile                           [--state DIR]`;

const usage: () => never = () => {
  console.error(USAGE);
  process.exit(2);
};

const out = (value: unknown) =>
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));

const program = new Command()
  .name("mia")
  .option("--state <DIR>", "state directory (defaults to the XDG state directory)")
  .option("--output <directory>", "export target directory (export only)")
  .option("--json", "print the raw snapshot as JSON", false)
  .exitOverride((error) => {
    if (error.exitCode === 0) process.exit(0);
    usage();
  })
  .configureOutput({ writeErr: () => undefined });

const options = () => program.opts<GlobalOptions>();
const stateDir = () => resolve(options().state ?? defaultStateDir());

/** Open the catalog for one command, read-only unless the command writes, and always close it. */
const withCatalog = (readonly: boolean, run: (catalog: Catalog) => void): void => {
  const catalog = new Catalog(stateDir(), { readonly });
  try {
    run(catalog);
  } finally {
    catalog.close();
  }
};

const printConversation = (snapshot: ConversationSnapshot): void => {
  const conv = snapshot.tables.conversations[0];
  if (!conv) throw new Error(`conversation ${snapshot.conversation_id} has no catalog row`);
  out(
    `conversation ${conv.id}  started ${conv.started_at}  status ${conv.status}  cutoff seq ${snapshot.cutoff_sequence}`,
  );
  out(`provenance:`);
  for (const entry of snapshot.tables.provenance_entries)
    out(
      `  ${entry.role}: ${entry.availability}${entry.version ? ` v=${entry.version}` : ""}${entry.artifact_id ? ` artifact=${entry.artifact_id}` : ""}${entry.reason ? ` (${entry.reason})` : ""}`,
    );
  for (const execution of snapshot.tables.executions)
    out(
      `execution ${execution.id} task=${execution.task_id} epoch=${execution.execution_epoch} model requested=${execution.requested_model} reported=${execution.reported_model ?? "unreported"} effort requested=${execution.requested_effort} reported=${execution.reported_effort ?? "unverified"} status=${execution.status}`,
    );
  for (const task of taskViews(snapshot)) {
    out(`\n== task ${task.id} [${task.status}] ${task.created_at}`);
    out(`user> ${task.text}`);
    out(`agent${task.partial ? " (partial)" : ""}> ${task.assistant_text || "(no text)"}`);
    for (const call of task.tool_calls)
      out(
        `  tool ${call.tool_identity} call=${call.runtime_call_id} rev=${call.binding_revision} policy=${call.policy} status=${call.status}${call.detail ? ` (${call.detail})` : ""} approvals=${JSON.stringify(call.approvals.map((approval) => `${approval.id}:${approval.status}`))}`,
      );
    if (task.interruption) out(`  interruption: ${JSON.stringify(task.interruption)}`);
    for (const event of task.errors) out(`  ${event.type}: ${event.payload}`);
  }
  out(`\ndiagnostics:`);
  for (const diagnostics of diagnosticsViews(snapshot))
    out(
      `  ${diagnostics.received_at} client=${diagnostics.client_id} ${diagnostics.freshness} ${JSON.stringify(diagnostics.state).slice(0, 160)}`,
    );
  if (snapshot.unresolved_references.length)
    out(`unresolved references: ${JSON.stringify(snapshot.unresolved_references)}`);
};

const debug = program.command("debug").allowExcessArguments();

debug
  .command("conversations")
  .allowExcessArguments()
  .action(() =>
    withCatalog(true, (catalog) => {
      const list = listConversations(catalog);
      if (options().json) out(list);
      else
        for (const conversation of list)
          out(
            `${conversation.started_at}  ${conversation.id}  ${conversation.status}  tasks=${conversation.task_count}  events=${conversation.last_sequence}`,
          );
    }),
  );

debug
  .command("conversation <conversation-id>")
  .allowExcessArguments()
  .action((conversationId: string) =>
    withCatalog(true, (catalog) => {
      const snapshot = snapshotConversation(catalog, conversationId);
      if (options().json) out(snapshot);
      else printConversation(snapshot);
    }),
  );

debug
  .command("artifacts <conversation-id>")
  .allowExcessArguments()
  .action((conversationId: string) =>
    withCatalog(true, (catalog) => {
      const snapshot = snapshotConversation(catalog, conversationId);
      if (options().json) {
        out({
          artifacts: snapshot.tables.artifacts,
          links: snapshot.tables.artifact_links,
          dependencies: snapshot.tables.artifact_dependencies,
          objects: snapshot.tables.objects,
        });
        return;
      }
      for (const artifact of snapshot.tables.artifacts)
        out(
          `${artifact.id}  ${artifact.kind}  ${artifact.logical_name}  ${artifact.capture_status}  ${artifact.byte_size ?? "-"}B  ${artifact.object_digest ?? "no object"}${artifact.capture_reason ? `  (${artifact.capture_reason})` : ""}`,
        );
      out(
        `links: ${snapshot.tables.artifact_links.length}, dependencies: ${snapshot.tables.artifact_dependencies.length}, objects: ${snapshot.tables.objects.length}`,
      );
    }),
  );

debug
  .command("export <conversation-id>")
  .allowExcessArguments()
  .action((conversationId: string) => {
    const { output } = options();
    if (!output) usage();
    withCatalog(false, (catalog) => {
      const result = exportConversation(catalog, conversationId, resolve(output));
      out(
        `exported to ${result.directory}; complete=${result.manifest.complete}; events=${result.manifest.record_counts.events}; objects=${result.manifest.objects.included}${result.manifest.partial_reasons.length ? `; partial: ${result.manifest.partial_reasons.join(", ")}` : ""}`,
      );
    });
  });

debug
  .command("verify <export-directory>")
  .allowExcessArguments()
  .action((exportDirectory: string) => {
    const result = verifyExport(resolve(exportDirectory));
    out(result);
    process.exit(result.ok ? 0 : 1);
  });

debug
  .command("reconcile")
  .allowExcessArguments()
  .action(() => withCatalog(false, (catalog) => out(reconcileObjects(catalog))));

program.parse();
