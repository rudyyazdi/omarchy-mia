import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { bodyLogLinesFor, sendJson, TOOL_USE_ID_META } from "@mia/mcp-http";
import { readFile } from "node:fs/promises";
import { BODY_LOG_FILE, FixtureHarness, startFixture, type FixtureHandle } from "./fixture.ts";

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

/** How long a unit test lets the ledger settle before its assertion reports what it saw. */
const SETTLE_TIMEOUT_MS = 2_000;

/** A stand-in for the harness server, answering each request with `answer`. */
const startStub = async (answer: (req: IncomingMessage, res: ServerResponse) => void) => {
  const server = createServer(answer);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("stub bound no TCP port");
  return {
    harness: new FixtureHarness(`http://127.0.0.1:${address.port}`),
    close: async () => {
      const closed = once(server, "close");
      server.closeAllConnections();
      server.close();
      await closed;
    },
  };
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

  it("waitEntered rejects when its signal aborts during an open long poll", async () => {
    const arrived = Promise.withResolvers<string | undefined>();
    const stub = await startStub((req) => arrived.resolve(req.url)); // never answers
    try {
      const controller = new AbortController();
      const waiting = stub.harness.waitEntered({ signal: controller.signal });
      expect(await arrived.promise).toBe("/wait-entered");
      controller.abort(new Error("caller gave up"));
      await expect(waiting).rejects.toThrow("caller gave up");
    } finally {
      await stub.close();
    }
  });

  it("waitEntered polls again when the fixture ends a long poll without an entry", async () => {
    const answers = [
      { status: 408, body: { error: "no slow call entered before timeout" } },
      { status: 200, body: { call_id: "fx-1", mode: "cancellable" } },
    ];
    const urls: (string | undefined)[] = [];
    const stub = await startStub((req, res) => {
      const answer = answers[urls.length];
      urls.push(req.url);
      sendJson(res, answer?.status ?? 500, answer?.body);
    });
    try {
      await expect(stub.harness.waitEntered()).resolves.toEqual({
        call_id: "fx-1",
        mode: "cancellable",
      });
      expect(urls).toEqual(["/wait-entered", "/wait-entered"]);
    } finally {
      await stub.close();
    }
  });

  it("waitEntered rejects a 408 that is not the fixture's own long-poll bound", async () => {
    const stub = await startStub((_req, res) => sendJson(res, 408, { error: "request timeout" }));
    try {
      await expect(stub.harness.waitEntered()).rejects.toThrow("wait-entered failed: 408");
    } finally {
      await stub.close();
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

  it("waitForState reads once more and returns when its signal aborts during the pause", async () => {
    await harness.reset();
    const controller = new AbortController();
    let reads = 0;
    await harness.waitForState(
      () => {
        reads += 1;
        // Runs once this read is judged, while waitForState pauses before the next one.
        if (reads === 1) queueMicrotask(() => controller.abort());
        return false;
      },
      { signal: controller.signal },
    );
    expect(reads).toBe(2);
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
    const state = await harness.waitForState((current) => current.counter === 1, {
      signal: AbortSignal.timeout(SETTLE_TIMEOUT_MS),
    });
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

  it("logs a tool call's request and response bodies under its tool-use id", async () => {
    await harness.reset();
    const mcpClient = await client();
    try {
      await mcpClient.callTool({
        name: "change",
        arguments: { delta: 2 },
        _meta: { [TOOL_USE_ID_META]: "toolu_fixture_change" },
      });
    } finally {
      await mcpClient.close();
    }
    expect(fixture.bodyLogFile).toBe(join(dir, BODY_LOG_FILE));
    const lines = bodyLogLinesFor(
      await readFile(fixture.bodyLogFile, "utf8"),
      "toolu_fixture_change",
    );
    expect(lines).toMatchObject([
      {
        direction: "request",
        body: { method: "tools/call", params: { name: "change", arguments: { delta: 2 } } },
      },
      { direction: "response", body: { result: { content: [{ type: "text" }] } } },
    ]);
  });
});
