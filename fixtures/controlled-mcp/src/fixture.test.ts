import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixtureHarness, startFixture, type FixtureHandle } from "./fixture.ts";

let fixture: FixtureHandle;
let harness: FixtureHarness;
let dir: string;

async function client(): Promise<Client> {
  const c = new Client({ name: "fixture-test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(fixture.mcpUrl)));
  return c;
}

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
    const c = await client();
    const tools = await c.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "artifact",
      "change",
      "forbidden",
      "read",
      "slow",
    ]);
    await c.close();
  });

  it("read has no side effects; change commits once", async () => {
    await harness.reset();
    const c = await client();
    const r = await c.callTool({ name: "read", arguments: {} });
    expect(JSON.parse((r.content as Array<{ text: string }>)[0]!.text)).toEqual({ counter: 0 });
    await c.callTool({ name: "change", arguments: { delta: 1 } });
    const state = await harness.state();
    expect(state.counter).toBe(1);
    expect(state.ledger.filter((e) => e.kind === "committed")).toHaveLength(1);
    await c.close();
  });

  it("slow cancellable stops before commit when the connection drops", async () => {
    await harness.reset();
    const c = await client();
    const call = c.callTool({ name: "slow", arguments: { mode: "cancellable" } });
    call.catch(() => undefined);
    const entered = await harness.waitEntered(10_000);
    expect(entered.mode).toBe("cancellable");
    await c.close(); // drops the HTTP connection
    // wait until ledger shows cancelled
    for (let i = 0; i < 100; i++) {
      const s = await harness.state();
      if (s.ledger.some((e) => e.kind === "cancelled")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const s = await harness.state();
    expect(s.counter).toBe(0);
    expect(s.ledger.some((e) => e.kind === "cancelled" && e.tool === "slow")).toBe(true);
    expect(s.ledger.filter((e) => e.kind === "committed")).toHaveLength(0);
  });

  it("slow uncancellable survives disconnection and commits on release", async () => {
    await harness.reset();
    const c = await client();
    const call = c.callTool({ name: "slow", arguments: { mode: "uncancellable" } });
    call.catch(() => undefined);
    const entered = await harness.waitEntered(10_000);
    await c.close();
    let s = await harness.state();
    expect(s.counter).toBe(0);
    expect(s.pending).toHaveLength(1);
    await harness.release(entered.call_id);
    for (let i = 0; i < 100; i++) {
      s = await harness.state();
      if (s.counter === 1) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(s.counter).toBe(1);
    expect(s.ledger.filter((e) => e.kind === "committed" && e.tool === "slow")).toHaveLength(1);
  });

  it("artifact rejects paths outside the fixture directory and registers digests", async () => {
    await harness.reset();
    const c = await client();
    const bad = await c.callTool({
      name: "artifact",
      arguments: { name: "../escape.txt", text: "x" },
    });
    expect(bad.isError).toBe(true);
    const good = await c.callTool({
      name: "artifact",
      arguments: { name: "result.txt", text: "D1" },
    });
    const parsed = JSON.parse((good.content as Array<{ text: string }>)[0]!.text) as {
      artifact: { sha256: string; path: string };
    };
    expect(parsed.artifact.path.startsWith(join(dir, "artifacts"))).toBe(true);
    expect(parsed.artifact.sha256).toHaveLength(64);
    await c.close();
  });
});
