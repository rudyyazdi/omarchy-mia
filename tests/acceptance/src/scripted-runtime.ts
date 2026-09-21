import type {
  AdapterEvent,
  PermissionDecision,
  PermissionRequest,
  RuntimeCancellation,
  TurnHandle,
  TurnOptions,
  TurnResult,
} from "@mia/agent-adapter";
import type { TurnRunner } from "@mia/server";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Scripted adapter substitute. The test drives each turn explicitly: emit runtime events, raise permission
 * requests exactly as the bridge would, and end the turn. Interruption behaves like SIGKILL by default
 * (pending prompts are abandoned, the turn ends as killed); `survivesInterrupt` keeps the runtime alive so
 * the action gate can be exercised after closure.
 */
export class ScriptedTurn {
  private resolveResult!: (r: TurnResult) => void;
  readonly result: Promise<TurnResult>;
  readonly pendingAbandons: AbortController[] = [];
  readonly decisions: Array<{ request: PermissionRequest; decision: PermissionDecision }> = [];
  interrupted = false;
  survivesInterrupt = false;
  private ended = false;
  private turnCounter = 0;

  constructor(readonly options: TurnOptions) {
    this.result = new Promise<TurnResult>((r) => {
      this.resolveResult = r;
    });
    mkdirSync(options.runtimeDir, { recursive: true });
  }

  emit(event: AdapterEvent): void {
    this.options.onEvent(event);
  }

  text(text: string): void {
    this.emit({ type: "text_delta", text, at: new Date().toISOString() });
  }

  init(model = "scripted-model"): void {
    this.emit({
      type: "runtime_init",
      init: {
        type: "system",
        subtype: "init",
        session_id: this.options.runtimeConversationId,
        model,
        tools: [],
        mcp_servers: [],
        permissionMode: "default",
      },
      at: new Date().toISOString(),
    });
  }

  propose(runtimeCallId: string, toolIdentity: string, args: unknown): void {
    this.emit({
      type: "tool_proposed",
      runtime_call_id: runtimeCallId,
      tool_identity: toolIdentity,
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
    const req: PermissionRequest = {
      tool_name: toolIdentity,
      input: args,
      tool_use_id: runtimeCallId,
      raw: { tool_name: toolIdentity, input: args, tool_use_id: runtimeCallId },
      received_at: new Date().toISOString(),
      abandoned: abandon.signal,
    };
    const decision = await this.options.permissionHandler(req);
    this.decisions.push({ request: req, decision });
    return decision;
  }

  toolResult(runtimeCallId: string, content: unknown, isError = false): void {
    this.emit({
      type: "tool_result",
      runtime_call_id: runtimeCallId,
      is_error: isError,
      content,
      raw: null,
      at: new Date().toISOString(),
    });
  }

  end(status: "completed" | "failed" = "completed", error: string | null = null): void {
    if (this.ended) return;
    this.ended = true;
    const streamLogPath = join(
      this.options.runtimeDir,
      `turn-${this.options.turnIndex}.stream.jsonl`,
    );
    writeFileSync(
      streamLogPath,
      JSON.stringify({ type: "scripted", turn: ++this.turnCounter }) + "\n",
    );
    const result: TurnResult = {
      status: this.interrupted && !this.survivesInterrupt ? "killed" : status,
      result:
        status === "completed" && !this.interrupted
          ? {
              type: "result",
              subtype: "success",
              is_error: false,
              session_id: this.options.runtimeConversationId,
              usage: { input_tokens: 1, output_tokens: 1 },
            }
          : null,
      exit: {
        code: this.interrupted ? null : status === "completed" ? 0 : 1,
        signal: this.interrupted ? "SIGKILL" : null,
      },
      error,
      streamLogPath,
      hookEvidencePath: join(this.options.runtimeDir, "hook-evidence.jsonl"),
      launch: {
        model: "scripted",
        effort: "medium",
        session_id: this.options.runtimeConversationId,
        resume: !this.options.firstTurn,
        builtin_tools: [],
        mcp_servers: ["d1", "mia_approval"],
        permission_prompt_tool: "mcp__mia_approval__request",
        settings: {},
        mcp_config: {},
      },
      init: null,
      interrupted: this.interrupted,
      runtimeCancellation: this.interrupted
        ? this.survivesInterrupt
          ? "unknown"
          : "forced_kill"
        : "not_needed",
    };
    this.emit({
      type: "runtime_exit",
      code: result.exit!.code,
      signal: result.exit!.signal,
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
        for (const a of this.pendingAbandons) a.abort();
        this.end("failed", "killed");
        return "forced_kill";
      },
    };
  }
}

export class ScriptedRuntime implements TurnRunner {
  readonly turns: ScriptedTurn[] = [];
  private waiters: Array<(t: ScriptedTurn) => void> = [];

  submitTurn(options: TurnOptions): TurnHandle {
    const turn = new ScriptedTurn(options);
    this.turns.push(turn);
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w(turn);
    return turn.handle();
  }

  /** Resolve with the next turn submitted by the engine. */
  nextTurn(): Promise<ScriptedTurn> {
    return new Promise((r) => this.waiters.push(r));
  }
}
