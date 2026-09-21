import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { match } from "ts-pattern";
import { z } from "zod";
import { errorMessage, redactString, redactValue } from "@mia/protocol";
import type { ApprovalBridge, PermissionHandler } from "./bridge.ts";
import type { RuntimeConfig } from "./config.ts";
import { prepareLaunch, type LaunchPlan } from "./launch.ts";
import {
  InitMessageSchema,
  LineSplitter,
  parseStreamLine,
  type InitMessage,
  type ResultMessage,
  type RuntimeMessage,
} from "./stream.ts";

export type AdapterEvent =
  | { type: "runtime_started"; pid: number; launch: LaunchPlan["description"]; at: string }
  | { type: "runtime_init"; init: InitMessage; at: string }
  | { type: "text_delta"; text: string; at: string }
  | {
      type: "tool_proposed";
      runtimeCallId: string;
      toolIdentity: string;
      arguments: unknown;
      complete: boolean;
      at: string;
    }
  | { type: "assistant_message"; message: unknown; at: string }
  | {
      type: "tool_result";
      runtimeCallId: string;
      isError: boolean;
      content: unknown;
      raw: unknown;
      at: string;
    }
  | { type: "turn_result"; result: ResultMessage; at: string }
  | { type: "runtime_stderr"; text: string; at: string }
  | { type: "malformed_event"; raw: string; error: string; at: string }
  | { type: "runtime_exit"; code: number | null; signal: NodeJS.Signals | null; at: string };

export interface TurnOptions {
  text: string;
  runtimeConversationId: string;
  firstTurn: boolean;
  runtimeDir: string;
  turnIndex: number;
  /** Defaults to config.agentPromptFile; the engine passes the conversation's retained snapshot. */
  agentPromptFile?: string;
  permissionHandler: PermissionHandler;
  onEvent: (event: AdapterEvent) => void;
}

/** not_needed: no interruption; forced_kill: SIGKILL delivered and exit observed; unknown: kill sent, exit not observed in time. */
export type RuntimeCancellation = "not_needed" | "forced_kill" | "unknown";

interface RuntimeExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface TurnResult {
  status: "completed" | "failed" | "killed";
  result: ResultMessage | null;
  exit: RuntimeExit | null;
  error: string | null;
  streamLogPath: string;
  hookEvidencePath: string;
  launch: LaunchPlan["description"];
  init: InitMessage | null;
  interrupted: boolean;
  runtimeCancellation: RuntimeCancellation;
}

export interface TurnHandle {
  readonly pid: number | undefined;
  readonly result: Promise<TurnResult>;
  /**
   * Kill the runtime process group (SIGKILL; see the note on interrupt below). Resolves once exit is observed, or
   * with "unknown" after EXIT_WAIT_MS; in that case the turn is finished anyway so the task cannot hang.
   */
  interrupt(): Promise<RuntimeCancellation>;
}

/** How long to wait for the killed process to exit before reporting the cancellation outcome as unknown. */
const EXIT_WAIT_MS = 5_000;
/** How long the turn result waits for a pending interrupt() to settle after the process exit is observed. */
const INTERRUPT_SETTLE_MS = 6_000;

/** Printed verbatim as a JSON report by the probe tool, hence snake_case. */
export interface StaticCapabilities {
  executable_resolved: string | null;
  runtime_version: string | null;
  flags_present: Record<string, boolean>;
  credential_source: "ANTHROPIC_API_KEY" | "claude_credentials_file" | "none_detected";
  node_version: string;
  adapter_version: string;
  errors: string[];
}

export const ADAPTER_VERSION = "0.1.0";
const REQUIRED_FLAGS = [
  "--output-format",
  "--include-partial-messages",
  "--effort",
  "--model",
  "--strict-mcp-config",
  "--mcp-config",
  "--settings",
  "--permission-mode",
  "--permission-prompt-tool",
  "--tools",
  "--append-system-prompt-file",
  "--session-id",
  "--resume",
];

