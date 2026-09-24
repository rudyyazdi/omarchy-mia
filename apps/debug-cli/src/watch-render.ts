// The HTML `mia debug watch` shows for each node of a conversation's tree. Everything shown passes
// through the protocol's redaction first and is escaped after, so the page only places fragments.
import {
  isRecord,
  redactSensitivePairs,
  redactString,
  redactValue,
  type ToolCallStatus,
} from "@mia/protocol";
import { match } from "ts-pattern";
import { writesBodyLog, type BodyLogServers } from "@mia/agent-adapter";
import type {
  ApprovalRow,
  ConversationRow,
  EventRow,
  ExecutionRow,
  McpEventType,
  TaskRow,
  ToolCallRow,
  WatchMcpMessage,
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
  // By code point, so a cut never splits a surrogate pair, and no further than the cut: an MCP body can be megabytes.
  const points = Iterator.from(text)
    .take(length + 1)
    .toArray();
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

/**
 * What the watch knows about which detail a conversation's capture left out: whether it was captured in debug mode
 * (`capturedInDebugMode`), and which of its MCP servers write a body log, from its retained tool contracts.
 */
export interface Capture {
  debugMode: boolean;
  bodyLogServers: BodyLogServers;
}

/**
 * Why a dispatched call's MCP request and response are missing, marked where their nodes would appear so the page
 * never shows a silent gap (issue #6), or null where debug mode records them. Only a server that writes a body log
 * (the controlled MCP fixture) has its bodies recorded, and only in debug mode: a real server's are never recorded,
 * so "(debug mode off)" would promise what `--debug` does not add. A call denied, blocked or cancelled before
 * dispatch never reached a server and has no bodies. A dispatched call is always an MCP call, since only listed
 * `mcp__…` identities are permitted and the runtime is launched with no built-in tools.
 */
const mcpBodiesGap = (call: ToolCallRow, capture: Capture): string | null => {
  if (call.dispatch_event_id === null) return null;
  return match(capture.bodyLogServers)
    .with({ status: "known" }, ({ servers }) => {
      if (!writesBodyLog(servers, call.tool_identity)) return "not recorded";
      return capture.debugMode ? null : "not recorded (debug mode off)";
    })
    .with(
      { status: "unknown" },
      ({ reason }) =>
        `not recorded unless shown below (whether its server records bodies is unknown: ${reason})`,
    )
    .exhaustive();
};

const gapHtml = (gap: string | null): string =>
  gap === null ? "" : `<p class="not-recorded">MCP request and response: ${shown(gap)}</p>`;

/** `debugMode` is whether the conversation was captured in debug mode (`capturedInDebugMode`). */
export const conversationView = (conversation: ConversationRow, debugMode: boolean): NodeView => ({
  summary: `<b>Conversation</b> ${shown(conversation.id)} ${statusHtml(conversation.status)} started ${shown(conversation.started_at)} <span class="capture">debug mode ${debugMode ? "on" : "off"}</span>`,
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

export const toolCallView = (
  call: ToolCallRow,
  approvals: readonly ApprovalRow[],
  capture: Capture,
): NodeView => {
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
      gapHtml(mcpBodiesGap(call, capture)),
    ].join(""),
  };
};

const MCP_LABEL: Record<McpEventType, string> = {
  mcp_request: "MCP request",
  mcp_response: "MCP response",
};

/** Every field of an event row, its payload decoded. */
const eventFieldsHtml = (event: EventRow): string =>
  fieldsHtml({ ...event, payload: parseStored(event.payload) });

/**
 * One MCP message of a call: its body on the collapsed line, clipped, or why no body was recorded, and the whole
 * event when expanded. The body was redacted when it was recorded, and is redacted again here like everything shown.
 */
export const mcpView = ({ type, event, content }: WatchMcpMessage): NodeView => ({
  summary: `<b>${MCP_LABEL[type]}</b> ${match(content)
    .with(
      { status: "recorded" },
      ({ body }) => `<code>${escapeHtml(clipped(JSON.stringify(redactValue(body)), 160))}</code>`,
    )
    .with(
      { status: "unrecorded" },
      ({ reason }) => `<span class="not-recorded">not recorded: ${shown(reason)}</span>`,
    )
    .exhaustive()} <time>${shown(event.received_at)}</time>`,
  body: eventFieldsHtml(event),
});

export const eventView = (event: EventRow): NodeView => ({
  summary: `#${event.sequence} ${shown(event.type)} <time>${shown(event.received_at)}</time>`,
  body: eventFieldsHtml(event),
});
