// Text renderings of catalog reads; each returns the lines to print so nothing here writes.
import type {
  ConversationSnapshot,
  ConversationSummary,
  DiagnosticsView,
  ExportManifest,
  TaskView,
} from "@mia/records";

export const formatConversationList = (list: ConversationSummary[]): string[] =>
  list.map(
    (conversation) =>
      `${conversation.started_at}  ${conversation.id}  ${conversation.status}  tasks=${conversation.task_count}  events=${conversation.last_sequence}`,
  );

/** The conversation, provenance and execution lines: everything printed before the first task. */
export const formatConversationHeader = (snapshot: ConversationSnapshot): string[] => {
  const conv = snapshot.tables.conversations[0];
  if (!conv) throw new Error(`conversation ${snapshot.conversation_id} has no catalog row`);
  return [
    `conversation ${conv.id}  started ${conv.started_at}  status ${conv.status}  cutoff seq ${snapshot.cutoff_sequence}`,
    `provenance:`,
    ...snapshot.tables.provenance_entries.map(
      (entry) =>
        `  ${entry.role}: ${entry.availability}${entry.version ? ` v=${entry.version}` : ""}${entry.artifact_id ? ` artifact=${entry.artifact_id}` : ""}${entry.reason ? ` (${entry.reason})` : ""}`,
    ),
    ...snapshot.tables.executions.map(
      (execution) =>
        `execution ${execution.id} task=${execution.task_id} epoch=${execution.execution_epoch} model requested=${execution.requested_model} reported=${execution.reported_model ?? "unreported"} effort requested=${execution.requested_effort} reported=${execution.reported_effort ?? "unverified"} status=${execution.status}`,
    ),
  ];
};

export const formatTask = (task: TaskView): string[] => [
  `\n== task ${task.id} [${task.status}] ${task.created_at}`,
  `user> ${task.text}`,
  `agent${task.partial ? " (partial)" : ""}> ${task.assistant_text || "(no text)"}`,
  ...task.tool_calls.map(
    (call) =>
      `  tool ${call.tool_identity} call=${call.runtime_call_id} rev=${call.binding_revision} policy=${call.policy} status=${call.status}${call.detail ? ` (${call.detail})` : ""} approvals=${JSON.stringify(call.approvals.map((approval) => `${approval.id}:${approval.status}`))}`,
  ),
  ...(task.interruption ? [`  interruption: ${JSON.stringify(task.interruption)}`] : []),
  ...task.errors.map((event) => `  ${event.type}: ${event.payload}`),
];

export const formatDiagnostics = (diagnostics: DiagnosticsView[]): string[] =>
  diagnostics.map(
    (view) =>
      `  ${view.received_at} client=${view.client_id} ${view.freshness} ${JSON.stringify(view.state).slice(0, 160)}`,
  );

export const formatUnresolved = (snapshot: ConversationSnapshot): string[] =>
  snapshot.unresolved_references.length
    ? [`unresolved references: ${JSON.stringify(snapshot.unresolved_references)}`]
    : [];

export const formatArtifacts = (snapshot: ConversationSnapshot): string[] => [
  ...snapshot.tables.artifacts.map(
    (artifact) =>
      `${artifact.id}  ${artifact.kind}  ${artifact.logical_name}  ${artifact.capture_status}  ${artifact.byte_size ?? "-"}B  ${artifact.object_digest ?? "no object"}${artifact.capture_reason ? `  (${artifact.capture_reason})` : ""}`,
  ),
  `links: ${snapshot.tables.artifact_links.length}, dependencies: ${snapshot.tables.artifact_dependencies.length}, objects: ${snapshot.tables.objects.length}`,
];

export const artifactsJson = (snapshot: ConversationSnapshot) => ({
  artifacts: snapshot.tables.artifacts,
  links: snapshot.tables.artifact_links,
  dependencies: snapshot.tables.artifact_dependencies,
  objects: snapshot.tables.objects,
});

export const formatExport = (result: {
  directory: string;
  manifest: Pick<ExportManifest, "complete" | "record_counts" | "partial_reasons"> & {
    objects: Pick<ExportManifest["objects"], "included">;
  };
}): string =>
  `exported to ${result.directory}; complete=${result.manifest.complete}; events=${result.manifest.record_counts.events}; objects=${result.manifest.objects.included}${result.manifest.partial_reasons.length ? `; partial: ${result.manifest.partial_reasons.join(", ")}` : ""}`;