/** Static checks: nothing here contacts a model. */
export const probeStaticCapabilities = (config: RuntimeConfig): StaticCapabilities => {
  const errors: string[] = [];
  const which = spawnSync("sh", ["-c", `command -v ${JSON.stringify(config.executable)}`], {
    encoding: "utf8",
  });
  const resolved = which.status === 0 ? which.stdout.trim() : null;
  if (!resolved) errors.push(`runtime executable "${config.executable}" not found on PATH`);
  let version: string | null = null;
  const flags: Record<string, boolean> = {};
  if (resolved) {
    const versionProbe = spawnSync(resolved, ["--version"], { encoding: "utf8", timeout: 20_000 });
    version = versionProbe.status === 0 ? versionProbe.stdout.trim() : null;
    if (!version)
      errors.push(
        `"${resolved} --version" failed: ${versionProbe.stderr?.trim() || versionProbe.error?.message || "unknown"}`,
      );
    const help =
      spawnSync(resolved, ["--help"], { encoding: "utf8", timeout: 20_000 }).stdout ?? "";
    for (const flag of REQUIRED_FLAGS) {
      // help abbreviates paired flags as --append-system-prompt[-file]
      const abbreviated = flag.replace(/-file$/, "[-file]");
      flags[flag] = help.includes(flag) || help.includes(abbreviated);
    }
    // --permission-prompt-tool is referenced in help text but not listed; presence in help is enough for the static probe.
    for (const [flag, present] of Object.entries(flags))
      if (!present) errors.push(`required flag ${flag} not present in --help`);
  }
  let credential: StaticCapabilities["credential_source"] = "none_detected";
  if (process.env.ANTHROPIC_API_KEY) credential = "ANTHROPIC_API_KEY";
  else if (existsSync(join(process.env.HOME ?? "", ".claude", ".credentials.json")))
    credential = "claude_credentials_file";
  if (credential === "none_detected")
    errors.push(
      "no runtime credential source detected (ANTHROPIC_API_KEY unset, ~/.claude/.credentials.json missing)",
    );
  return {
    executable_resolved: resolved,
    runtime_version: version,
    flags_present: flags,
    credential_source: credential,
    node_version: process.version,
    adapter_version: ADAPTER_VERSION,
    errors,
  };
};

/**
 * Claude Code adapter. One turn = one runtime process. The bridge is shared across turns and only
 * has a handler while a turn is active.
 */
export class ClaudeCodeAdapter {
  constructor(
    readonly config: RuntimeConfig,
    readonly bridge: ApprovalBridge,
  ) {}

