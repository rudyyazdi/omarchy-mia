import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ApprovalBridge,
  ClaudeCodeAdapter,
  type RuntimeEvent,
  type PermissionDecision,
  type PermissionRequest,
  type TurnOptions,
} from "@mia/agent-adapter";
import { REDACTED } from "@mia/protocol";
import { FixtureHarness, startFixture, type FixtureHandle } from "@mia/controlled-mcp";
import { FAKE_RUNTIME, FAKE_RUNTIME_ENV, testProfile } from "./harness.ts";

/** How long the fake runtime may take to reach the fixture's slow tool. */
const SLOW_ENTERED_TIMEOUT_MS = 20_000;
/** How long the fixture's ledger may take to settle after the event that caused it. */
const LEDGER_SETTLE_TIMEOUT_MS = 5_000;
let dir: string;
let fixture: FixtureHandle;
let harness: FixtureHarness;
let bridge: ApprovalBridge;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "mia-e2e-"));
  fixture = await startFixture({ dir: join(dir, "fixture") });
  harness = new FixtureHarness(fixture.harnessUrl);
  bridge = new ApprovalBridge();
  await bridge.start();
});
afterAll(async () => {
  await bridge.close();
  await fixture.close();
  rmSync(dir, { recursive: true, force: true });
});

const adapter = () => {
  const profile = testProfile(dir, {
    executable: FAKE_RUNTIME,
    mcpServers: { d1: { type: "http", url: fixture.mcpUrl } },
  });
  return new ClaudeCodeAdapter(profile.runtime, bridge, FAKE_RUNTIME_ENV);
};

/** A first turn in a fresh runtime directory, with the given handlers. */
const turnOptions = (
  text: string,
  handlers: Pick<TurnOptions, "permissionHandler" | "onEvent">,
): TurnOptions => ({
  text,
  runtimeConversationId: `sess-${Math.random().toString(36).slice(2)}`,
  firstTurn: true,
  runtimeDir: join(dir, "runtime", Math.random().toString(36).slice(2)),
  turnIndex: 1,
  ...handlers,
});

const run = async (
  text: string,
  decide: (request: PermissionRequest) => PermissionDecision,
  during?: (handle: ReturnType<ClaudeCodeAdapter["submitTurn"]>) => Promise<void>,
) => {
  const events: RuntimeEvent[] = [];
  const requests: PermissionRequest[] = [];
  const handle = adapter().submitTurn(
    turnOptions(text, {
      permissionHandler: async (request) => {
        requests.push(request);
        return decide(request);
      },
      onEvent: (event) => events.push(event),
    }),
  );
  if (during) await during(handle);
  const result = await handle.result;
  return { result, events, requests };
};

