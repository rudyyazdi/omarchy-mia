import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, ServerEventSchema, ServerEventTypeSchema } from "./messages.ts";

const ack = (payload: Record<string, unknown>) => ({
  protocol_version: PROTOCOL_VERSION,
  message_id: "event_1",
  type: "ack",
  conversation_id: null,
  sequence: null,
  server_time: "2026-01-01T00:00:00.000Z",
  payload: { command_id: "cmd_1", ...payload },
});

const error = { code: "busy", message: "a task is running" };

describe("ack payload", () => {
  it.each([
    { name: "a bare accepted ack", payload: { disposition: "accepted" } },
    {
      name: "an accepted duplicate with a result",
      payload: { disposition: "accepted", result: { task_id: "task_1" }, duplicate: true },
    },
    { name: "a rejected ack with its error", payload: { disposition: "rejected", error } },
    {
      name: "a failed duplicate with its error",
      payload: { disposition: "failed", error, duplicate: true },
    },
    {
      name: "a field this version does not know",
      payload: { disposition: "accepted", retry_after: 1 },
    },
  ])("accepts $name", ({ payload }) => {
    expect(ServerEventSchema.safeParse(ack(payload)).success).toBe(true);
  });

  it.each([
    { name: "a rejected ack without an error", payload: { disposition: "rejected" } },
    { name: "a failed ack without an error", payload: { disposition: "failed" } },
    { name: "an accepted ack with an error", payload: { disposition: "accepted", error } },
    {
      name: "a rejected ack with a result",
      payload: { disposition: "rejected", error, result: { task_id: "task_1" } },
    },
  ])("refuses $name", ({ payload }) => {
    expect(ServerEventSchema.safeParse(ack(payload)).success).toBe(false);
  });
});

describe("server event type", () => {
  it.each(["ack", "task_finished", "error"])("reads back %s", (type) => {
    expect(ServerEventTypeSchema.safeParse(type).success).toBe(true);
  });

  it.each(["malformed_event", "runtime_stderr", "constructor", "__proto__", 7])(
    "refuses %s, which is not a server event type",
    (type) => {
      expect(ServerEventTypeSchema.safeParse(type).success).toBe(false);
    },
  );
});
