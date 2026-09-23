/**
 * Live-lane runner: starts the controlled fixture and both server profiles, runs the promptfoo eval with N repeats,
 * enriches every result with catalog evidence (reported model/effort, runtime version, export verification) and
 * writes the live rows of the acceptance record. Every turn counts against the shared live-call budget.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { startFixture } from "@mia/controlled-mcp";
import { errorMessage, isRecord, type Effort } from "@mia/protocol";
import { Catalog, exportConversation, snapshotConversation, verifyExport } from "@mia/records";
import { loadProfileSync } from "@mia/agent-adapter";
import {
  EVIDENCE_READ_TIMEOUT_MS,
  SHUTDOWN_TURN_WAIT_MS,
  startServer,
  type MiaServer,
} from "@mia/server";
import { readScenarioName, ScenarioNameSchema, type ScenarioName } from "./scenarios.ts";

/** What `npm run live` was asked to run; `main.ts` reads it from the command line. */
export interface LiveOptions {
  /** The promptfoo repeat count, passed through as given. */
  repeat: string;
  /** The scenarios to run; all of them when absent. */
  scenarios?: ScenarioName[];
  /** The agent prompt file, relative to the repo root. */
  agentPrompt: string;
  model: string;
  /** The evidence directory; `.mia-state/live/<timestamp>` when absent. */
  out?: string;
}

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const log = (message: string) => console.log(`[live] ${message}`);

const stringOrUndefined = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** The provider's JSON evidence, as an object; a JSON string is decoded first and unparseable output is flagged. */
const decodeEvidence = (output: unknown): Record<string, unknown> => {
  try {
    const decoded: unknown = typeof output === "string" ? JSON.parse(output) : output;
    return isRecord(decoded) ? decoded : {};
  } catch {
    return { parse_error: true };
  }
};

/** Runtime evidence gathered from the catalog for one scenario run; empty when no conversation was found. */
interface RuntimeEvidence {
  requested_model: string[];
  reported_model: string[];
  requested_effort: Effort[];
  // eslint-disable-next-line no-restricted-syntax -- whatever effort levels the runtime reported, or "unverified"
  reported_effort: string[];
  runtime_version: string | null;
  event_count: number;
  task_ids: string[];
}

interface LiveRow {
  scenario: ScenarioName;
  repeat: number;
  lane: "L";
  pass: boolean;
  reason: string;
  conversation_id: string | null;
  profile: unknown;
  prompt_version: unknown;
  ledger: unknown;
  decisions: unknown;
  notes: unknown;
  final_status: unknown;
  runtime: Partial<RuntimeEvidence>;
  export: Record<string, unknown> | null;
}

const LedgerSummarySchema = z.looseObject({
  commits: z.array(z.looseObject({ tool: z.string() })).optional(),
});

const writeLiveResults = ({
  rows,
  summary,
  problems,
  promptVersion,
  outDirAbs,
}: {
  rows: LiveRow[];
  summary: Record<string, unknown>;
  /** Run-level failures that no row shows; listed so the committed record cannot look clean. */
  problems: string[];
  promptVersion: string;
  outDirAbs: string;
}): void => {
  writeFileSync(join(outDirAbs, "acceptance-live.json"), JSON.stringify(summary, null, 2));
  // Committed markdown must not carry personal absolute paths.
  const relativeOutDir = outDirAbs.startsWith(REPO_ROOT)
    ? outDirAbs.slice(REPO_ROOT.length + 1)
    : outDirAbs;
  const md = [
    `# Live acceptance results (${promptVersion}, ${summary.model})`,
    "",
    `Generated ${summary.generated_at} from \`${relativeOutDir}\` (private evidence directory). ${rows.filter((row) => row.pass).length}/${rows.length} rows passed. Lane L = live runtime; ledger evidence from the controlled fixture. "reported effort: unverified" means the turn used no tool, so the PreToolUse hook produced no effort evidence.`,
    ...(problems.length > 0
      ? ["", ...problems.map((problem) => `- **Run problem:** ${problem}`)]
      : []),
    "",
    "| scenario | repeat | pass | conversation | reported model | reported effort | runtime | ledger commits | reason |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => {
      const ledger = LedgerSummarySchema.safeParse(row.ledger);
      const commitTools = ledger.success
        ? ledger.data.commits?.map((commit) => commit.tool).join(",")
        : undefined;
      return `| ${row.scenario} | ${row.repeat} | ${row.pass ? "pass" : "FAIL"} | ${row.conversation_id ?? "-"} | ${row.runtime.reported_model?.join(",") ?? "-"} | ${row.runtime.reported_effort?.join(",") ?? "-"} | ${row.runtime.runtime_version ?? "-"} | ${commitTools || "none"} | ${String(row.reason).replace(/\|/g, "/")} |`;
    }),
  ];
  mkdirSync(join(REPO_ROOT, "docs/D1/acceptance"), { recursive: true });
  writeFileSync(
    join(REPO_ROOT, "docs/D1/acceptance", `live-results-${promptVersion}.md`),
    md.join("\n") + "\n",
  );
};

