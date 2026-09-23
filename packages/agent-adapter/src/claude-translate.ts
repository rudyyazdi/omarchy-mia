import { match } from "ts-pattern";
import { redactValue } from "@mia/protocol";
import type { RuntimeEvent, RuntimeInit, TurnSummary } from "./runtime-events.ts";
import {
  InitMessageSchema,
  type InitMessage,
  type ResultMessage,
  type RuntimeMessage,
} from "./stream.ts";

const initOf = (message: InitMessage): RuntimeInit => ({ model: message.model, evidence: message });

const summaryOf = (message: ResultMessage): TurnSummary => ({
  isError: message.is_error,
  outcome: message.subtype,
  finalText: message.result,
  usage: message.usage,
  totalCostUsd: message.total_cost_usd,
  durationMs: message.duration_ms,
  durationApiMs: message.duration_api_ms,
  numTurns: message.num_turns,
  permissionDenials: message.permission_denials,
  evidence: message,
});

/**
 * Translates Claude Code stream-json messages into runtime events. It owns one piece of turn state:
 * a tool call's complete proposal is reported once, however many assistant messages repeat it.
 */
export class ClaudeTranslator {
  readonly #completedProposals = new Set<string>();

  /** `now` stamps each event as it is produced. */
  translate(message: RuntimeMessage, now: () => string): RuntimeEvent[] {
    return match(message)
      .with({ type: "system" }, (systemMessage): RuntimeEvent[] => {
        if (systemMessage.subtype !== "init") return [];
        // The union parsed InitMessageSchema first, so a system/init message that reached here satisfies it.
        const parsedInit = InitMessageSchema.safeParse(systemMessage);
        return parsedInit.success
          ? [{ type: "runtime_init", init: initOf(parsedInit.data), at: now() }]
          : [];
      })
      .with({ type: "stream_event" }, ({ event }): RuntimeEvent[] => {
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "text_delta" &&
          event.delta.text
        )
          return [{ type: "text_delta", text: event.delta.text, at: now() }];
        if (
          event.type === "content_block_start" &&
          event.content_block?.type === "tool_use" &&
          event.content_block.id &&
          event.content_block.name
        )
          return [
            {
              type: "tool_proposed",
              runtimeCallId: event.content_block.id,
              toolIdentity: event.content_block.name,
              arguments: event.content_block.input ?? {},
              complete: false,
              at: now(),
            },
          ];
        return [];
      })
      .with({ type: "assistant" }, (assistantMessage): RuntimeEvent[] => {
        const events: RuntimeEvent[] = [
          { type: "assistant_message", message: redactValue(assistantMessage.message), at: now() },
        ];
        for (const block of assistantMessage.message.content) {
          if (block.type !== "tool_use" || !block.id || !block.name) continue;
          if (this.#completedProposals.has(block.id)) continue;
          this.#completedProposals.add(block.id);
          events.push({
            type: "tool_proposed",
            runtimeCallId: block.id,
            toolIdentity: block.name,
            arguments: block.input ?? {},
            complete: true,
            at: now(),
          });
        }
        return events;
      })
      .with({ type: "user" }, (userMessage): RuntimeEvent[] => {
        const content = userMessage.message.content;
        if (!Array.isArray(content)) return [];
        return content.flatMap((block): RuntimeEvent[] =>
          block.type === "tool_result" && block.tool_use_id
            ? [
                {
                  type: "tool_result",
                  runtimeCallId: block.tool_use_id,
                  isError: block.is_error === true,
                  content: redactValue(block.content ?? null),
                  raw: redactValue(userMessage.tool_use_result ?? null),
                  at: now(),
                },
              ]
            : [],
        );
      })
      .with({ type: "result" }, (resultMessage): RuntimeEvent[] => [
        { type: "turn_result", summary: summaryOf(resultMessage), at: now() },
      ])
      .with({ type: "other" }, (): RuntimeEvent[] => [])
      .exhaustive();
  }
}
