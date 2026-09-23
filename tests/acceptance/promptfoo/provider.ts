/**
 * promptfoo custom provider: runs one live scenario against the running Mia servers and returns the evidence
 * as JSON. The prompt text is informational; the scenario definition owns the exact user text.
 */
import { resolve } from "node:path";
import { LiveCallBudget } from "@mia/agent-adapter";
import { FixtureHarness } from "@mia/controlled-mcp";
import { errorMessage } from "@mia/protocol";
import { MiaClient } from "@mia/text-client";
import { readScenarioName, runScenario, scenarioFor, type ScenarioContext } from "./scenarios.ts";

/** How long one scenario may run: its longest scenarios wait up to ten minutes for each of two tasks. */
const SCENARIO_TIMEOUT_MS = 20 * 60_000;
/** How long connecting, or one setup command's acknowledgement, may take. */
const SETUP_STEP_TIMEOUT_MS = 30_000;

interface ProviderOptions {
  id?: string;
  config?: { promptVersion?: string };
}

export default class MiaScenarioProvider {
  private readonly providerId: string;
  private readonly promptVersion: string;

  constructor(options: ProviderOptions = {}) {
    this.providerId = options.id ?? "mia-live";
    this.promptVersion =
      options.config?.promptVersion ?? process.env.MIA_AGENT_PROMPT_VERSION ?? "agent-v1";
  }

  id(): string {
    return this.providerId;
  }

  async callApi(
    _prompt: string,
    context?: { vars?: Record<string, unknown> },
  ): Promise<{ output: string; error?: string; format?: string }> {
    const read = readScenarioName(context?.vars?.scenario);
    if (!read.ok) return { output: "", error: read.error };
    const scenarioName = read.name;
    const scenario = scenarioFor(scenarioName);
    const urlVar = scenario.profile === "fixture-test" ? "MIA_URL_1" : "MIA_URL_2";
    const secretVar =
      scenario.profile === "fixture-test" ? "MIA_SECRET_FILE_1" : "MIA_SECRET_FILE_2";
    const url = process.env[urlVar];
    const secretFile = process.env[secretVar];
    const harnessUrl = process.env.MIA_FIXTURE_HARNESS_URL;
    if (!url || !secretFile || !harnessUrl)
      return {
        output: "",
        error: `harness environment missing (${urlVar}, ${secretVar}, MIA_FIXTURE_HARNESS_URL)`,
      };
    const budget = LiveCallBudget.fromEnv(
      process.env,
      resolve(process.env.MIA_REPO_ROOT ?? ".", ".mia-state/live-calls.jsonl"),
    );
    const clientId = `pf_${scenarioName}_${Date.now().toString(36)}`;
    const scenarioDeadline = AbortSignal.timeout(SCENARIO_TIMEOUT_MS);
    const within = (ms: number) => AbortSignal.any([scenarioDeadline, AbortSignal.timeout(ms)]);
    const setupStep = () => ({ signal: within(SETUP_STEP_TIMEOUT_MS) });
    const connect = async () => {
      const connected = new MiaClient({
        url,
        secret: MiaClient.readSecret(secretFile),
        clientId,
        build: { name: "promptfoo-provider", version: "0.1.0", commit: null, dirty: null },
      });
      await connected.connect(setupStep());
      return connected;
    };
    const client = await connect();
    const extra: MiaClient[] = [];
    try {
      await client.sendDiagnostics(setupStep());
      await client.startConversation(setupStep());
      const ctx: ScenarioContext = {
        client,
        within,
        harness: new FixtureHarness(harnessUrl),
        reconnect: async () => {
          const reconnected = await connect();
          extra.push(reconnected);
          return reconnected;
        },
        budget: (label) => budget.take(`live:${scenarioName}:${label}`, scenario.profile),
      };
      const evidence = await runScenario(scenario, ctx);
      return {
        output: JSON.stringify({ ...evidence, prompt_version: this.promptVersion }),
        format: "json",
      };
    } catch (error) {
      return {
        output: JSON.stringify({
          scenario: scenarioName,
          conversation_id: client.conversationId,
          error: errorMessage(error),
          events: client.events.map((event) => ({ type: event.type, payload: event.payload })),
        }),
        error: errorMessage(error),
      };
    } finally {
      client.close();
      for (const extraClient of extra) extraClient.close();
    }
  }
}
