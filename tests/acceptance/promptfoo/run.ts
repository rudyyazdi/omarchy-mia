/**
 * Live-lane runner: starts the controlled fixture and both server profiles, runs the promptfoo eval with N repeats,
 * enriches every result with catalog evidence (reported model/effort, runtime version, export verification) and
 * writes the live rows of the acceptance record. Every turn counts against the shared live-call budget.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { startFixture } from "@mia/controlled-mcp";
import { errorMessage, isRecord } from "@mia/protocol";
import { Catalog, exportConversation, snapshotConversation, verifyExport } from "@mia/records";
import { loadProfile, startServer, type MiaServer } from "@mia/server";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const program = new Command()
  .name("live")
  .option("--repeat <N>", "promptfoo repeat count", "2")
  .option("--scenarios <names>", "comma-separated scenario names to run")
  .option(
    "--agent-prompt <path>",
    "agent prompt file, relative to the repo root",
    "prompts/agent-v1.md",
  )
  .option("--model <model>", "runtime model", "claude-sonnet-5")
  .option("--out <dir>", "evidence directory (default: .mia-state/live/<timestamp>)");
program.parse();
const values = program.opts<{
  repeat: string;
  scenarios?: string;
  agentPrompt: string;
  model: string;
  out?: string;
}>();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = resolve(values.out ?? join(REPO_ROOT, ".mia-state", "live", stamp));
mkdirSync(outDir, { recursive: true, mode: 0o700 });
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
  requested_effort: string[];
  reported_effort: string[];
  runtime_version: string | null;
  event_count: number;
  task_ids: string[];
}

interface LiveRow {
  scenario: string;
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
  promptVersion,
  outDirAbs,
}: {
  rows: LiveRow[];
  summary: Record<string, unknown>;
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

const fixtureDir = join(outDir, "fixture");
const fixture = await startFixture({ dir: fixtureDir });
log(`fixture ${fixture.mcpUrl} harness ${fixture.harnessUrl}`);
const env = {
  ...process.env,
  MIA_FIXTURE_MCP_URL: fixture.mcpUrl,
  MIA_FIXTURE_DIR: fixtureDir,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? ".", ".local", "state"),
};
const agentPromptPath = resolve(REPO_ROOT, values.agentPrompt);
const promptVersion = basename(agentPromptPath, ".md");

const startProfile = async (name: string, index: number): Promise<MiaServer> => {
  const profile = loadProfile(join(REPO_ROOT, "examples", "config", `${name}.json`), env);
  profile.stateDirectory = join(outDir, `state-${index}`);
  profile.server = {
    ...profile.server,
    port: 0,
    secretFile: join(outDir, `state-${index}`, "client-secret"),
  };
  profile.runtime.workingDirectory = join(outDir, `work-${index}`);
  profile.runtime.agentPromptFile = agentPromptPath;
  profile.runtime.model = values.model;
  const logs: string[] = [];
  const server = await startServer({
    profile,
    log: (message) => logs.push(`${new Date().toISOString()} ${message}`),
  });
  process.on("exit", () =>
    writeFileSync(join(outDir, `server-${index}.log`), logs.join("\n") + "\n"),
  );
  log(`server ${name} at ${server.gateway.url}`);
  return server;
};

const server1 = await startProfile("fixture-test", 1);
const server2 = await startProfile("fixture-test-interrupt", 2);

const pfEnv = {
  ...env,
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
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=tsx`.trim(),
};
const resultsPath = join(outDir, "results.json");
const args = [
  "eval",
  "-c",
  join(REPO_ROOT, "tests/acceptance/promptfoo/promptfooconfig.yaml"),
  "-o",
  resultsPath,
  "--no-cache",
  "--repeat",
  values.repeat,
  "--no-progress-bar",
];
if (values.scenarios) args.push("--filter-pattern", `^(${values.scenarios.split(",").join("|")})$`);
log(`promptfoo ${args.join(" ")}`);
const { promise: promptfooExited, resolve: resolveExit } = Promise.withResolvers<number>();
const child = spawn(join(REPO_ROOT, "node_modules/.bin/promptfoo"), args, {
  cwd: join(REPO_ROOT, "tests/acceptance/promptfoo"),
  env: pfEnv,
  stdio: "inherit",
});
child.on("close", (code) => resolveExit(code ?? 1));
const exitCode = await promptfooExited;
log(`promptfoo exited ${exitCode}`);

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

const rows: LiveRow[] = [];
if (existsSync(resultsPath)) {
  const raw = PfOutputSchema.parse(JSON.parse(readFileSync(resultsPath, "utf8")));
  const results = raw.results?.results ?? [];
  const catalogs = [
    new Catalog(server1.profile.stateDirectory, { readonly: true }),
    new Catalog(server2.profile.stateDirectory, { readonly: true }),
  ];
  const repeatCounters: Record<string, number> = {};
  for (const result of results) {
    const scenario = String(result.testCase?.vars?.scenario ?? result.vars?.scenario ?? "?");
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
            const exported = exportConversation(
              new Catalog(catalog.paths.root, { readonly: false }),
              conversationId,
              target,
            );
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
  for (const catalog of catalogs) catalog.close();
}
const summary = {
  generated_at: new Date().toISOString(),
  out_dir: outDir,
  model: values.model,
  prompt_version: promptVersion,
  repeat: Number(values.repeat),
  promptfoo_exit: exitCode,
  rows,
};
writeLiveResults({ rows, summary, promptVersion, outDirAbs: outDir });
log(
  `wrote docs/D1/acceptance/live-results-${promptVersion}.md and ${join(outDir, "acceptance-live.json")}`,
);
await server1.close();
await server2.close();
await fixture.close();
process.exit(exitCode === 0 && rows.every((row) => row.pass) ? 0 : 1);
