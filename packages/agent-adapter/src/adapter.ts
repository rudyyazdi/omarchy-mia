import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, constants } from "node:fs";
import { mkdir, open, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { match } from "ts-pattern";
import { z } from "zod";
import { errorMessage, isNotFound, redactString, type RuntimeCancellation } from "@mia/protocol";
import type { ExecutionStatus } from "@mia/records";
import type { ApprovalBridge, PermissionHandler } from "./bridge.ts";
import type { RuntimeConfig } from "./config.ts";
import { untilAborted, withinDeadline } from "./deadline.ts";
import { prepareLaunch, runtimeEnvironment, type LaunchPlan, type LaunchSetup } from "./launch.ts";
import { resolveExecutableSync } from "./resolve-executable.ts";
import { ClaudeTranslator } from "./claude-translate.ts";
import type { RuntimeEvent, RuntimeInit, TurnSummary } from "./runtime-events.ts";
import { parseStreamLine, redactLine } from "./stream.ts";
import { retainStdout } from "./transcript.ts";

export interface TurnOptions {
  text: string;
  runtimeConversationId: string;
  /** True creates the runtime session (`--session-id`); false resumes it (`--resume`), so it must already exist. */
  firstTurn: boolean;
  runtimeDir: string;
  turnIndex: number;
  /** Prompt file to append, or null to append none; the engine passes the conversation's retained prompt object. */
  agentPromptFile: string | null;
  permissionHandler: PermissionHandler;
  /**
   * Handles one runtime event and settles once it is handled; it must not reject. The adapter hands over the next
   * event read from stdout only after the previous one settled, so a slow handler pauses the runtime's output
   * instead of queueing events, and they are handled in the order the runtime wrote them. Stderr text and the
   * adapter's own reports arrive whenever they happen, and the exit is handed over after the last stdout event.
   */
  onEvent: (event: RuntimeEvent) => Promise<void>;
}

interface RuntimeExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface TurnResult {
  /** How the runtime process ended; the engine derives the execution's terminal status from it. */
  status: Exclude<ExecutionStatus, "running">;
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
  /** The runtime's process id; undefined until the launch files are written and the process has spawned. */
  readonly pid: number | undefined;
  readonly result: Promise<TurnResult>;
  /**
   * Kill the runtime process group (SIGKILL; see the note on interrupt below). Resolves once exit is observed, or
   * with "unknown" after EXIT_WAIT_MS; in that case the turn is finished anyway so the task cannot hang. Before the
   * runtime has spawned it resolves "not_needed" at once, and the runtime is never started.
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

/**
 * Static checks: nothing here contacts a model. `env` is the environment a launch passes on (see
 * `LaunchInput.env`): the executable is looked up on the PATH and run with the environment the launch
 * derives from it (`runtimeEnvironment`), and the credential is detected from it.
 */
export const probeStaticCapabilitiesSync = (
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv,
): StaticCapabilities => {
  const errors: string[] = [];
  // The launch spawns the runtime in config.workingDirectory with this environment, so probe it the same way.
  const launchEnv = runtimeEnvironment(config, env);
  const resolved = resolveExecutableSync(config.executable, {
    path: launchEnv.PATH,
    cwd: config.workingDirectory,
  });
  if (!resolved) errors.push(`runtime executable "${config.executable}" not found on PATH`);
  let version: string | null = null;
  const flags: Record<string, boolean> = {};
  if (resolved) {
    const versionProbe = spawnSync(resolved, ["--version"], {
      encoding: "utf8",
      timeout: 20_000,
      env: launchEnv,
    });
    version = versionProbe.status === 0 ? versionProbe.stdout.trim() : null;
    if (!version)
      errors.push(
        `"${resolved} --version" failed: ${versionProbe.stderr?.trim() || versionProbe.error?.message || "unknown"}`,
      );
    const help =
      spawnSync(resolved, ["--help"], { encoding: "utf8", timeout: 20_000, env: launchEnv })
        .stdout ?? "";
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

  /**
   * The handle exists from the start, while the launch files are still being written, so an interruption during
   * that write reaches the turn: the runtime is then never spawned, and the turn ends killed. A write that fails
   * ends the turn failed without spawning.
   */
  submitTurn(options: TurnOptions): TurnHandle {
    const launch = prepareLaunch({
      config: this.config,
      runtimeDir: options.runtimeDir,
      bridgeUrl: this.bridge.url,
      sessionId: options.runtimeConversationId,
      resume: !options.firstTurn,
      turnIndex: options.turnIndex,
      agentPromptFile: options.agentPromptFile,
      env: this.env,
    });
    const streamLogPath = join(
      options.runtimeDir,
      `turn-${String(options.turnIndex).padStart(3, "0")}.stream.jsonl`,
    );
    let started: TurnHandle | null = null;
    let cancelled = false;
    const notStarted = (error: string | null): TurnResult => ({
      status: cancelled ? "killed" : "failed",
      summary: null,
      exit: null,
      error,
      streamLogPath,
      hookEvidencePath: launch.files.hookEvidence,
      launch: launch.description,
      init: null,
      interrupted: cancelled,
      runtimeCancellation: "not_needed",
    });
    const result = writeLaunchFiles(launch.setup).then(
      () => {
        if (cancelled) return notStarted(null);
        started = this.startRuntime({ options, launch, streamLogPath });
        return started.result;
      },
      (error: unknown) => notStarted(`could not write the launch files: ${errorMessage(error)}`),
    );
    return {
      // eslint-disable-next-line no-restricted-syntax -- a getter, so pid reads the runtime spawned after this returns
      get pid() {
        return started?.pid;
      },
      result,
      interrupt: async () => {
        if (started) return started.interrupt();
        cancelled = true;
        return "not_needed";
      },
    };
  }

  /** Spawns the runtime for a launch whose files are written, and follows it to the end of the turn. */
  private startRuntime(input: {
    options: TurnOptions;
    launch: LaunchPlan;
    streamLogPath: string;
  }): TurnHandle {
    const { options, launch, streamLogPath } = input;
    const now = () => new Date().toISOString();
    const emit = options.onEvent;
    /**
     * Hands over an event that nothing waits on. `onEvent` must not reject, so nothing is left to handle; a handler
     * that breaks that contract loses only this event, where on the stdout path its rejection stops the runtime.
     */
    const report = (event: RuntimeEvent): void => {
      emit(event).catch(() => undefined);
    };

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
      report({
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
    const handleEvent = (event: RuntimeEvent): Promise<void> => {
      if (event.type === "runtime_init") init = event.init;
      if (event.type === "turn_result") summary = event.summary;
      return emit(event);
    };

    /** Hands over one stdout line's events, each once the last is handled; returns the line's redacted text. */
    const handleLine = async (line: string): Promise<string | null> => {
      const parsed = parseStreamLine(line);
      if (!parsed) return null;
      const retained = redactLine(parsed);
      if (parsed.ok)
        for (const event of translator.translate(parsed.message, now)) await handleEvent(event);
      else
        await emit({
          type: "malformed_event",
          raw: retained.slice(0, 2000),
          error: parsed.error,
          at: now(),
        });
      return retained;
    };
    /** SIGKILLs the runtime's whole process group; see the note on interrupt below. */
    const killRuntime = (): void => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    /** Aborted when a stuck runtime's turn is finished without it, so its output stops being read. */
    const stopReading = new AbortController();
    const stdoutRead = child.stdout
      ? retainStdout({
          stdout: child.stdout,
          file: streamLogPath,
          handleLine,
          signal: stopReading.signal,
          reportFailure: (error) =>
            report({
              type: "runtime_stderr",
              text: `[mia] could not retain the transcript: ${errorMessage(error)}`,
              at: now(),
            }),
        }).catch((error: unknown) => {
          if (stopReading.signal.aborted) return;
          // A runtime whose output Mia no longer reads could keep acting unobserved, so it is stopped; the turn
          // then ends as failed when the process closes.
          killRuntime();
          report({
            type: "runtime_stderr",
            text: `[mia] stopped reading runtime output, so the runtime was stopped: ${errorMessage(error)}`,
            at: now(),
          });
        })
      : Promise.resolve();
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) =>
      report({ type: "runtime_stderr", text: redactString(chunk), at: now() }),
    );

    /**
     * Settles once the process is gone; interrupt() judges the kill by it. On `exit`, not `close`: `close` also
     * waits for stdout to end, which a slow event handler can hold back after the process has died.
     */
    const processGone = Promise.withResolvers<undefined>();
    child.once("exit", () => processGone.resolve(undefined));
    /** Settles when the turn may end: the process is gone and, unless it failed to spawn, stdout is drained. */
    const exitSettled = Promise.withResolvers<RuntimeExit>();
    // The turn ends only once every stdout line has been handled and retained, so a turn-end read sees them all.
    child.once("close", (code, signal) => {
      processGone.resolve(undefined);
      const settle = () => exitSettled.resolve({ code, signal });
      void stdoutRead.then(settle, settle);
    });
    child.once("error", () => {
      processGone.resolve(undefined);
      exitSettled.resolve({ code: null, signal: null });
    });
    const exited = exitSettled.promise;

    /** Settles (with no value) once a pending interrupt() has recorded its outcome. */
    const interruptSettled = Promise.withResolvers<undefined>();
    const done: Promise<TurnResult> = exited.then(async (exit) => {
      if (interrupted)
        await withinDeadline(interruptSettled.promise, INTERRUPT_SETTLE_MS, undefined);
      this.bridge.setHandler(null);
      await emit({ type: "runtime_exit", code: exit.code, signal: exit.signal, at: now() });
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
      killRuntime();
      const outcome = await withinDeadline(
        processGone.promise.then(() => "exited" as const),
        EXIT_WAIT_MS,
        "timeout" as const,
      );
      runtimeCancellation = outcome === "exited" ? "forced_kill" : "unknown";
      if (outcome === "timeout") {
        // Do not let a stuck process hold the task in "interrupting" forever: finish the turn and report uncertainty.
        child.unref();
        stopReading.abort();
        exitSettled.resolve({ code: null, signal: null });
      }
      interruptSettled.resolve(undefined);
      return runtimeCancellation;
    };

    return { pid: child.pid, result: done, interrupt };
  }
}

/**
 * Creates the directories and files a launch plan's invocation refers to (see `prepareLaunch`), owner-only. It
 * settles only after every write has: a conversation's turns share these file names, and a turn does not end before
 * its writes do, so no write of an earlier turn can land over a later turn's settings.
 */
export const writeLaunchFiles = async (setup: LaunchSetup): Promise<void> => {
  for (const directory of setup.directories)
    await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const file of setup.files) await writeFile(file.path, file.content, { mode: 0o600 });
};

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

/**
 * A file read while the server serves: one the runtime writes during a turn, read after it ends, or a file a
 * conversation start retains. `absent` when nothing exists at the path.
 */
export type RuntimeFileRead =
  | { status: "absent" }
  | { status: "read"; bytes: Buffer }
  | { status: "unreadable"; reason: string };

/**
 * How a read is bounded: once `signal` aborts, the read is abandoned; a file longer than `maxBytes` is unreadable,
 * and no more than one byte past the cap is ever held in memory.
 */
export interface RuntimeFileReadOptions {
  signal?: AbortSignal;
  maxBytes?: number;
}

/** Reads a file at a path while serving; `readRuntimeFile` is the real one, and a test injects its own. */
export type RuntimeFileReader = (
  path: string,
  options?: RuntimeFileReadOptions,
) => Promise<RuntimeFileRead>;

/** Why an abandoned read is unreadable: an `AbortSignal.timeout` deadline reads as `timed out`. */
const abortReason = (reason: unknown): string =>
  reason instanceof DOMException && reason.name === "TimeoutError"
    ? "timed out"
    : errorMessage(reason);

/** Reads at most `maxBytes` + 1 bytes from the start of `handle`: one more than the cap shows the file is longer. */
const readCapped = async (
  handle: FileHandle,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  const stream = handle.createReadStream({ start: 0, end: maxBytes, autoClose: false, signal });
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
};

/**
 * Opens without blocking and reads only a regular file. A blocking open of a FIFO waits for a writer that may
 * never come, and a read of one waits for data, each holding one of libuv's few worker threads meanwhile; a
 * runtime that leaves a FIFO on every turn would take one more each turn until every async fs call stalls.
 * O_NOCTTY keeps a terminal device at the path from becoming the server's controlling terminal.
 */
const readRegularFile = async (
  path: string,
  { signal, maxBytes }: RuntimeFileReadOptions,
): Promise<RuntimeFileRead> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { status: "unreadable", reason: "not a regular file" };
    if (maxBytes === undefined) return { status: "read", bytes: await handle.readFile({ signal }) };
    const tooLarge: RuntimeFileRead = {
      status: "unreadable",
      reason: `larger than ${maxBytes} bytes`,
    };
    if (stats.size > maxBytes) return tooLarge;
    // Capped as well, because the file can grow after the stat.
    const bytes = await readCapped(handle, maxBytes, signal);
    return bytes.byteLength > maxBytes ? tooLarge : { status: "read", bytes };
  } finally {
    // Nothing was written through this descriptor, so a failed close loses nothing the result depends on.
    await handle.close().catch(() => undefined);
  }
};

const readOrReport = async (
  path: string,
  options: RuntimeFileReadOptions,
): Promise<RuntimeFileRead> => {
  const { signal } = options;
  try {
    return await readRegularFile(path, options);
  } catch (error) {
    if (signal?.aborted) return { status: "unreadable", reason: abortReason(signal.reason) };
    if (isNotFound(error)) return { status: "absent" };
    return { status: "unreadable", reason: errorMessage(error) };
  }
};

/** Starts one read of a runtime-written file; it never rejects, reporting every failure as a result instead. */
type RuntimeFileReadStart = (
  path: string,
  options: RuntimeFileReadOptions,
) => Promise<RuntimeFileRead>;

/**
 * A reader that abandons a read the moment `signal` aborts (a read is never started under a signal that has
 * already aborted), and refuses to start one while `maxStuckReads` abandoned reads have yet to return.
 *
 * The reader owns the abandoned reads: each one leaves the count when its `read` finally settles. A read that is
 * already in flight when the count reaches the cap can still be abandoned, so the count can exceed the cap by the
 * reads started concurrently with the last abandoned one.
 */
export const boundedRuntimeFileReader = ({
  read,
  maxStuckReads,
}: {
  read: RuntimeFileReadStart;
  maxStuckReads: number;
}): RuntimeFileReader => {
  let stuckReads = 0;
  const release = (): void => {
    stuckReads -= 1;
  };
  return async (path, options = {}) => {
    const { signal } = options;
    // A signal that has already aborted reports its own reason, which `untilAborted` gives without starting.
    if (!signal?.aborted && stuckReads >= maxStuckReads)
      return { status: "unreadable", reason: "an earlier abandoned read is still blocked" };
    let started: Promise<RuntimeFileRead> | null = null;
    let settled = false;
    const markSettled = (): void => {
      settled = true;
    };
    return untilAborted(
      () => {
        started = read(path, options);
        // Neither handler can throw, so these chains never reject.
        void started.then(markSettled, markSettled);
        return started;
      },
      signal,
      (reason) => {
        // An abort landing after the read settled, before the race observed it, leaves nothing blocked to count.
        if (started && !settled) {
          stuckReads += 1;
          void started.then(release, release);
        }
        return { status: "unreadable", reason: abortReason(reason) };
      },
    );
  };
};

/**
 * Abandoned reads the process lets stay blocked before it refuses to start another. The libuv worker pool (4
 * threads by default) is per process, and every async fs call and `dns.lookup` queues behind it, so this keeps
 * threads free when a turn's two concurrent evidence reads (transcript and hook evidence) are the last to stick.
 * A conversation start's two reads (agent prompt and architecture document) share the budget, because the pool is
 * shared: a stale mount under either path can cost later turns their evidence until those reads return. So does a
 * debug-mode read of a body log at a tool result.
 */
const MAX_STUCK_READS = 2;

/**
 * Reads a runtime-written file, or a file a conversation start retains, without throwing, because a throw after
 * the turn would keep it from being recorded as finished. Only a missing file is absent; anything that is not a regular file (a directory, a
 * FIFO) and any other failure (EACCES, ENOTDIR) is reported. Asynchronous because the server reads at turn end
 * while it serves other connections.
 *
 * A read is unreadable the moment `signal` aborts, even if the `open()` or `read()` under it is blocked (a
 * regular file on a stale mount): `readFile`'s own signal is only checked between those calls. Nothing avoids
 * that blocked call, so each such abandoned read keeps its descriptor, and a libuv worker thread, until the
 * kernel returns, and then closes the descriptor. While `MAX_STUCK_READS` of them are still blocked, every read
 * is unreadable without starting: a hung mount then costs later turns their evidence, even on a healthy path,
 * instead of stalling the whole process.
 */
export const readRuntimeFile: RuntimeFileReader = boundedRuntimeFileReader({
  read: readOrReport,
  maxStuckReads: MAX_STUCK_READS,
});

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
export const hookEvidenceFrom = (read: RuntimeFileRead): HookEvidence =>
  match(read)
    .with({ status: "absent" }, () => parseHookEvidence(""))
    .with({ status: "unreadable" }, ({ reason }) => ({
      ...parseHookEvidence(""),
      readError: reason,
    }))
    .with({ status: "read" }, ({ bytes }) => parseHookEvidence(bytes.toString("utf8")))
    .exhaustive();
