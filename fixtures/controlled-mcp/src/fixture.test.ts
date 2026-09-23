import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
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
  it("times out a long poll, then still reports the next slow call", async () => {
    await harness.reset();
    const timedOut = await fetch(`${fixture.harnessUrl}/wait-entered?timeout_ms=1`, {
      method: "POST",
    });
    expect(timedOut.status).toBe(408);
    expect(await timedOut.json()).toEqual({ error: "no slow call entered before timeout" });
    const mcpClient = await client();
    try {
      const pendingEntry = harness.waitEntered();
      const call = mcpClient.callTool({ name: "slow", arguments: { mode: "cancellable" } });
      const entered = await pendingEntry;
      await harness.release(entered.call_id);
      expect((await call).isError).not.toBe(true);
    } finally {
      await mcpClient.close();
    }
  });

  it("waitEntered rejects when its signal aborts, and the next wait still sees the slow call", async () => {
    await harness.reset();
    const controller = new AbortController();
    const aborted = harness.waitEntered({ signal: controller.signal });
    controller.abort(new Error("caller gave up"));
    await expect(aborted).rejects.toThrow("caller gave up");
    const mcpClient = await client();
    try {
      const call = mcpClient.callTool({ name: "slow", arguments: { mode: "cancellable" } });
      const entered = await harness.waitEntered();
      await harness.release(entered.call_id);
      expect((await call).isError).not.toBe(true);
    } finally {
      await mcpClient.close();
    }
  });

  it("waitEntered polls again when the fixture ends a long poll without an entry", async () => {
    const answers = [
      { status: 408, body: { error: "no slow call entered before timeout" } },
      { status: 200, body: { call_id: "fx-1", mode: "cancellable" } },
    ];
    let requests = 0;
    const server = createServer((_req, res) => {
      const answer = answers[Math.min(requests, answers.length - 1)];
      requests += 1;
      res.writeHead(answer?.status ?? 500, { "content-type": "application/json" });
      res.end(JSON.stringify(answer?.body));
    });
    server.listen(0, "127.0.0.1");
    try {
      await once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no TCP port");
      const stub = new FixtureHarness(`http://127.0.0.1:${address.port}`);
      await expect(stub.waitEntered()).resolves.toEqual({ call_id: "fx-1", mode: "cancellable" });
      expect(requests).toBe(2);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("waitForState returns the last state it saw once its signal aborts", async () => {
    await harness.reset();
    const controller = new AbortController();
    let reads = 0;
    const state = await harness.waitForState(
      () => {
        reads += 1;
        controller.abort();
        return false;
      },
      { signal: controller.signal },
    );
    expect(reads).toBe(1);
    expect(state.counter).toBe(0);
  });

  it("answers a failed harness request with a 500 and keeps serving", async () => {
    const response = await fetch(`${fixture.harnessUrl}/release`, {
      method: "POST",
      body: "{not json",
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    await expect(harness.state()).resolves.toHaveProperty("counter");
  });

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
    const entered = await harness.waitEntered();
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
    const entered = await harness.waitEntered();
    await mcpClient.close();
    const before = await harness.state();
    expect(before.counter).toBe(0);
    expect(before.pending).toHaveLength(1);
    await harness.release(entered.call_id);
    const state = await harness.waitForState((current) => current.counter === 1);
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
