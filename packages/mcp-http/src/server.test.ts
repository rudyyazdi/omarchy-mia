import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  McpServer,
  startMcpHttpServer,
  type McpHttpServerHandle,
  type McpRequestContext,
} from "./server.ts";

let dir: string;
let handle: McpHttpServerHandle | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mia-mcp-http-"));
});
afterEach(async () => {
  await handle?.close();
  handle = undefined;
  await rm(dir, { recursive: true, force: true });
});

const post = (url: string, body: unknown, signal?: AbortSignal) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });

const initializeRequest = (clientName = "mcp-http-test") => ({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: clientName, version: "0" },
  },
});

const initialize = (url: string) => post(url, initializeRequest());

const holdRequest = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "hold" } };

/**
 * Serves one tool, `hold`, that keeps its response open until the connection closes. `entered`
 * resolves with the request's context once the tool is running; `contexts` has every request's.
 */
const startHoldingServer = async () => {
  const entered = Promise.withResolvers<McpRequestContext>();
  const contexts: McpRequestContext[] = [];
  const started = await startMcpHttpServer({
    createServer: (ctx) => {
      contexts.push(ctx);
      const server = new McpServer({ name: "mcp-http-test", version: "0" });
      server.registerTool(
        "hold",
        { description: "Holds the response open until the connection closes." },
        async () => {
          const closed = once(ctx.connectionClosed, "abort");
          entered.resolve(ctx);
          await closed;
          return { content: [] };
        },
      );
      return server;
    },
  });
  handle = started;
  return { handle: started, entered: entered.promise, contexts };
};

describe("MCP HTTP server", () => {
  it("keeps serving when its request log cannot be written", async () => {
    // A directory cannot be appended to, so every log write fails with EISDIR.
    const failures: unknown[] = [];
    handle = await startMcpHttpServer({
      logFile: dir,
      reportLogFailure: (error) => failures.push(error),
      createServer: () => new McpServer({ name: "mcp-http-test", version: "0" }),
    });

    const initialized = await initialize(handle.url);
    expect(initialized.status).toBe(200);
    expect(await initialized.text()).toContain('"serverInfo"');

    const refused = await fetch(handle.url);
    expect(refused.status).toBe(405);
    await refused.body?.cancel();

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code: "EISDIR" });
  });

  it("answers 500 when a request fails, and keeps serving", async () => {
    let calls = 0;
    handle = await startMcpHttpServer({
      createServer: () => {
        calls += 1;
        if (calls === 1) throw new Error("factory failed");
        return new McpServer({ name: "mcp-http-test", version: "0" });
      },
    });

    const failed = await initialize(handle.url);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "factory failed" });

    const recovered = await initialize(handle.url);
    expect(recovered.status).toBe(200);
    await recovered.body?.cancel();
  });

  it("refuses the standalone GET stream with 405 and a JSON-RPC error", async () => {
    const { handle: server } = await startHoldingServer();

    const refused = await fetch(server.url, { headers: { accept: "text/event-stream" } });

    expect(refused.status).toBe(405);
    expect(refused.headers.get("allow")).toBe("POST, DELETE");
    expect(await refused.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  it("answers 404 on any path other than /mcp", async () => {
    const { handle: server, contexts } = await startHoldingServer();
    const other = new URL("/other", server.url).href;

    const posted = await post(other, initializeRequest());
    expect(posted.status).toBe(404);
    expect(await posted.json()).toEqual({ error: "not found" });

    const fetched = await fetch(new URL("/", server.url));
    expect(fetched.status).toBe(404);
    await fetched.body?.cancel();

    expect(contexts).toEqual([]);
  });

  it("refuses a POST body over 4 MiB and keeps serving", async () => {
    const { handle: server, contexts } = await startHoldingServer();

    // A valid initialize request, so only the size limit stands between it and a 200.
    const oversized = post(server.url, initializeRequest("x".repeat(4 * 1024 * 1024))).then(
      async (response) => ({ status: response.status, body: await response.text() }),
    );
    await expect(oversized).resolves.toEqual({
      status: 500,
      body: JSON.stringify({ error: "request body too large" }),
    });
    expect(contexts).toEqual([]);

    const recovered = await initialize(server.url);
    expect(recovered.status).toBe(200);
    await recovered.body?.cancel();
  });

  it("aborts connectionClosed when the client disconnects before the response", async () => {
    const { handle: server, entered } = await startHoldingServer();
    const client = new AbortController();

    const call = post(server.url, holdRequest, client.signal).then(async (response) =>
      response.text(),
    );
    const ctx = await entered;
    const aborted = once(ctx.connectionClosed, "abort");
    client.abort();

    await expect(call).rejects.toThrow();
    await aborted;
    expect(ctx.connectionClosed.aborted).toBe(true);
  });

  it("does not abort connectionClosed after a completed response", async () => {
    const { handle: server, contexts } = await startHoldingServer();

    const initialized = await initialize(server.url);
    expect(initialized.status).toBe(200);
    await initialized.text();
    // Closing the server closes the kept-alive connection, so the response's close has fired.
    await server.close();
    handle = undefined;

    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.connectionClosed.aborted).toBe(false);
  });

  it("closes with a request still open", async () => {
    const { handle: server, entered } = await startHoldingServer();

    const call = post(server.url, holdRequest).then(async (response) => response.text());
    const ctx = await entered;

    await server.close();
    handle = undefined;

    await expect(call).rejects.toThrow();
    expect(ctx.connectionClosed.aborted).toBe(true);
  });
});
