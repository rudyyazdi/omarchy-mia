import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, ServerEventSchema } from "./messages.ts";

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
    { disposition: "accepted" },
    { disposition: "accepted", result: { task_id: "task_1" }, duplicate: true },
    { disposition: "rejected", error },
    { disposition: "failed", error, duplicate: true },
  ])("accepts $disposition with the fields its disposition allows", (payload) => {
    expect(ServerEventSchema.safeParse(ack(payload)).success).toBe(true);
  });

  it.each([
    { disposition: "rejected" },
    { disposition: "failed" },
    { disposition: "accepted", error },
    { disposition: "rejected", error, result: { task_id: "task_1" } },
  ])("refuses $disposition when its error or result contradicts the disposition", (payload) => {
    expect(ServerEventSchema.safeParse(ack(payload)).success).toBe(false);
  });
});
