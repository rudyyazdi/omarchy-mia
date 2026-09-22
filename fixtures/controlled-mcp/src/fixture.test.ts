import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { FixtureHarness, startFixture, type FixtureHandle } from "./fixture.ts";

let fixture: FixtureHandle;
let harness: FixtureHarness;
let dir: string;

const client = async (): Promise<Client> => {
  const mcpClient = new Client({ name: "fixture-test", version: "0" });
  await mcpClient.connect(new StreamableHTTPClientTransport(new URL(fixture.mcpUrl)));
  return mcpClient;
};

/** The first text block of a tool result; the fixture always answers with one. */
const firstText = (result: Awaited<ReturnType<Client["callTool"]>>): string => {
  const first: unknown = Array.isArray(result.content) ? result.content[0] : undefined;
  if (
    typeof first === "object" &&
    first !== null &&
    "text" in first &&
    typeof first.text === "string"
  ) {
    return first.text;
  }
  throw new Error("tool result carried no text block");
};

const ArtifactResult = z.object({ artifact: z.object({ sha256: z.string(), path: z.string() }) });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "mia-fixture-"));
  fixture = await startFixture({ dir });
  harness = new FixtureHarness(fixture.harnessUrl);
});
afterAll(async () => {
  await fixture.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("controlled fixture", () => {
  it("lists exactly the five tools", async () => {
    const mcpClient = await client();
    const tools = await mcpClient.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "artifact",
      "change",
      "forbidden",
      "read",
      "slow",
    ]);
    await mcpClient.close();
  });

  it("read has no side effects; change commits once", async () => {
    await harness.reset();
    const mcpClient = await client();
    const result = await mcpClient.callTool({ name: "read", arguments: {} });
    expect(JSON.parse(firstText(result))).toEqual({ counter: 0 });
    await mcpClient.callTool({ name: "change", arguments: { delta: 1 } });
    const state = await harness.state();
    expect(state.counter).toBe(1);
    expect(state.ledger.filter((entry) => entry.kind === "committed")).toHaveLength(1);
    await mcpClient.close();
  });

  it("slow cancellable stops before commit when the connection drops", async () => {
    await harness.reset();
    const mcpClient = await client();
    const call = mcpClient.callTool({ name: "slow", arguments: { mode: "cancellable" } });
    call.catch(() => undefined);
    const entered = await harness.waitEntered(10_000);
    expect(entered.mode).toBe("cancellable");
    await mcpClient.close(); // drops the HTTP connection
    const state = await harness.waitForState((current) =>
      current.ledger.some((entry) => entry.kind === "cancelled"),
    );
    expect(state.counter).toBe(0);
    expect(state.ledger.some((entry) => entry.kind === "cancelled" && entry.tool === "slow")).toBe(
      true,
    );
    expect(state.ledger.filter((entry) => entry.kind === "committed")).toHaveLength(0);
  });

  it("slow uncancellable survives disconnection and commits on release", async () => {
    await harness.reset();
    const mcpClient = await client();
    const call = mcpClient.callTool({ name: "slow", arguments: { mode: "uncancellable" } });
    call.catch(() => undefined);
    const entered = await harness.waitEntered(10_000);
    await mcpClient.close();
    let state = await harness.state();
    expect(state.counter).toBe(0);
    expect(state.pending).toHaveLength(1);
    await harness.release(entered.call_id);
    for (let attempt = 0; attempt < 100; attempt++) {
      state = await harness.state();
      if (state.counter === 1) break;
      await sleep(20);
    }
    expect(state.counter).toBe(1);
    expect(
      state.ledger.filter((entry) => entry.kind === "committed" && entry.tool === "slow"),
    ).toHaveLength(1);
  });

  it("artifact rejects paths outside the fixture directory and registers digests", async () => {
    await harness.reset();
    const mcpClient = await client();
    const bad = await mcpClient.callTool({
      name: "artifact",
      arguments: { name: "../escape.txt", text: "x" },
    });
    expect(bad.isError).toBe(true);
    const good = await mcpClient.callTool({
      name: "artifact",
      arguments: { name: "result.txt", text: "D1" },
    });
    const parsed = ArtifactResult.parse(JSON.parse(firstText(good)));
    expect(parsed.artifact.path.startsWith(join(dir, "artifacts"))).toBe(true);
    expect(parsed.artifact.sha256).toHaveLength(64);
    await mcpClient.close();
  });
});