/** What starting one server profile needs from the run. */
interface ProfileRun {
  outDir: string;
  agentPromptPath: string;
  model: string;
  /** The environment the profile's `${ENV}` placeholders resolve against. */
  profileEnv: NodeJS.ProcessEnv;
  /** The environment the runtime inherits. */
  runtimeEnv: NodeJS.ProcessEnv;
  /** Owns each server: it is closed, then its log written, when the run ends however it ends. */
  cleanup: AsyncDisposableStack;
}

const startProfile = async (name: string, index: number, run: ProfileRun): Promise<MiaServer> => {
  const profile = loadProfileSync(
    join(REPO_ROOT, "examples", "config", `${name}.json`),
    run.profileEnv,
  );
  profile.stateDirectory = join(run.outDir, `state-${index}`);
  profile.server = {
    ...profile.server,
    port: 0,
    secretFile: join(run.outDir, `state-${index}`, "client-secret"),
  };
  profile.runtime.workingDirectory = join(run.outDir, `work-${index}`);
  profile.runtime.agentPromptFile = run.agentPromptPath;
  profile.runtime.model = run.model;
  const logs: string[] = [];
  // Registered before the server starts, so a start that fails still leaves the lines explaining
  // why. Deferred callbacks run last in, first out: the server closes before its log is written.
  run.cleanup.defer(() =>
    writeFileSync(join(run.outDir, `server-${index}.log`), logs.join("\n") + "\n"),
  );
  const server = await startServer({
    profile,
    env: run.runtimeEnv,
    log: (message) => logs.push(`${new Date().toISOString()} ${message}`),
    evidenceReadDeadline: () => AbortSignal.timeout(EVIDENCE_READ_TIMEOUT_MS),
  });
  run.cleanup.defer(() => server.close(AbortSignal.timeout(SHUTDOWN_TURN_WAIT_MS)));
  log(`server ${name} at ${server.gateway.url}`);
  return server;
};

/** The slice of a promptfoo result row the runner reads; everything else is kept but ignored. */
const PfResultSchema = z.looseObject({
  success: z.boolean(),
  testCase: z
    .looseObject({
      vars: z.record(z.string(), z.unknown()).nullish(),
      description: z.string().nullish(),
    })
    .nullish(),
  vars: z.record(z.string(), z.unknown()).nullish(),
  response: z
    .looseObject({ output: z.unknown().optional(), error: z.string().nullish() })
    .nullish(),
  gradingResult: z
    .looseObject({ reason: z.string().nullish(), pass: z.boolean().nullish() })
    .nullish(),
  error: z.string().nullish(),
});
const PfOutputSchema = z.looseObject({
  results: z.looseObject({ results: z.array(PfResultSchema).optional() }).optional(),
});
const RuntimeIdentitySchema = z.looseObject({ runtime_version: z.string().optional() });

/**
 * Runs the promptfoo eval and resolves to its exit code. It rejects, and no record is written, when
 * promptfoo cannot start or `signal` aborts (which kills it).
 */
const runPromptfoo = async (
  options: LiveOptions,
  pfEnv: NodeJS.ProcessEnv,
  { resultsPath, signal }: { resultsPath: string; signal: AbortSignal | undefined },
): Promise<number> => {
  const args = [
    "eval",
    "-c",
    join(REPO_ROOT, "tests/acceptance/promptfoo/promptfooconfig.yaml"),
    "-o",
    resultsPath,
    "--no-cache",
    "--repeat",
    options.repeat,
    "--no-progress-bar",
  ];
  if (options.scenarios) args.push("--filter-pattern", `^(${options.scenarios.join("|")})$`);
  log(`promptfoo ${args.join(" ")}`);
  const {
    promise: promptfooExited,
    resolve: resolveExit,
    reject: rejectExit,
  } = Promise.withResolvers<number>();
  const child = spawn(join(REPO_ROOT, "node_modules/.bin/promptfoo"), args, {
    cwd: join(REPO_ROOT, "tests/acceptance/promptfoo"),
    env: pfEnv,
    stdio: "inherit",
    signal,
  });
  // An abort or a failed start emits "error" before "close"; the first to fire settles the exit.
  child.on("error", rejectExit);
  child.on("close", (code) => resolveExit(code ?? 1));
  const exitCode = await promptfooExited;
  log(`promptfoo exited ${exitCode}`);
  return exitCode;
};

