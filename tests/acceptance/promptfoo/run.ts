/**
 * Live-lane runner: starts the controlled fixture and both server profiles, runs the promptfoo eval with N repeats,
 * enriches every result with catalog evidence (reported model/effort, runtime version, export verification) and
 * writes the live rows of the acceptance record. Every turn counts against the shared live-call budget.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { startFixture } from "@mia/controlled-mcp";
import { Catalog, exportConversation, snapshotConversation, verifyExport } from "@mia/records";
import { loadProfile, startServer, type MiaServer } from "@mia/server";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const { values } = parseArgs({
  options: {
    repeat: { type: "string", default: "2" },
    scenarios: { type: "string" },
    "agent-prompt": { type: "string", default: "prompts/agent-v1.md" },
    model: { type: "string", default: "claude-sonnet-5" },
    out: { type: "string" },
  },
});
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = resolve(values.out ?? join(REPO_ROOT, ".mia-state", "live", stamp));
mkdirSync(outDir, { recursive: true, mode: 0o700 });
const log = (m: string) => console.log(`[live] ${m}`);

type Row = Record<string, unknown>;
function writeLiveResults(
  rows: Row[],
  summary: Record<string, unknown>,
  promptVersion: string,
  outDirAbs: string,
): void {
  writeFileSync(join(outDirAbs, "acceptance-live.json"), JSON.stringify(summary, null, 2));
  // Committed markdown must not carry personal absolute paths.
  const outDir = outDirAbs.startsWith(REPO_ROOT)
    ? outDirAbs.slice(REPO_ROOT.length + 1)
    : outDirAbs;
  const md = [
    `# Live acceptance results (${promptVersion}, ${summary.model})`,
    "",
    `Generated ${summary.generated_at} from \`${outDir}\` (private evidence directory). ${rows.filter((r) => r.pass).length}/${rows.length} rows passed. Lane L = live runtime; ledger evidence from the controlled fixture. "reported effort: unverified" means the turn used no tool, so the PreToolUse hook produced no effort evidence.`,
    "",
    "| scenario | repeat | pass | conversation | reported model | reported effort | runtime | ledger commits | reason |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((r) => {
      const rt = (r.runtime ?? {}) as Record<string, unknown>;
      const ledger = r.ledger as { commits?: Array<{ tool: string }> } | null;
      return `| ${r.scenario} | ${r.repeat} | ${r.pass ? "pass" : "FAIL"} | ${r.conversation_id ?? "-"} | ${(rt.reported_model as string[] | undefined)?.join(",") ?? "-"} | ${(rt.reported_effort as string[] | undefined)?.join(",") ?? "-"} | ${rt.runtime_version ?? "-"} | ${ledger?.commits?.map((c) => c.tool).join(",") || "none"} | ${String(r.reason).replace(/\|/g, "/")} |`;
    }),
  ];
  mkdirSync(join(REPO_ROOT, "docs/D1/acceptance"), { recursive: true });
  writeFileSync(
    join(REPO_ROOT, "docs/D1/acceptance", `live-results-${promptVersion}.md`),
    md.join("\n") + "\n",
  );
}

const fixtureDir = join(outDir, "fixture");
const fixture = await startFixture({ dir: fixtureDir });
log(`fixture ${fixture.mcpUrl} harness ${fixture.harnessUrl}`);
const env = {
  ...process.env,
  MIA_FIXTURE_MCP_URL: fixture.mcpUrl,
  MIA_FIXTURE_DIR: fixtureDir,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? ".", ".local", "state"),
};
const promptVersion = resolve(REPO_ROOT, values["agent-prompt"]!)
  .split("/")
  .pop()!
  .replace(/\.md$/, "");

async function startProfile(name: string, index: number): Promise<MiaServer> {
  const profile = loadProfile(join(REPO_ROOT, "examples", "config", `${name}.json`), env);
  profile.stateDirectory = join(outDir, `state-${index}`);
  profile.server = {
    ...profile.server,
    port: 0,
    secretFile: join(outDir, `state-${index}`, "client-secret"),
  };
  profile.runtime.workingDirectory = join(outDir, `work-${index}`);
  profile.runtime.agentPromptFile = resolve(REPO_ROOT, values["agent-prompt"]!);
  profile.runtime.model = values.model!;
  const logs: string[] = [];
  const server = await startServer({
    profile,
    log: (m) => logs.push(`${new Date().toISOString()} ${m}`),
  });
  process.on("exit", () =>
    writeFileSync(join(outDir, `server-${index}.log`), logs.join("\n") + "\n"),
  );
  log(`server ${name} at ${server.gateway.url}`);
  return server;
}

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
  values.repeat!,
  "--no-progress-bar",
];
if (values.scenarios) args.push("--filter-pattern", `^(${values.scenarios.split(",").join("|")})$`);
log(`promptfoo ${args.join(" ")}`);
const exitCode = await new Promise<number>((r) => {
  const child = spawn(join(REPO_ROOT, "node_modules/.bin/promptfoo"), args, {
    cwd: join(REPO_ROOT, "tests/acceptance/promptfoo"),
    env: pfEnv,
    stdio: "inherit",
  });
  child.on("close", (code) => r(code ?? 1));
});
log(`promptfoo exited ${exitCode}`);

interface PfResult {
  success: boolean;
  testCase?: { vars?: Record<string, unknown>; description?: string };
  vars?: Record<string, unknown>;
  response?: { output?: unknown; error?: string };
  gradingResult?: { reason?: string; pass?: boolean };
  error?: string;
}
let rows: Row[] = [];
if (existsSync(resultsPath)) {
  const raw = JSON.parse(readFileSync(resultsPath, "utf8")) as {
    results?: { results?: PfResult[] };
  };
  const results = raw.results?.results ?? [];
  const catalogs = [
    new Catalog(server1.profile.stateDirectory, { readonly: true }),
    new Catalog(server2.profile.stateDirectory, { readonly: true }),
  ];
  let repeatCounters: Record<string, number> = {};
  for (const r of results) {
    const scenario = String(r.testCase?.vars?.scenario ?? r.vars?.scenario ?? "?");
    repeatCounters[scenario] = (repeatCounters[scenario] ?? 0) + 1;
    let evidence: Record<string, unknown> = {};
    try {
      evidence =
        typeof r.response?.output === "string"
          ? (JSON.parse(r.response.output) as Record<string, unknown>)
          : ((r.response?.output as Record<string, unknown>) ?? {});
    } catch {
      evidence = { parse_error: true };
    }
    const conversationId = evidence.conversation_id as string | undefined;
    let runtime: Record<string, unknown> = {};
    let exportResult: Record<string, unknown> | null = null;
    if (conversationId) {
      const catalog = catalogs.find((c) =>
        c.get("SELECT id FROM conversations WHERE id = ?", conversationId),
      );
      if (catalog) {
        const snap = snapshotConversation(catalog, conversationId);
        const execs = snap.tables.executions;
        const identity = snap.tables.provenance_entries.find((p) => p.role === "runtime_identity");
        const identityArtifact = identity?.artifact_id
          ? snap.tables.artifacts.find((a) => a.id === identity.artifact_id)
          : undefined;
        let runtimeVersion: string | null = null;
        if (identityArtifact?.object_digest) {
          try {
            runtimeVersion =
              (
                JSON.parse(
                  readFileSync(
                    join(
                      catalog.paths.root,
                      (identityArtifact.storage_key as string) ??
                        join(
                          "objects",
                          "sha256",
                          String(identityArtifact.object_digest).slice(0, 2),
                          String(identityArtifact.object_digest),
                        ),
                    ),
                    "utf8",
                  ),
                ) as { runtime_version?: string }
              ).runtime_version ?? null;
          } catch {
            runtimeVersion = (identity?.version as string) ?? null;
          }
        }
        runtime = {
          requested_model: [...new Set(execs.map((e) => e.requested_model))],
          reported_model: [...new Set(execs.map((e) => e.reported_model ?? "unreported"))],
          requested_effort: [...new Set(execs.map((e) => e.requested_effort))],
          reported_effort: [...new Set(execs.map((e) => e.reported_effort ?? "unverified"))],
          runtime_version: runtimeVersion ?? identity?.version ?? null,
          event_count: snap.cutoff_sequence,
          task_ids: snap.tables.tasks.map((t) => t.id),
        };
        if (scenario === "artifact-export" && r.success) {
          const target = join(outDir, "exports", `${conversationId}-${repeatCounters[scenario]}`);
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
            exportResult = { error: error instanceof Error ? error.message : String(error) };
          }
        }
      }
    }
    const exportOk = exportResult === null || exportResult.verified === true;
    rows.push({
      scenario,
      repeat: repeatCounters[scenario],
      lane: "L",
      pass: r.success && exportOk,
      reason:
        (r.gradingResult?.reason ?? r.error ?? r.response?.error ?? "") +
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
  for (const c of catalogs) c.close();
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
writeLiveResults(rows, summary, promptVersion, outDir);
log(
  `wrote docs/D1/acceptance/live-results-${promptVersion}.md and ${join(outDir, "acceptance-live.json")}`,
);
await server1.close();
await server2.close();
await fixture.close();
process.exit(exitCode === 0 && rows.every((r) => r.pass) ? 0 : 1);
