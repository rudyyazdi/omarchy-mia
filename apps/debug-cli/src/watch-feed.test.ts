import { match } from "ts-pattern";
import { describe, expect, it } from "vitest";
import type { WatchRows } from "@mia/records";
import { messagesAfter, NOTHING_SENT, sseRecord, type WatchMessage } from "./watch-feed.ts";
import {
  approvalRow,
  conversationRow,
  eventRow,
  executionRow,
  taskRow,
  toolCallRow,
  watchRows,
} from "./watch-fixture.ts";

/** A conversation event, then a task whose first event shares a sequence with it, and a call of that task. */
const conversation = (): WatchRows =>
  watchRows({
    tasks: [taskRow()],
    executions: [executionRow()],
    tool_calls: [toolCallRow({ proposal_event_id: "e3" })],
    approvals: [approvalRow()],
    events: [
      eventRow({ sequence: 1, type: "conversation_started" }),
      eventRow({ sequence: 2, type: "task_submitted", task_id: "t1" }),
      eventRow({ sequence: 3, type: "tool_proposed", task_id: "t1", execution_id: "x1" }),
    ],
  });

/** What a message places and where: enough to check the order and the parents without the HTML. */
const placement = (message: WatchMessage): string =>
  match(message)
    .with({ op: "node" }, ({ id, parent }) => `node ${id} under ${parent}`)
    .with({ op: "event" }, ({ parent }) => `event under ${parent}`)
    .with({ op: "conversation" }, () => "conversation")
    .with({ op: "stopped" }, () => "stopped")
    .exhaustive();

describe("messagesAfter", () => {
  it("sends the conversation, then every node before its events, each under its parent", () => {
    const { messages, sent } = messagesAfter(conversation(), NOTHING_SENT);
    expect(messages.map(placement)).toEqual([
      "conversation",
      "event under conversation",
      "node task:t1 under conversation",
      "event under task:t1",
      "node tool_call:c1 under task:t1",
      "event under tool_call:c1",
    ]);
    expect(sent.sequence).toBe(3);
  });

  it("sends nothing again when nothing changed", () => {
    const rows = conversation();
    const { sent } = messagesAfter(rows, NOTHING_SENT);
    expect(messagesAfter(rows, sent)).toEqual({ messages: [], sent });
  });

  it("sends only the entries after the last sequence sent", () => {
    const rows = conversation();
    const { sent } = messagesAfter(rows, NOTHING_SENT);
    rows.events.push(eventRow({ sequence: 4, type: "text_delta", task_id: "t1" }));
    const next = messagesAfter(rows, sent);
    expect(next.messages.map(placement)).toEqual(["event under task:t1"]);
    expect(next.messages[0]).toMatchObject({ view: { summary: expect.stringContaining("#4 ") } });
    expect(next.sent.sequence).toBe(4);
  });

  // The engine changes these rows without recording an event, so only the re-sent header shows them.
  it.each<{ what: string; change: (rows: WatchRows) => WatchRows; id: string; shown: string }>([
    {
      what: "a call denied by policy",
      change: (rows) => ({
        ...rows,
        tool_calls: [toolCallRow({ proposal_event_id: "e3", status: "denied", detail: "policy" })],
      }),
      id: "tool_call:c1",
      shown: "✗ policy",
    },
    {
      what: "an approval expired at task end",
      change: (rows) => ({
        ...rows,
        approvals: [approvalRow({ status: "expired", reason: "task ended" })],
      }),
      id: "tool_call:c1",
      shown: "task ended",
    },
    {
      what: "an execution's usage",
      change: (rows) => ({
        ...rows,
        executions: [executionRow({ usage: '{"output_tokens":42}' })],
      }),
      id: "task:t1",
      shown: "42",
    },
  ])("re-sends the header of $what, once", ({ change, id, shown }) => {
    const { sent } = messagesAfter(conversation(), NOTHING_SENT);
    const changed = change(conversation());
    const next = messagesAfter(changed, sent);
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]).toMatchObject({ op: "node", id });
    expect(JSON.stringify(next.messages[0])).toContain(shown);
    expect(messagesAfter(changed, next.sent).messages).toEqual([]);
  });

  it("re-sends the conversation's header once its status changes", () => {
    const { sent } = messagesAfter(conversation(), NOTHING_SENT);
    const closed = { ...conversation(), conversations: [conversationRow({ status: "closed" })] };
    const next = messagesAfter(closed, sent);
    expect(next.messages.map(placement)).toEqual(["conversation"]);
    expect(next.messages[0]).toMatchObject({
      view: { summary: expect.stringContaining("closed") },
    });
  });
});

describe("sseRecord", () => {
  it("encodes a message as one data line, whatever line breaks its text holds", () => {
    const message: WatchMessage = {
      op: "event",
      parent: "conversation",
      view: { summary: "a\nb", body: "c\r\nd" },
    };
    const record = sseRecord(message);
    expect(record.endsWith("\n\n")).toBe(true);
    expect(record.slice(0, -2)).not.toMatch(/[\r\n]/);
    expect(JSON.parse(record.slice("data: ".length))).toEqual(message);
  });
});
