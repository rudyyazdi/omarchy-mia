import { match } from "ts-pattern";
import { sha256Hex } from "@mia/protocol";
import {
  capturedInDebugMode,
  watchEntriesAfter,
  type WatchEntry,
  type WatchParent,
  type WatchRows,
} from "@mia/records";
import {
  conversationView,
  eventView,
  mcpView,
  taskView,
  toolCallView,
  type NodeView,
} from "./watch-render.ts";

/** The nodes of the tree a page shows as sections of their own. */
type NodeKind = Exclude<WatchEntry["kind"], "event">;
/**
 * The nodes whose header the engine can change after it was shown. An MCP message is one event, which never
 * changes, so like an event it is sent once, when its sequence is new.
 */
type HeaderKind = Exclude<NodeKind, "mcp">;

/**
 * What the watch server sends a page, one per Server-Sent Event. A `node` message adds the node under `parent`
 * or, when the page already has it, replaces its header: the engine changes some rows with no event of their
 * own (a call's status and detail, approvals a finished task expires), so a header shown earlier is sent again
 * once it changed.
 */
export type WatchMessage =
  | { op: "conversation"; view: NodeView }
  | { op: "node"; id: string; parent: string; kind: NodeKind; view: NodeView }
  | { op: "event"; parent: string; view: NodeView }
  | { op: "stopped"; message: string };

/**
 * What one page has been sent: every entry up to `sequence`, and a digest of each header as it was sent. The
 * digests are replaced on every poll, so they never outgrow the one read of the conversation a poll holds.
 */
export interface Sent {
  sequence: number;
  headers: ReadonlyMap<string, string>;
}

export const NOTHING_SENT: Sent = { sequence: -1, headers: new Map() };

const CONVERSATION_NODE = "conversation";

const nodeId = (parent: WatchParent): string =>
  match(parent)
    .with({ level: "conversation" }, () => CONVERSATION_NODE)
    .with({ level: "task" }, ({ task_id }) => `task:${task_id}`)
    .with({ level: "tool_call" }, ({ tool_call_id }) => `tool_call:${tool_call_id}`)
    .exhaustive();

/** An MCP message node's id: its event's, which no other node shares. */
const mcpNodeId = (eventId: string): string => `mcp:${eventId}`;

const digest = (view: NodeView): string => sha256Hex(JSON.stringify(view));

/** A node's header and the id the page knows it by. */
const nodeOf = (
  entry: WatchEntry & { kind: HeaderKind },
  debugMode: boolean,
): { id: string; view: NodeView } =>
  match(entry)
    .with({ kind: "task" }, ({ task, executions }) => ({
      id: nodeId({ level: "task", task_id: task.id }),
      view: taskView(task, executions),
    }))
    .with({ kind: "tool_call" }, ({ tool_call, approvals }) => ({
      id: nodeId({ level: "tool_call", task_id: tool_call.task_id, tool_call_id: tool_call.id }),
      view: toolCallView(tool_call, approvals, debugMode),
    }))
    .exhaustive();

/** The message for an entry that never changes once recorded (an event or an MCP message), or null for a header. */
const unchangingMessage = (entry: WatchEntry): WatchMessage | null =>
  match(entry)
    .with({ kind: "event" }, ({ parent, event }): WatchMessage => ({
      op: "event",
      parent: nodeId(parent),
      view: eventView(event),
    }))
    .with({ kind: "mcp" }, ({ parent, mcp }): WatchMessage => ({
      op: "node",
      id: mcpNodeId(mcp.event.id),
      parent: nodeId(parent),
      kind: "mcp",
      view: mcpView(mcp),
    }))
    .with({ kind: "task" }, { kind: "tool_call" }, () => null)
    .exhaustive();

/**
 * The messages that bring a page that was sent `sent` up to date with `rows`, in the order to send them, and
 * what it has been sent once they all are. The caller adopts the new `sent` only after sending every message:
 * a task, its first event and a tool call can share one sequence, so a sequence is sent only once all of its
 * entries are.
 *
 * Headers are rendered up front, since `sent` needs every one of them; events, the bulk of a conversation, are
 * rendered one at a time as `messages` is iterated, so a page's first poll never holds its whole history as HTML.
 */
export const messagesAfter = (
  rows: WatchRows,
  sent: Sent,
): { messages: Iterable<WatchMessage>; sent: Sent } => {
  const conversation = rows.conversations[0];
  if (!conversation) throw new Error("the rows hold no conversation");
  const entries = watchEntriesAfter(rows, -1);
  const debugMode = capturedInDebugMode(rows);
  const headers = new Map<string, string>();
  /** Records a header and reports whether the page lacks it: the node is new, or its row changed. */
  const changed = (id: string, view: NodeView, isNew: boolean): boolean => {
    const current = digest(view);
    headers.set(id, current);
    return isNew || sent.headers.get(id) !== current;
  };
  const header = conversationView(conversation, debugMode);
  const sendHeader = changed(CONVERSATION_NODE, header, false);
  /** The node messages to send, by entry: at most one per task and tool call. */
  const nodeMessages = new Map<WatchEntry, WatchMessage>();
  for (const entry of entries) {
    if (entry.kind === "event" || entry.kind === "mcp") continue;
    const { id, view } = nodeOf(entry, debugMode);
    if (changed(id, view, entry.sequence > sent.sequence))
      nodeMessages.set(entry, {
        op: "node",
        id,
        parent: nodeId(entry.parent),
        kind: entry.kind,
        view,
      });
  }
  const sequence = entries.reduce((last, entry) => Math.max(last, entry.sequence), sent.sequence);
  const lazy = {
    *messages(): Generator<WatchMessage, undefined, undefined> {
      if (sendHeader) yield { op: "conversation", view: header };
      for (const entry of entries) {
        const node = nodeMessages.get(entry);
        if (node) yield node;
        else if (entry.sequence > sent.sequence) {
          const message = unchangingMessage(entry);
          if (message) yield message;
        }
      }
      return undefined;
    },
  };
  return { messages: lazy.messages(), sent: { sequence, headers } };
};

/** One Server-Sent Event carrying `message`; JSON holds no raw line break, so it is one `data` line. */
export const sseRecord = (message: WatchMessage): string => `data: ${JSON.stringify(message)}\n\n`;
