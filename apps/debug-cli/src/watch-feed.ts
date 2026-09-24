import { match } from "ts-pattern";
import { sha256Hex } from "@mia/protocol";
import { watchEntriesAfter, type WatchEntry, type WatchParent, type WatchRows } from "@mia/records";
import {
  conversationView,
  eventView,
  taskView,
  toolCallView,
  type NodeView,
} from "./watch-render.ts";

/** The nodes of the tree that have a header of their own, which the engine can change after it was shown. */
type NodeKind = Exclude<WatchEntry["kind"], "event">;

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

const digest = (view: NodeView): string => sha256Hex(JSON.stringify(view));

/**
 * The messages that bring a page that was sent `sent` up to date with `rows`, in the order to send them, and
 * what it has been sent once they all are. The caller adopts the new `sent` only after sending every message:
 * a task, its first event and a tool call can share one sequence, so a sequence is sent only once all of its
 * entries are.
 */
export const messagesAfter = (
  rows: WatchRows,
  sent: Sent,
): { messages: WatchMessage[]; sent: Sent } => {
  const conversation = rows.conversations[0];
  if (!conversation) throw new Error("the rows hold no conversation");
  const messages: WatchMessage[] = [];
  const headers = new Map<string, string>();
  let sequence = sent.sequence;
  /** Records a header and reports whether the page lacks it: the node is new, or its row changed. */
  const changed = (id: string, view: NodeView, isNew: boolean): boolean => {
    const current = digest(view);
    headers.set(id, current);
    return isNew || sent.headers.get(id) !== current;
  };
  const header = conversationView(conversation);
  if (changed(CONVERSATION_NODE, header, false))
    messages.push({ op: "conversation", view: header });
  const node = (entry: WatchEntry & { kind: NodeKind }, view: NodeView, self: WatchParent) => {
    const id = nodeId(self);
    const parent = nodeId(entry.parent);
    if (changed(id, view, entry.sequence > sent.sequence))
      messages.push({ op: "node", id, parent, kind: entry.kind, view });
  };
  for (const entry of watchEntriesAfter(rows, -1)) {
    sequence = Math.max(sequence, entry.sequence);
    match(entry)
      .with({ kind: "task" }, (task) =>
        node(task, taskView(task.task, task.executions), { level: "task", task_id: task.task.id }),
      )
      .with({ kind: "tool_call" }, (call) =>
        node(call, toolCallView(call.tool_call, call.approvals), {
          level: "tool_call",
          task_id: call.tool_call.task_id,
          tool_call_id: call.tool_call.id,
        }),
      )
      .with({ kind: "event" }, (event) => {
        if (event.sequence > sent.sequence)
          messages.push({
            op: "event",
            parent: nodeId(event.parent),
            view: eventView(event.event),
          });
      })
      .exhaustive();
  }
  return { messages, sent: { sequence, headers } };
};

/** One Server-Sent Event carrying `message`; JSON holds no raw line break, so it is one `data` line. */
export const sseRecord = (message: WatchMessage): string => `data: ${JSON.stringify(message)}\n\n`;
