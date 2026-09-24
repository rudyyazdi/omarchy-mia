import type { PermissionDecision } from "@mia/agent-adapter";
import type { EventPayload, ServerEventType } from "@mia/protocol";

/** A client-facing event as a correlated type/payload pair, so the envelope needs no assertion. */
export type OutgoingEvent = {
  [T in ServerEventType]: { type: T; payload: EventPayload<T> };
}[ServerEventType];

/**
 * What a recorded permission request answers the runtime: at once, or by holding its prompt, under the approval the
 * request recorded for call `callId`, until the user decides.
 */
export type PermissionAnswer =
  | { kind: "answer"; decision: PermissionDecision }
  | { kind: "hold"; approvalId: string; callId: string };

/** The turn a task submission starts: its task's, with the runtime prompt the submission composed. */
export interface TurnStart {
  taskId: string;
  prompt: string;
}

/**
 * One thing the engine does once a transition's records have committed and its state has moved on, as data: what a
 * transition decides can then be returned by a pure `decide` and performed by the kernel. When and in what order
 * they are performed, and what a throwing one leaves standing, is `Engine.commit`'s to say.
 *
 * - `deliver_event`: send a recorded event to the active connection. It carries the id the event was recorded
 *   under, and finds the sequence the catalog gave it among the commit's changes by that id.
 * - `notify_tool_call`: send a tool call's progress, which is never recorded (the durable evidence is the events
 *   under it), so it has no sequence. Its payload is the call as the commit leaves it.
 * - `answer_prompt`: answer the runtime's prompt held under an approval, if it is still held; one already answered
 *   (abandoned, or denied at turn end) drops this answer.
 * - `answer_permission`: answer the runtime's permission request that the transition decided. Only a permission
 *   request's transition queues one, and exactly one, so it names no request: the boundary that is committing that
 *   request takes the answer. It holds a prompt only once the commit has returned, so a request whose records did
 *   not commit is never held, and is denied instead.
 * - `interrupt_runtime`: interrupt the runtime running a task's turn, if that task is still the active one.
 * - `start_turn`: start the runtime on a submitted task's turn, with the prompt the submission composed. Only a task
 *   submission's transition queues one, and exactly one, last: the boundary that is committing that submission takes
 *   the prompt and starts the turn once the commit has returned, so a submission whose records did not commit starts
 *   nothing, and an adapter that throws as it starts the turn fails the command, not a delivery.
 */
export type EngineEffect =
  | { kind: "deliver_event"; eventId: string; event: OutgoingEvent }
  | { kind: "notify_tool_call"; payload: EventPayload<"tool_call"> }
  | { kind: "answer_prompt"; approvalId: string; decision: PermissionDecision }
  | { kind: "answer_permission"; answer: PermissionAnswer }
  | { kind: "interrupt_runtime"; taskId: string }
  | { kind: "start_turn"; turn: TurnStart };