/**
 * One row per promptfoo result, enriched with evidence from the catalog of whichever server ran
 * it. A result whose scenario name is not declared cannot form a row; it comes back as a problem.
 */
const readRows = ({
  resultsPath,
  servers,
  outDir,
  promptVersion,
}: {
  resultsPath: string;
  servers: MiaServer[];
  outDir: string;
  promptVersion: string;
}): { rows: LiveRow[]; unreadResults: string[] } => {
  const rows: LiveRow[] = [];
  const unreadResults: string[] = [];
  if (!existsSync(resultsPath)) return { rows, unreadResults };
  const raw = PfOutputSchema.parse(JSON.parse(readFileSync(resultsPath, "utf8")));
  const results = raw.results?.results ?? [];
  using opened = new DisposableStack();
  const catalogs = servers.map((server) =>
    opened.adopt(Catalog.openSync(server.profile.stateDirectory, { readonly: true }), (catalog) =>
      catalog.close(),
    ),
  );
  const repeatCounters: Partial<Record<ScenarioName, number>> = {};
  for (const [index, result] of results.entries()) {
    const read = readScenarioName(result.testCase?.vars?.scenario ?? result.vars?.scenario);
    if (!read.ok) {
      const problem = `result ${index} (${result.testCase?.description ?? "?"}): ${read.error}`;
      unreadResults.push(problem);
      log(`skipping ${problem}`);
      continue;
    }
    const scenario = read.name;
    const repeat = (repeatCounters[scenario] ?? 0) + 1;
    repeatCounters[scenario] = repeat;
    const evidence = decodeEvidence(result.response?.output);
    const conversationId = stringOrUndefined(evidence.conversation_id);
    let runtime: Partial<RuntimeEvidence> = {};
    let exportResult: Record<string, unknown> | null = null;
    if (conversationId) {
      const catalog = catalogs.find((candidate) =>
        candidate.get("SELECT id FROM conversations WHERE id = ?", conversationId),
      );
      if (catalog) {
        const snap = snapshotConversation(catalog, conversationId);
        const execs = snap.tables.executions;
        const identity = snap.tables.provenance_entries.find(
          (entry) => entry.role === "runtime_identity",
        );
        const identityArtifact = identity?.artifact_id
          ? snap.tables.artifacts.find((artifact) => artifact.id === identity.artifact_id)
          : undefined;
        let runtimeVersion: string | null = null;
        const digest = identityArtifact?.object_digest;
        if (digest) {
          try {
            const identityObject = RuntimeIdentitySchema.parse(
              JSON.parse(
                readFileSync(
                  join(catalog.paths.root, "objects", "sha256", digest.slice(0, 2), digest),
                  "utf8",
                ),
              ),
            );
            runtimeVersion = identityObject.runtime_version ?? null;
          } catch {
            runtimeVersion = identity?.version ?? null;
          }
        }
        runtime = {
          requested_model: [...new Set(execs.map((execution) => execution.requested_model))],
          reported_model: [
            ...new Set(execs.map((execution) => execution.reported_model ?? "unreported")),
          ],
          requested_effort: [...new Set(execs.map((execution) => execution.requested_effort))],
          reported_effort: [
            ...new Set(execs.map((execution) => execution.reported_effort ?? "unverified")),
          ],
          runtime_version: runtimeVersion ?? identity?.version ?? null,
          event_count: snap.cutoff_sequence,
          task_ids: snap.tables.tasks.map((task) => task.id),
        };
        if (scenario === "artifact-export" && result.success) {
          const target = join(outDir, "exports", `${conversationId}-${repeat}`);
          mkdirSync(join(outDir, "exports"), { recursive: true });
          try {
            const writable = opened.adopt(
              Catalog.openSync(catalog.paths.root, { readonly: false }),
              (exporter) => exporter.close(),
            );
            const exported = exportConversation(writable, conversationId, target);
            const verification = verifyExport(target);
            exportResult = {
              directory: target,
              complete: exported.manifest.complete,
              verified: verification.ok,
              problems: verification.problems,
              artifacts: exported.manifest.artifact_count,
              objects: exported.manifest.objects.included,
            };
          } catch (error) {
            exportResult = { error: errorMessage(error) };
          }
        }
      }
    }
    const exportOk = exportResult === null || exportResult.verified === true;
    rows.push({
      scenario,
      repeat,
      lane: "L",
      pass: result.success && exportOk,
      reason:
        (result.gradingResult?.reason ?? result.error ?? result.response?.error ?? "") +
        (exportOk ? "" : `; export failed: ${JSON.stringify(exportResult)}`),
      conversation_id: conversationId ?? null,
      profile: evidence.profile ?? null,
      prompt_version: evidence.prompt_version ?? promptVersion,
      ledger: evidence.ledger_after ?? null,
      decisions: evidence.decisions ?? null,
      notes: evidence.notes ?? null,
      final_status: evidence.final_status ?? null,
      runtime,
      export: exportResult,
    });
  }
  return { rows, unreadResults };
};

