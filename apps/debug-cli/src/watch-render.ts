// The HTML `mia debug watch` shows for each node of a conversation's tree. Everything shown passes
// through the protocol's redaction first and is escaped after, so the page only places fragments.
import {
  isRecord,
  redactSensitivePairs,
  redactString,
  redactValue,
  type ToolCallStatus,
} from "@mia/protocol";
import type {
  ApprovalRow,
  ConversationRow,
  EventRow,
  ExecutionRow,
  TaskRow,
  ToolCallRow,
} from "@mia/records";

/** What a page shows for one node: the line it shows collapsed, and what expanding it reveals. */
export interface NodeView {
  summary: string;
  body: string;
}

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => ENTITIES[char] ?? char);

/** Redacted and escaped: the only way text from the catalog reaches the page. */
const shown = (text: string): string => escapeHtml(redactString(text));

/** The first `length` characters of already-redacted text, so a cut never splits a secret out of view. */
const clipped = (text: string, length = 80): string => {
  // By code point, so a cut never splits a surrogate pair.
  const points = Array.from(text);
  return points.length > length ? `${points.slice(0, length).join("")}…` : text;
};

/** A stored JSON column as a value; text that does not parse (a runtime line cut short) stays text. */
const parseStored = (text: string | null): unknown => {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return redactSensitivePairs(text);
  }
};

const valueHtml = (value: unknown): string => {
  if (value === null || value === undefined) return "<i>none</i>";
  if (typeof value === "string") return escapeHtml(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
};

/** Every field of a row, JSON columns decoded, redacted as one value so sensitive keys go whole. */
const fieldsHtml = (fields: Record<string, unknown>): string => {
  const redacted = redactValue(fields);
  if (!isRecord(redacted)) return valueHtml(redacted);
  return `<dl>${Object.entries(redacted)
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${valueHtml(value)}</dd>`)
    .join("")}</dl>`;
};

/** Every status a node shows, as the rows declare them. */
type ShownStatus =
  ConversationRow["status"] | TaskRow["status"] | ToolCallRow["status"] | ApprovalRow["status"];

const statusHtml = (status: ShownStatus): string =>
  `<span class="status status-${escapeHtml(status)}">${escapeHtml(status)}</span>`;

/** The statuses that mean a call did not run to completion, marked so they stand out in a long list. */
const STOPPED_CALLS: ReadonlySet<ToolCallStatus> = new Set([
  "denied",
  "blocked_gate",
  "invalidated",
  "failed",
  "cancelled",
]);

export const conversationView = (conversation: ConversationRow): NodeView => ({
  summary: `<b>Conversation</b> ${shown(conversation.id)} ${statusHtml(conversation.status)} started ${shown(conversation.started_at)}`,
  body: fieldsHtml({ ...conversation }),
});

export const taskView = (task: TaskRow, executions: readonly ExecutionRow[]): NodeView => {
  const executionIds = executions.map((execution) => execution.id).join(", ") || "none";
  return {
    summary: `<b>Task</b> ${shown(task.id)} “${escapeHtml(clipped(redactString(task.text)))}” ${statusHtml(task.status)} <span class="ids">ids: task ${shown(task.id)} / execution ${shown(executionIds)} / client ${shown(task.client_id ?? "none")}</span>`,
    body: [
      fieldsHtml({ ...task }),
      ...executions.map(
        (execution) =>
          `<h4>execution ${shown(execution.id)}</h4>${fieldsHtml({
            ...execution,
            effort_evidence: parseStored(execution.effort_evidence),
            usage: parseStored(execution.usage),
          })}`,
      ),
    ].join(""),
  };
};

export const toolCallView = (call: ToolCallRow, approvals: readonly ApprovalRow[]): NodeView => {
  const args = JSON.stringify(redactValue(parseStored(call.redacted_arguments)));
  const outcome = call.detail
    ? ` ${STOPPED_CALLS.has(call.status) ? "✗ " : ""}${escapeHtml(clipped(redactString(call.detail), 160))}`
    : "";
  const approval = approvals.at(-1);
  return {
    summary: `<b>Model: tool call</b> ${shown(call.tool_identity)} <code>${escapeHtml(clipped(args))}</code> ${statusHtml(call.status)}${outcome}${approval ? ` <span class="approval">approval ${statusHtml(approval.status)}${approval.reason ? ` ${shown(approval.reason)}` : ""}</span>` : ""}`,
    body: [
      fieldsHtml({ ...call, redacted_arguments: parseStored(call.redacted_arguments) }),
      ...approvals.map((row) => `<h4>approval ${shown(row.id)}</h4>${fieldsHtml({ ...row })}`),
    ].join(""),
  };
};

export const eventView = (event: EventRow): NodeView => ({
  summary: `#${event.sequence} ${shown(event.type)} <time>${shown(event.received_at)}</time>`,
  body: fieldsHtml({ ...event, payload: parseStored(event.payload) }),
});