  submitTurn(options: TurnOptions): TurnHandle {
    const launch = prepareLaunch({
      config: this.config,
      runtimeDir: options.runtimeDir,
      bridgeUrl: this.bridge.url,
      sessionId: options.runtimeConversationId,
      resume: !options.firstTurn,
      turnIndex: options.turnIndex,
      agentPromptFile: options.agentPromptFile ?? this.config.agentPromptFile,
    });
    const streamLogPath = join(
      options.runtimeDir,
      `turn-${String(options.turnIndex).padStart(3, "0")}.stream.jsonl`,
    );
    const now = () => new Date().toISOString();
    const emit = options.onEvent;

    let child: ChildProcess;
    try {
      // detached: the runtime becomes a process-group leader so an interruption can kill it and any helper
      // processes it spawned (e.g. stdio MCP servers) in one signal.
      child = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch (error) {
      return {
        pid: undefined,
        result: Promise.resolve({
          status: "failed",
          result: null,
          exit: null,
          error: `failed to spawn runtime: ${errorMessage(error)}`,
          streamLogPath,
          hookEvidencePath: launch.files.hookEvidence,
          launch: launch.description,
          init: null,
          interrupted: false,
          runtimeCancellation: "not_needed",
        }),
        interrupt: async () => "not_needed",
      };
    }

    this.bridge.setHandler(options.permissionHandler);
    let init: InitMessage | null = null;
    let result: ResultMessage | null = null;
    let interrupted = false;
    let runtimeCancellation: RuntimeCancellation = "not_needed";
    let spawnError: string | null = null;
    const proposedComplete = new Set<string>();

    child.once("spawn", () =>
      emit({
        type: "runtime_started",
        pid: child.pid ?? -1,
        launch: launch.description,
        at: now(),
      }),
    );
    child.once("error", (error) => {
      spawnError = error.message;
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.text);

    const handleMessage = (message: RuntimeMessage): void =>
      match(message)
        .with({ type: "system" }, (systemMessage) => {
          if (systemMessage.subtype !== "init") return;
          // The union parsed InitMessageSchema first, so a system/init message that reached here satisfies it.
          const parsedInit = InitMessageSchema.safeParse(systemMessage);
          if (!parsedInit.success) return;
          init = parsedInit.data;
          emit({ type: "runtime_init", init, at: now() });
        })
        .with({ type: "stream_event" }, ({ event }) => {
          if (
            event.type === "content_block_delta" &&
            event.delta?.type === "text_delta" &&
            event.delta.text
          ) {
            emit({ type: "text_delta", text: event.delta.text, at: now() });
          } else if (
            event.type === "content_block_start" &&
            event.content_block?.type === "tool_use" &&
            event.content_block.id &&
            event.content_block.name
          ) {
            emit({
              type: "tool_proposed",
              runtimeCallId: event.content_block.id,
              toolIdentity: event.content_block.name,
              arguments: event.content_block.input ?? {},
              complete: false,
              at: now(),
            });
          }
        })
        .with({ type: "assistant" }, (assistantMessage) => {
          emit({
            type: "assistant_message",
            message: redactValue(assistantMessage.message),
            at: now(),
          });
          for (const block of assistantMessage.message.content) {
            if (
              block.type === "tool_use" &&
              block.id &&
              block.name &&
              !proposedComplete.has(block.id)
            ) {
              proposedComplete.add(block.id);
              emit({
                type: "tool_proposed",
                runtimeCallId: block.id,
                toolIdentity: block.name,
                arguments: block.input ?? {},
                complete: true,
                at: now(),
              });
            }
          }
        })
        .with({ type: "user" }, (userMessage) => {
          const content = userMessage.message.content;
          if (!Array.isArray(content)) return;
          for (const block of content) {
            if (block.type === "tool_result" && block.tool_use_id) {
              emit({
                type: "tool_result",
                runtimeCallId: block.tool_use_id,
                isError: block.is_error === true,
                content: redactValue(block.content ?? null),
                raw: redactValue(userMessage.tool_use_result ?? null),
                at: now(),
              });
            }
          }
        })
        .with({ type: "result" }, (resultMessage) => {
          result = resultMessage;
          emit({ type: "turn_result", result, at: now() });
        })
        .with({ type: "other" }, () => undefined)
        .exhaustive();

    const splitter = new LineSplitter();
    const consume = (lines: string[]) => {
      for (const line of lines) {
        const parsed = parseStreamLine(line);
        if (!parsed) continue;
        // Retained transcript: structured redaction (sensitive keys and secret-shaped values) when the line parsed as JSON.
        const retained = parsed.ok
          ? JSON.stringify(redactValue(JSON.parse(parsed.raw)))
          : redactString(parsed.raw);
        try {
          appendFileSync(streamLogPath, retained + "\n", { mode: 0o600 });
        } catch (error) {
          emit({
            type: "runtime_stderr",
            text: `[mia] could not retain transcript line: ${errorMessage(error)}`,
            at: now(),
          });
        }
        if (parsed.ok) handleMessage(parsed.message);
        else
          emit({
            type: "malformed_event",
            raw: redactString(parsed.raw).slice(0, 2000),
            error: parsed.error,
            at: now(),
          });
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => consume(splitter.push(chunk)));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) =>
      emit({ type: "runtime_stderr", text: redactString(chunk), at: now() }),
    );

    const exitSettled = Promise.withResolvers<RuntimeExit>();
    child.once("close", (code, signal) => {
      consume(splitter.flush());
      exitSettled.resolve({ code, signal });
    });
    child.once("error", () => exitSettled.resolve({ code: null, signal: null }));
    const exited = exitSettled.promise;

    /** Settles (with no value) once a pending interrupt() has recorded its outcome. */
    const interruptSettled = Promise.withResolvers<undefined>();
    const done: Promise<TurnResult> = exited.then(async (exit) => {
      if (interrupted) await Promise.race([interruptSettled.promise, sleep(INTERRUPT_SETTLE_MS)]);
      this.bridge.setHandler(null);
      emit({ type: "runtime_exit", code: exit.code, signal: exit.signal, at: now() });
      let status: TurnResult["status"];
      let error: string | null = null;
      if (interrupted) {
        status = "killed";
      } else if (spawnError) {
        status = "failed";
        error = `runtime process error: ${spawnError}`;
      } else if (result && !result.is_error && exit.code === 0) {
        status = "completed";
      } else {
        status = "failed";
        error = result
          ? `runtime reported ${result.subtype}${result.result ? `: ${redactString(result.result).slice(0, 500)}` : ""}`
          : `runtime exited with code ${exit.code} signal ${exit.signal} without a result message`;
      }
      return {
        status,
        result,
        exit,
        error,
        streamLogPath,
        hookEvidencePath: launch.files.hookEvidence,
        launch: launch.description,
        init,
        interrupted,
        runtimeCancellation,
      };
    });

    /**
     * Interrupt = SIGKILL, deliberately not SIGTERM. Probe evidence (docs/D1/CAPABILITY-RECORD.md): on SIGTERM,
     * Claude Code 2.1.274 runs a graceful shutdown that closes its MCP connections, treats the closure as an
     * expired session and re-sends the in-flight tool call once, bypassing the permission tool. SIGKILL leaves
     * no user-space code to retry, so no new consequential dispatch can happen after the gate closes.
     */
    const interrupt = async (): Promise<RuntimeCancellation> => {
      if (child.exitCode !== null || child.signalCode !== null) return runtimeCancellation;
      interrupted = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      const outcome = await Promise.race([
        exited.then(() => "exited" as const),
        sleep(EXIT_WAIT_MS, "timeout" as const),
      ]);
      runtimeCancellation = outcome === "exited" ? "forced_kill" : "unknown";
      if (outcome === "timeout") {
        // Do not let a stuck process hold the task in "interrupting" forever: finish the turn and report uncertainty.
        child.unref();
        exitSettled.resolve({ code: null, signal: null });
      }
      interruptSettled.resolve(undefined);
      return runtimeCancellation;
    };

    return { pid: child.pid, result: done, interrupt };
  }
}

/** One line of the hook evidence file written by hook-capture.mjs: a JSON object of runtime-reported fields. */
const HookEvidenceRecordSchema = z.record(z.string(), z.unknown());

export const readHookEvidence = (path: string): Record<string, unknown>[] => {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => HookEvidenceRecordSchema.parse(JSON.parse(line)));
};
