import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ApprovalBridge,
  ClaudeCodeAdapter,
  type AdapterEvent,
  type PermissionDecision,
  type PermissionRequest,
} from "@mia/agent-adapter";
import { FixtureHarness, startFixture, type FixtureHandle } from "@mia/controlled-mcp";
import { REPO_ROOT, testProfile } from "./harness.ts";

const FAKE = resolve(REPO_ROOT, "tests/fake-claude/bin.sh");
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

function adapter() {
  const profile = testProfile(dir, {
    executable: FAKE,
    mcpServers: { d1: { type: "http", url: fixture.mcpUrl } },
  });
  return new ClaudeCodeAdapter(profile.runtime, bridge);
}

async function run(
  text: string,
  decide: (req: PermissionRequest) => PermissionDecision,
  during?: (handle: ReturnType<ClaudeCodeAdapter["submitTurn"]>) => Promise<void>,
) {
  const events: AdapterEvent[] = [];
  const requests: PermissionRequest[] = [];
  const handle = adapter().submitTurn({
    text,
    runtimeConversationId: `sess-${Math.random().toString(36).slice(2)}`,
    firstTurn: true,
    runtimeDir: join(dir, "runtime", Math.random().toString(36).slice(2)),
    turnIndex: 1,
    permissionHandler: async (req) => {
      requests.push(req);
      return decide(req);
    },
    onEvent: (e) => events.push(e),
  });
  if (during) await during(handle);
  const result = await handle.result;
  return { result, events, requests };
}

describe("real adapter against a fake runtime process", () => {
  it("parses the stream, routes permission through the bridge with tool_use_id, and records results", async () => {
    await harness.reset();
    const { result, events, requests } = await run("READ then CHANGE", () => ({
      behavior: "allow",
    }));
    expect(result.status).toBe("completed");
    expect(result.init?.model).toBe("scripted-model");
    expect(events.map((e) => e.type)).toEqual(
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
    expect(requests.map((r) => [r.tool_name, r.tool_use_id])).toEqual([
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
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult && toolResult.type === "tool_result" && toolResult.is_error).toBe(true);
  });

  it("SIGKILL interruption stops the process, abandons held prompts, and the fixture cancels a cancellable action", async () => {
    await harness.reset();
    const abandoned: string[] = [];
    const { result, requests } = await run(
      "SLOW",
      (req) => {
        req.abandoned.addEventListener("abort", () => abandoned.push(req.tool_name));
        return { behavior: "allow" };
      },
      async (handle) => {
        await harness.waitEntered(20_000);
        const cancellation = await handle.interrupt();
        expect(cancellation).toBe("forced_kill");
        for (let i = 0; i < 100; i++) {
          const s = await harness.state();
          if (s.ledger.some((l) => l.kind === "cancelled")) break;
          await new Promise((r) => setTimeout(r, 20));
        }
      },
    );
    expect(result.status).toBe("killed");
    expect(result.runtimeCancellation).toBe("forced_kill");
    expect(result.exit?.signal).toBe("SIGKILL");
    const state = await harness.state();
    expect(state.ledger.filter((l) => l.kind === "entered" && l.tool === "slow")).toHaveLength(1);
    expect(state.ledger.some((l) => l.kind === "cancelled")).toBe(true);
    expect(state.counter).toBe(0);
    expect(requests.map((r) => r.tool_name)).toEqual(["mcp__d1__slow"]);
  });

  it("reports a runtime crash as a failed turn with no result message", async () => {
    const { result } = await run("READ CRASH", () => ({ behavior: "allow" }));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("exited with code 3");
  });
});