describe("real adapter against a fake runtime process", () => {
  it("parses the stream, routes permission through the bridge with tool_use_id, and records results", async () => {
    await harness.reset();
    const { result, events, requests } = await run("READ then CHANGE", () => ({
      behavior: "allow",
    }));
    expect(result.status).toBe("completed");
    expect(result.init?.model).toBe("scripted-model");
    // The runtime's own messages stay available as evidence behind the normalized facts.
    expect(result.init?.evidence).toMatchObject({ type: "system", subtype: "init" });
    expect(result.summary).toMatchObject({ isError: false, outcome: "success", numTurns: 1 });
    expect(result.summary?.evidence).toMatchObject({ type: "result", subtype: "success" });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "runtime_started",
        "runtime_init",
        "text_delta",
        "tool_proposed",
        "tool_result",
        "turn_result",
        "runtime_exit",
      ]),
    );
    // Every stdout line is handled and retained before the turn ends.
    expect(events.at(-1)?.type).toBe("runtime_exit");
    const transcript = readFileSync(result.streamLogPath, "utf8").trimEnd().split("\n");
    expect(JSON.parse(transcript.at(-1) ?? "")).toMatchObject({ type: "result" });
    expect(requests.map((request) => [request.toolName, request.toolUseId])).toEqual([
      ["mcp__d1__read", "toolu_fake_read_1"],
      ["mcp__d1__change", "toolu_fake_change_1"],
    ]);
    const state = await harness.state();
    expect(state.counter).toBe(1);
    expect(result.launch.permission_prompt_tool).toBe("mcp__mia_approval__request");
    expect(result.launch.settings).toMatchObject({ permissions: { deny: ["mcp__d1__forbidden"] } });
  });

  it("a denied decision keeps the fixture unchanged and the runtime sees an error result", async () => {
    await harness.reset();
    const { result, events } = await run("CHANGE", () => ({ behavior: "deny", message: "no" }));
    expect(result.status).toBe("completed");
    expect((await harness.state()).counter).toBe(0);
    const toolResult = events.find((event) => event.type === "tool_result");
    expect(toolResult && toolResult.type === "tool_result" && toolResult.isError).toBe(true);
  });

  it("SIGKILL interruption stops the process, abandons held prompts, and the fixture cancels a cancellable action", async () => {
    await harness.reset();
    const abandoned: string[] = [];
    const { result, requests } = await run(
      "SLOW",
      (request) => {
        request.abandoned.addEventListener("abort", () => abandoned.push(request.toolName));
        return { behavior: "allow" };
      },
      async (handle) => {
        await harness.waitEntered({ signal: AbortSignal.timeout(SLOW_ENTERED_TIMEOUT_MS) });
        const cancellation = await handle.interrupt();
        expect(cancellation).toBe("forced_kill");
        await harness.waitForState(
          (state) => state.ledger.some((entry) => entry.kind === "cancelled"),
          {
            signal: AbortSignal.timeout(LEDGER_SETTLE_TIMEOUT_MS),
          },
        );
      },
    );
    expect(result.status).toBe("killed");
    expect(result.runtimeCancellation).toBe("forced_kill");
    expect(result.exit?.signal).toBe("SIGKILL");
    const state = await harness.state();
    expect(
      state.ledger.filter((entry) => entry.kind === "entered" && entry.tool === "slow"),
    ).toHaveLength(1);
    expect(state.ledger.some((entry) => entry.kind === "cancelled")).toBe(true);
    expect(state.counter).toBe(0);
    expect(requests.map((request) => request.toolName)).toEqual(["mcp__d1__slow"]);
  });

  it("redacts a schema-invalid JSON line by key in the transcript and the malformed event", async () => {
    const { result, events } = await run("MALFORMED", () => ({ behavior: "allow" }));
    expect(result.status).toBe("completed");
    const malformed = events.find((event) => event.type === "malformed_event");
    if (malformed?.type !== "malformed_event") throw new Error("no malformed_event emitted");
    expect(JSON.parse(malformed.raw)).toMatchObject({ type: "assistant", api_key: REDACTED });
    const transcript = readFileSync(result.streamLogPath, "utf8");
    expect(transcript).toContain(`"api_key":"${REDACTED}"`);
    expect(transcript).not.toContain("fake-short-credential");
  });

  it("reports an event handler that throws and still ends the turn, as failed", async () => {
    await harness.reset();
    const events: RuntimeEvent[] = [];
    const handle = adapter().submitTurn(
      turnOptions("SLOW", {
        permissionHandler: async () => ({ behavior: "allow" }),
        onEvent: (event) => {
          if (event.type === "runtime_init") throw new Error("handler failed");
          events.push(event);
        },
      }),
    );
    const result = await handle.result;
    expect(result.status).toBe("failed");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "runtime_stderr",
        text: expect.stringContaining("[mia] stopped reading runtime output"),
      }),
    );
  });

  it("reports a runtime crash as a failed turn with no result message", async () => {
    const { result } = await run("READ CRASH", () => ({ behavior: "allow" }));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("exited with code 3");
  });
});
