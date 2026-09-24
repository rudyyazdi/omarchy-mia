import type { PermissionDecision } from "@mia/agent-adapter";
import type { EventPayload, ServerEventType } from "@mia/protocol";

/** A client-facing event as a correlated type/payload pair, so the envelope needs no assertion. */
export type OutgoingEvent = {
  [T in ServerEventType]: { type: T; payload: EventPayload<T> };
}[ServerEventType];

/**
 * One thing the engine does once a transition's records have committed and its state has moved on, as data: what a
 * transition decides can then be returned by a pure `decide` and performed by the kernel. Effects keep the order they
 * were queued in, and each is performed on its own, so one that throws leaves the records, the state and the rest
 * standing.
 *
 * - `deliver_event`: send a recorded event to the active connection. It carries the id the event was recorded
 *   under, and finds the sequence the catalog gave it among the commit's changes by that id.
 * - `notify_tool_call`: send a tool call's progress, which is never recorded (the durable evidence is the events
 *   under it), so it has no sequence. Its payload is the call as the commit leaves it.
 * - `answer_prompt`: answer the runtime's prompt held under an approval, if it is still held; one already answered
 *   (abandoned, or denied at turn end) drops this answer.
 * - `interrupt_runtime`: interrupt the runtime running a task's turn, if that task is still the active one.
 */
export type EngineEffect =
  | { kind: "deliver_event"; eventId: string; event: OutgoingEvent }
  | { kind: "notify_tool_call"; payload: EventPayload<"tool_call"> }
  | { kind: "answer_prompt"; approvalId: string; decision: PermissionDecision }
  | { kind: "interrupt_runtime"; taskId: string };
