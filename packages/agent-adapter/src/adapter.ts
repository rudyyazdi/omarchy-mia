import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { match } from "ts-pattern";
import { z } from "zod";
import { errorMessage, redactString } from "@mia/protocol";
import type { ApprovalBridge, PermissionHandler } from "./bridge.ts";
import type { RuntimeConfig } from "./config.ts";
import { prepareLaunch, type LaunchPlan } from "./launch.ts";
import { ClaudeTranslator } from "./claude-translate.ts";
import type { RuntimeEvent, RuntimeInit, TurnSummary } from "./runtime-events.ts";
import { LineSplitter, parseStreamLine, redactLine } from "./stream.ts";

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

/**
 * `promise`'s value, or `fallback` once `ms` pass. The deadline is cancelled as soon as the race settles and
 * never holds the process open, so a server shutting down after a kill is not kept alive by it.
 */
const withinDeadline = async <T, F>(
  promise: Promise<T>,
  ms: number,
  fallback: F,
): Promise<T | F> => {
  const settled = new AbortController();
  try {
    return await Promise.race([
      promise,
      sleep(ms, fallback, { signal: settled.signal, ref: false }),
    ]);
  } finally {
    settled.abort();
  }
};

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

/**
 * Static checks: nothing here contacts a model. `env` is the environment a launch passes on (see
 * `LaunchInput.env`): the executable is looked up on its PATH and run with it, and the credential
 * is detected from it.
 */
export const probeStaticCapabilities = (
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv,
): StaticCapabilities => {
  const errors: string[] = [];
  const which = spawnSync("sh", ["-c", `command -v ${JSON.stringify(config.executable)}`], {
    encoding: "utf8",
    env,
  });
  const resolved = which.status === 0 ? which.stdout.trim() : null;
  if (!resolved) errors.push(`runtime executable "${config.executable}" not found on PATH`);
  let version: string | null = null;
  const flags: Record<string, boolean> = {};
  if (resolved) {
    const versionProbe = spawnSync(resolved, ["--version"], {
      encoding: "utf8",
      timeout: 20_000,
      env,
    });
    version = versionProbe.status === 0 ? versionProbe.stdout.trim() : null;
    if (!version)
      errors.push(
        `"${resolved} --version" failed: ${versionProbe.stderr?.trim() || versionProbe.error?.message || "unknown"}`,
      );
    const help =
      spawnSync(resolved, ["--help"], { encoding: "utf8", timeout: 20_000, env }).stdout ?? "";
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
  if (env.ANTHROPIC_API_KEY) credential = "ANTHROPIC_API_KEY";
  else if (existsSync(join(env.HOME ?? "", ".claude", ".credentials.json")))
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
 * has a handler while a turn is active. Each runtime process inherits `env` (see `LaunchInput.env`).
 */
export class ClaudeCodeAdapter {
  constructor(
    readonly config: RuntimeConfig,
    readonly bridge: ApprovalBridge,
    private readonly env: NodeJS.ProcessEnv,
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
      env: this.env,
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
    /** The last init and summary the runtime reported become the TurnResult's; every event is forwarded. */
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
        const retained = redactLine(parsed);
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
          for (const event of translator.translate(parsed.message, now)) handleEvent(event);
        else
          emit({
            type: "malformed_event",
            raw: retained.slice(0, 2000),
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
      if (interrupted)
        await withinDeadline(interruptSettled.promise, INTERRUPT_SETTLE_MS, undefined);
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
      const outcome = await withinDeadline(
        exited.then(() => "exited" as const),
        EXIT_WAIT_MS,
        "timeout" as const,
      );
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

export interface HookEvidence {
  records: Record<string, unknown>[];
  /** Lines that were not a JSON object, such as the truncated last line of a turn killed mid-write. */
  malformedLines: number;
  /** Why the file could not be read for a reason other than being absent, in which case there are no records; else null. */
  readError: string | null;
}

const parseHookLine = (line: string): Record<string, unknown> | null => {
  try {
    const parsed = HookEvidenceRecordSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** A file the runtime writes during a turn, read after it ends; `absent` when the runtime never wrote it. */
export type RuntimeFileRead =
  | { status: "absent" }
  | { status: "read"; bytes: Buffer }
  | { status: "unreadable"; reason: string };

/**
 * Reads a runtime-written file without throwing, because a throw after the turn would keep it from being
 * recorded as finished. Only a missing file is absent; any other failure (EACCES, EISDIR, ENOTDIR) is reported.
 */
export const readRuntimeFile = (path: string): RuntimeFileRead => {
  try {
    return { status: "read", bytes: readFileSync(path) };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { status: "absent" };
    return { status: "unreadable", reason: errorMessage(error) };
  }
};

/** Counts and skips malformed lines, such as the truncated last line of a turn killed mid-write. */
const parseHookEvidence = (text: string): HookEvidence => {
  const evidence: HookEvidence = { records: [], malformedLines: 0, readError: null };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const record = parseHookLine(line);
    if (record) evidence.records.push(record);
    else evidence.malformedLines += 1;
  }
  return evidence;
};

/** Evidence is best-effort: a malformed line is skipped, and an unreadable file is reported rather than thrown. */
export const readHookEvidence = (path: string): HookEvidence =>
  match(readRuntimeFile(path))
    .with({ status: "absent" }, () => parseHookEvidence(""))
    .with({ status: "unreadable" }, ({ reason }) => ({
      ...parseHookEvidence(""),
      readError: reason,
    }))
    .with({ status: "read" }, ({ bytes }) => parseHookEvidence(bytes.toString("utf8")))
    .exhaustive();
