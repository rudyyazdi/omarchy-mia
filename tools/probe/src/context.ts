import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { match } from "ts-pattern";
import {
  ApprovalBridge,
  ClaudeCodeAdapter,
  LiveCallBudget,
  readHookEvidence,
  validateRuntimeConfig,
  type AdapterEvent,
  type PermissionHandler,
  type RuntimeConfig,
} from "@mia/agent-adapter";
import { FixtureHarness, startFixture } from "@mia/controlled-mcp";
import { redactValue } from "@mia/protocol";
import type { ProbeOptions, StepRecord, StepSpec } from "./record.ts";

export const log = (...args: unknown[]) => console.log(`[probe]`, ...args);

const describeEvent = (event: AdapterEvent): string =>
  match(event)
    .with(
      { type: "tool_proposed" },
      (proposed) => `${proposed.toolIdentity} ${proposed.runtimeCallId}`,
    )
    .with({ type: "runtime_stderr" }, (stderr) => stderr.text.trim())
    .otherwise(() => "");

/**
 * Owns one probe run's evidence directory, fixture, approval bridge and live-call budget, and the
 * records of every step run so far. `shutdown` releases the fixture and bridge and exits.
 */
export class ProbeContext {
  readonly records: StepRecord[] = [];

  private constructor(
    readonly options: ProbeOptions,
    readonly dirs: { out: string; examples: string; fixture: string },
    private readonly services: {
      budget: LiveCallBudget;
      fixture: Awaited<ReturnType<typeof startFixture>>;
      harness: FixtureHarness;
      bridge: ApprovalBridge;
    },
  ) {}

  static async start(options: ProbeOptions): Promise<ProbeContext> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const out = resolve(options.out, stamp);
    mkdirSync(out, { recursive: true, mode: 0o700 });
    const examples = resolve(options.examples);
    mkdirSync(examples, { recursive: true });
    const budget = LiveCallBudget.fromEnv(resolve(".mia-state/live-calls.jsonl"));
    const fixtureDir = join(out, "fixture");
    const fixture = await startFixture({ dir: fixtureDir });
    const harness = new FixtureHarness(fixture.harnessUrl);
    const bridge = new ApprovalBridge();
    await bridge.start();
    return new ProbeContext(
      options,
      { out, examples, fixture: fixtureDir },
      { budget, fixture, harness, bridge },
    );
  }

  get harness(): FixtureHarness {
    return this.services.harness;
  }

  runtimeDir(sessionId: string): string {
    return join(this.dirs.out, "runtime", sessionId);
  }

  get bridgeUrl(): string {
    return this.services.bridge.url;
  }

  /** Counts one live runtime call against the shared budget and logs it; throws once the cap is reached. */
  takeLiveCall(label: string, model: string): void {
    const { budget } = this.services;
    const callNumber = budget.take(`probe:${label}`, model);
    log(`step ${label} (live call ${callNumber}/${budget.cap})`);
  }

  liveCallsUsed(): number {
    return this.services.budget.used();
  }

  /** Answers every bridge permission request with `handler` while `run` is in flight. */
  async withBridgeHandler<T>(handler: PermissionHandler, run: () => Promise<T>): Promise<T> {
    this.services.bridge.setHandler(handler);
    try {
      return await run();
    } finally {
      this.services.bridge.setHandler(null);
    }
  }

  async shutdown(code: number): Promise<never> {
    await this.services.bridge.close();
    await this.services.fixture.close();
    process.exit(code);
  }

  wants(name: string): boolean {
    return !this.options.only || this.options.only.split(",").includes(name);
  }

  baseConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
    return {
      kind: "claude-code",
      executable: "claude",
      model: this.options.model,
      effort: "medium",
      workingDirectory: join(this.dirs.out, "work"),
      builtinTools: [],
      mcpServers: { d1: { type: "http", url: this.services.fixture.mcpUrl } },
      toolPolicy: {
        mcp__d1__read: "allow",
        mcp__d1__change: "ask",
        mcp__d1__slow: "ask",
        mcp__d1__artifact: "ask",
        mcp__d1__forbidden: "deny",
      },
      agentPromptFile: resolve("prompts/agent-v1.md"),
      outputDirectories: [join(this.dirs.fixture, "artifacts")],
      env: {},
      extraSettings: {},
      ...overrides,
    };
  }

  save(name: string, data: unknown): void {
    writeFileSync(join(this.dirs.out, `${name}.json`), JSON.stringify(redactValue(data), null, 2), {
      mode: 0o600,
    });
  }

  /** One live turn against the real runtime, counted against the budget, recorded and saved. */
  async runStep(spec: StepSpec): Promise<StepRecord> {
    validateRuntimeConfig(spec.config);
    const step: StepRecord = {
      name: spec.name,
      session_id: spec.sessionId,
      first_turn: spec.firstTurn,
      prompt: spec.prompt,
      events: [],
      permission_requests: [],
      turn: null,
      ledger_after: null,
      hook_evidence: null,
      notes: [],
      checks: {},
    };
    const { bridge, harness } = this.services;
    this.takeLiveCall(spec.name, spec.config.model);
    const adapter = new ClaudeCodeAdapter(spec.config, bridge);
    const handle = adapter.submitTurn({
      text: spec.prompt,
      runtimeConversationId: spec.sessionId,
      firstTurn: spec.firstTurn,
      runtimeDir: this.runtimeDir(spec.sessionId),
      turnIndex: spec.turnIndex,
      onEvent: (event) => {
        step.events.push(event);
        if (event.type === "text_delta") process.stdout.write(event.text);
        else if (event.type !== "assistant_message") log(event.type, describeEvent(event));
      },
      permissionHandler: async (request) => {
        const decision = await spec.decide(request, step);
        step.permission_requests.push({
          request: request.raw,
          decision,
          abandoned: request.abandoned.aborted,
        });
        log("permission", request.toolName, request.toolUseId, "->", decision.behavior);
        return decision;
      },
    });
    if (spec.during) await spec.during(handle, step);
    step.turn = await handle.result;
    process.stdout.write("\n");
    step.ledger_after = await harness.state();
    step.hook_evidence = readHookEvidence(step.turn.hookEvidencePath);
    this.records.push(step);
    this.save(`step-${spec.turnIndex}-${spec.name}`, step);
    return step;
  }
}
