import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { errorMessage, redactString, redactValue } from "@mia/protocol";
import type { ApprovalBridge, PermissionHandler } from "./bridge.ts";
import type { RuntimeConfig } from "./config.ts";
import { prepareLaunch, type LaunchPlan } from "./launch.ts";
import { ClaudeTranslator } from "./claude-translate.ts";
import type { RuntimeEvent, RuntimeInit, TurnSummary } from "./runtime-events.ts";
import { LineSplitter, parseStreamLine } from "./stream.ts";

export interface TurnOptions {
  text: string;
  runtimeConversationId: string;
  firstTurn: boolean;
  runtimeDir: string;
  turnIndex: number;
  /** Defaults to config.agentPromptFile; the engine passes the conversation's retained snapshot. */
  agentPromptFile?: string;
  permissionHandler: PermissionHandler;
  onEvent: (event: RuntimeEvent) => void;
}

/** not_needed: no interruption; forced_kill: SIGKILL delivered and exit observed; unknown: kill sent, exit not observed in time. */
export type RuntimeCancellation = "not_needed" | "forced_kill" | "unknown";

interface RuntimeExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface TurnResult {
  status: "completed" | "failed" | "killed";
  summary: TurnSummary | null;
  exit: RuntimeExit | null;
  error: string | null;
  streamLogPath: string;
  hookEvidencePath: string;
  launch: LaunchPlan["description"];
  init: RuntimeInit | null;
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
          summary: null,
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
    let init: RuntimeInit | null = null;
    let summary: TurnSummary | null = null;
    let interrupted = false;
    let runtimeCancellation: RuntimeCancellation = "not_needed";
    let spawnError: string | null = null;

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

    const translator = new ClaudeTranslator();
    const handleEvent = (event: RuntimeEvent): void => {
      if (event.type === "runtime_init") init = event.init;
      if (event.type === "turn_result") summary = event.summary;
      emit(event);
    };

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
        if (parsed.ok)
          for (const event of translator.translate(parsed.message, now())) handleEvent(event);
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
      } else if (summary && !summary.isError && exit.code === 0) {
        status = "completed";
      } else {
        status = "failed";
        error = summary
          ? `runtime reported ${summary.outcome}${summary.finalText ? `: ${redactString(summary.finalText).slice(0, 500)}` : ""}`
          : `runtime exited with code ${exit.code} signal ${exit.signal} without a result message`;
      }
      return {
        status,
        summary,
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
