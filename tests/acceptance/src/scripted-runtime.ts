import type {
  RuntimeEvent,
  PermissionDecision,
  PermissionRequest,
  RuntimeInit,
  TurnHandle,
  TurnOptions,
  TurnResult,
  TurnSummary,
} from "@mia/agent-adapter";
import type { RuntimeCancellation } from "@mia/protocol";
import type { TurnRunner } from "@mia/server";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { match } from "ts-pattern";

/**
 * Scripted adapter substitute. The test drives each turn explicitly: emit runtime events, raise permission
 * requests exactly as the bridge would, and end the turn. Interruption behaves like SIGKILL by default
 * (pending prompts are abandoned, the turn ends as killed); `survivesInterrupt` keeps the runtime alive so
 * the action gate can be exercised after closure. `transcriptAs` can leave a directory or a FIFO where the
 * turn's transcript belongs, so reading it fails.
 */
export class ScriptedTurn {
  private readonly resolveResult: (result: TurnResult) => void;
  readonly result: Promise<TurnResult>;
  readonly pendingAbandons: AbortController[] = [];
  readonly decisions: { request: PermissionRequest; decision: PermissionDecision }[] = [];
  interrupted = false;
  survivesInterrupt = false;
  transcriptAs: "file" | "directory" | "fifo" = "file";
  private ended = false;
  private turnCounter = 0;
  /** Like the real adapter, the last reported init becomes the TurnResult's. */
  private reportedInit: RuntimeInit | null = null;

  constructor(readonly options: TurnOptions) {
    const { promise, resolve } = Promise.withResolvers<TurnResult>();
    this.result = promise;
    this.resolveResult = resolve;
    mkdirSync(options.runtimeDir, { recursive: true });
  }

  emit(event: RuntimeEvent): void {
    this.options.onEvent(event);
  }

  /** What the real adapter would have launched: `resume` is whether it passes `--resume` or `--session-id`. */
  get launch(): TurnResult["launch"] {
    return {
      model: "scripted",
      effort: "medium",
      session_id: this.options.runtimeConversationId,
      resume: !this.options.firstTurn,
      builtin_tools: [],
      mcp_servers: ["d1", "mia_approval"],
      permission_prompt_tool: "mcp__mia_approval__request",
      settings: {},
      mcp_config: {},
    };
  }

  text(text: string): void {
    this.emit({ type: "text_delta", text, at: new Date().toISOString() });
  }

  init(model = "scripted-model"): void {
    this.reportedInit = {
      model,
      evidence: { scripted: "init", session: this.options.runtimeConversationId, model },
    };
    this.emit({ type: "runtime_init", init: this.reportedInit, at: new Date().toISOString() });
  }

  propose(runtimeCallId: string, toolIdentity: string, args: unknown): void {
    this.emit({
      type: "tool_proposed",
      runtimeCallId,
      toolIdentity,
      arguments: args,
      complete: true,
      at: new Date().toISOString(),
    });
  }

  /** Raise a permission request exactly as the bridge would; resolves with Mia's decision. */
  async request(
    toolIdentity: string,
    args: unknown,
    runtimeCallId: string | undefined,
  ): Promise<PermissionDecision> {
    const abandon = new AbortController();
    this.pendingAbandons.push(abandon);
    const request: PermissionRequest = {
      toolName: toolIdentity,
      input: args,
      toolUseId: runtimeCallId,
      // The raw payload imitates the runtime's wire format, which is snake_case.
      raw: { tool_name: toolIdentity, input: args, tool_use_id: runtimeCallId },
      receivedAt: new Date().toISOString(),
      abandoned: abandon.signal,
    };
    const decision = await this.options.permissionHandler(request);
    this.decisions.push({ request, decision });
    return decision;
  }

  toolResult(runtimeCallId: string, content: unknown, isError = false): void {
    this.emit({
      type: "tool_result",
      runtimeCallId,
      isError,
      content,
      raw: null,
      at: new Date().toISOString(),
    });
  }

  /** Where this turn's hook evidence belongs: one file per turn, as the real launch names it. */
  get hookEvidencePath(): string {
    return join(this.options.runtimeDir, `turn-${this.options.turnIndex}.hooks.jsonl`);
  }

  end(status: "completed" | "failed" = "completed", error: string | null = null): void {
    if (this.ended) return;
    this.ended = true;
    const streamLogPath = join(
      this.options.runtimeDir,
      `turn-${this.options.turnIndex}.stream.jsonl`,
    );
    match(this.transcriptAs)
      .with("file", () =>
        writeFileSync(
          streamLogPath,
          JSON.stringify({ type: "scripted", turn: ++this.turnCounter }) + "\n",
        ),
      )
      .with("directory", () => mkdirSync(streamLogPath))
      .with("fifo", () => execFileSync("mkfifo", [streamLogPath]))
      .exhaustive();
    const exit = this.interrupted
      ? { code: null, signal: "SIGKILL" as const }
      : { code: status === "completed" ? 0 : 1, signal: null };
    let runtimeCancellation: RuntimeCancellation = "not_needed";
    if (this.interrupted) runtimeCancellation = this.survivesInterrupt ? "unknown" : "forced_kill";
    // Like the real adapter, a summary is only returned after it was reported as a turn_result event.
    const summary: TurnSummary | null =
      status === "completed" && !this.interrupted
        ? {
            isError: false,
            outcome: "success",
            usage: { input_tokens: 1, output_tokens: 1 },
            totalCostUsd: 0,
            durationMs: 5,
            numTurns: 1,
            evidence: { scripted: "result", session: this.options.runtimeConversationId },
          }
        : null;
    if (summary) this.emit({ type: "turn_result", summary, at: new Date().toISOString() });
    const result: TurnResult = {
      status: this.interrupted && !this.survivesInterrupt ? "killed" : status,
      summary,
      exit,
      error,
      streamLogPath,
      hookEvidencePath: this.hookEvidencePath,
      launch: this.launch,
      init: this.reportedInit,
      interrupted: this.interrupted,
      runtimeCancellation,
    };
    this.emit({
      type: "runtime_exit",
      code: exit.code,
      signal: exit.signal,
      at: new Date().toISOString(),
    });
    this.resolveResult(result);
  }

  handle(): TurnHandle {
    return {
      pid: 4242,
      result: this.result,
      interrupt: async (): Promise<RuntimeCancellation> => {
        this.interrupted = true;
        if (this.survivesInterrupt) return "unknown";
        // SIGKILL: connections drop, held prompts are abandoned, the process is gone.
        for (const abandon of this.pendingAbandons) abandon.abort();
        this.end("failed", "killed");
        return "forced_kill";
      },
    };
  }
}

export class ScriptedRuntime implements TurnRunner {
  readonly turns: ScriptedTurn[] = [];
  private waiters: ((turn: ScriptedTurn) => void)[] = [];

  submitTurn(options: TurnOptions): TurnHandle {
    const turn = new ScriptedTurn(options);
    this.turns.push(turn);
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter(turn);
    return turn.handle();
  }

  /** Resolve with the next turn submitted by the engine. */
  nextTurn(): Promise<ScriptedTurn> {
    const { promise, resolve } = Promise.withResolvers<ScriptedTurn>();
    this.waiters.push(resolve);
    return promise;
  }
}