/**
 * Runs the live lane and resolves to the process exit code: 0 only when promptfoo passed, every
 * requested scenario produced a row and every row passed. Before it settles, whether it resolves
 * or rejects, both servers are closed and their logs written, then the fixture is closed.
 */
export const runLive = async (
  options: LiveOptions,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<number> => {
  signal?.throwIfAborted();
  const requested = options.scenarios ?? ScenarioNameSchema.options;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = resolve(options.out ?? join(REPO_ROOT, ".mia-state", "live", stamp));
  mkdirSync(outDir, { recursive: true, mode: 0o700 });

  await using cleanup = new AsyncDisposableStack();
  const fixtureDir = join(outDir, "fixture");
  const fixture = await startFixture({ dir: fixtureDir, mcpLogFile: env.MIA_MCP_HTTP_LOG });
  cleanup.defer(() => fixture.close());
  log(`fixture ${fixture.mcpUrl} harness ${fixture.harnessUrl}`);
  const fixtureEnv = {
    ...env,
    MIA_FIXTURE_MCP_URL: fixture.mcpUrl,
    MIA_FIXTURE_DIR: fixtureDir,
    XDG_STATE_HOME: env.XDG_STATE_HOME ?? join(env.HOME ?? ".", ".local", "state"),
  };
  const agentPromptPath = resolve(REPO_ROOT, options.agentPrompt);
  const promptVersion = basename(agentPromptPath, ".md");

  const run: ProfileRun = {
    outDir,
    agentPromptPath,
    model: options.model,
    profileEnv: fixtureEnv,
    // The runtime inherits the runner's own environment, not the promptfoo one built here.
    runtimeEnv: env,
    cleanup,
  };
  const server1 = await startProfile("fixture-test", 1, run);
  const server2 = await startProfile("fixture-test-interrupt", 2, run);

  const pfEnv = {
    ...fixtureEnv,
    MIA_URL_1: server1.gateway.url,
    MIA_SECRET_FILE_1: server1.profile.server.secretFile,
    MIA_URL_2: server2.gateway.url,
    MIA_SECRET_FILE_2: server2.profile.server.secretFile,
    MIA_FIXTURE_HARNESS_URL: fixture.harnessUrl,
    MIA_REPO_ROOT: REPO_ROOT,
    MIA_AGENT_PROMPT_VERSION: promptVersion,
    PROMPTFOO_DISABLE_TELEMETRY: "1",
    PROMPTFOO_DISABLE_UPDATE: "1",
    PROMPTFOO_DISABLE_SHARING: "1",
    PROMPTFOO_CONFIG_DIR: join(outDir, "promptfoo-home"),
    NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --import=tsx`.trim(),
  };
  const resultsPath = join(outDir, "results.json");
  const exitCode = await runPromptfoo(options, pfEnv, { resultsPath, signal });

  const { rows, unreadResults } = readRows({
    resultsPath,
    servers: [server1, server2],
    outDir,
    promptVersion,
  });
  /** Requested scenarios that produced no row: a filter or config mismatch must not pass as "all passed". */
  const missingScenarios = requested.filter((name) => !rows.some((row) => row.scenario === name));
  const summary = {
    generated_at: new Date().toISOString(),
    out_dir: outDir,
    model: options.model,
    prompt_version: promptVersion,
    repeat: Number(options.repeat),
    promptfoo_exit: exitCode,
    unread_results: unreadResults,
    missing_scenarios: missingScenarios,
    rows,
  };
  writeLiveResults({
    rows,
    summary,
    problems: [
      ...unreadResults.map((problem) => `skipped ${problem}`),
      ...missingScenarios.map((name) => `scenario ${name} was requested but produced no result`),
    ],
    promptVersion,
    outDirAbs: outDir,
  });
  log(
    `wrote docs/D1/acceptance/live-results-${promptVersion}.md and ${join(outDir, "acceptance-live.json")}`,
  );
  const clean = unreadResults.length === 0 && missingScenarios.length === 0;
  return exitCode === 0 && clean && rows.every((row) => row.pass) ? 0 : 1;
};
