import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { Agent, request } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { TOOL_USE_ID_META } from "./body-log.ts";
import { readLogEntries } from "./log-fixture.ts";
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
  try {
    await handle?.close();
  } finally {
    handle = undefined;
    await rm(dir, { recursive: true, force: true });
  }
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

/** POSTs an initialize request through `agent` and resolves with the status once the body is read. */
const initializeThrough = async (url: string, agent: Agent): Promise<number> => {
  const response = Promise.withResolvers<number>();
  const outgoing = request(
    url,
    {
      method: "POST",
      agent,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
    },
    (incoming) => {
      incoming.resume();
      incoming.once("end", () => response.resolve(incoming.statusCode ?? 0));
      incoming.once("error", response.reject);
    },
  );
  outgoing.once("error", response.reject);
  outgoing.end(JSON.stringify(initializeRequest()));
  return response.promise;
};

const bodyLimitBytes = 4 * 1024 * 1024;

/** A valid initialize request whose JSON is exactly `bytes` long, so only its size can refuse it. */
const initializeRequestOfSize = (bytes: number) =>
  initializeRequest("x".repeat(bytes - JSON.stringify(initializeRequest("")).length));

const holdRequest = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "hold" } };

/**
 * Serves one tool, `hold`, that keeps its response open until the connection closes. `entered`
 * resolves with the request's context once the tool is running; `contexts` has every request's.
 * The server is also stored in `handle`, so `afterEach` closes it even when the test fails.
 */
const startHoldingServer = async (options: { logFile?: string } = {}) => {
  const entered = Promise.withResolvers<McpRequestContext>();
  const contexts: McpRequestContext[] = [];
  const started = await startMcpHttpServer({
    logFile: options.logFile,
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
    // A directory cannot be opened for appending, so the log fails with EISDIR.
    const failures: unknown[] = [];
    const reported = Promise.withResolvers<undefined>();
    handle = await startMcpHttpServer({
      logFile: dir,
      reportLogFailure: (error) => {
        failures.push(error);
        reported.resolve(undefined);
      },
      createServer: () => new McpServer({ name: "mcp-http-test", version: "0" }),
    });

    const initialized = await initialize(handle.url);
    expect(initialized.status).toBe(200);
    expect(await initialized.text()).toContain('"serverInfo"');

    const refused = await fetch(handle.url);
    expect(refused.status).toBe(405);
    await refused.body?.cancel();

    await reported.promise;
    await handle.close();
    handle = undefined;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code: "EISDIR" });
  });

  it("does not pile up socket listeners across requests on a kept-alive connection", async () => {
    // Node publishes each request the server starts, with its socket, on this channel.
    const sockets = new Set<Socket>();
    const errorListenersAtStart: number[] = [];
    const onRequestStart = (message: unknown) => {
      if (typeof message !== "object" || message === null || !("socket" in message)) return;
      if (!(message.socket instanceof Socket)) return;
      sockets.add(message.socket);
      errorListenersAtStart.push(message.socket.listenerCount("error"));
    };
    // One socket, kept alive, so every request arrives on the same connection.
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    subscribe("http.server.request.start", onRequestStart);
    try {
      handle = await startMcpHttpServer({
        logFile: join(dir, "requests.jsonl"),
        createServer: () => new McpServer({ name: "mcp-http-test", version: "0" }),
      });
      const statuses: number[] = [];
      for (const _ of Array.from({ length: 12 }))
        statuses.push(await initializeThrough(handle.url, agent));
      expect(statuses).toEqual(Array.from({ length: 12 }, () => 200));
    } finally {
      agent.destroy();
      unsubscribe("http.server.request.start", onRequestStart);
    }
    expect(sockets.size).toBe(1);
    expect(errorListenersAtStart).toEqual(
      Array.from({ length: 12 }, () => errorListenersAtStart[0]),
    );
  });

  it("writes every request's log lines by the time it closes", async () => {
    const logFile = join(dir, "requests.jsonl");
    handle = await startMcpHttpServer({
      logFile,
      createServer: () => new McpServer({ name: "mcp-http-test", version: "0" }),
    });
    const initialized = await initialize(handle.url);
    await initialized.text();
    await handle.close();
    handle = undefined;

    const entries: unknown[] = await readLogEntries(logFile);
    expect(entries).toEqual([
      expect.objectContaining({ ev: "request", req: 1, rpc_method: "initialize" }),
      expect.objectContaining({ ev: "finish", req: 1, status: 200 }),
      expect.objectContaining({ ev: "close", req: 1, finished: true }),
    ]);
  });

  it("writes the close line of a request that shutdown cuts off", async () => {
    const logFile = join(dir, "requests.jsonl");
    const { handle: server, entered } = await startHoldingServer({ logFile });

    const call = post(server.url, holdRequest).then((response) => response.text());
    const refused = expect(call).rejects.toThrow();
    const ctx = await entered;
    await server.close();
    handle = undefined;
    await refused;

    const entries: unknown[] = await readLogEntries(logFile);
    expect(entries).toContainEqual(
      expect.objectContaining({ ev: "close", req: ctx.requestId, finished: false }),
    );
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

    for (const path of ["/", "/mcpx", "/mcp/extra"]) {
      const fetched = await post(new URL(path, server.url).href, initializeRequest());
      expect(fetched.status, path).toBe(404);
      await fetched.body?.cancel();
    }

    expect(contexts).toEqual([]);
  });

  it("refuses a POST body over 4 MiB and keeps serving", async () => {
    const { handle: server, contexts } = await startHoldingServer();

    const atLimit = await post(server.url, initializeRequestOfSize(bodyLimitBytes));
    expect(atLimit.status).toBe(200);
    await atLimit.body?.cancel();
    expect(contexts).toHaveLength(1);

    const oversized = post(server.url, initializeRequestOfSize(bodyLimitBytes + 1)).then(
      async (response) => ({
        status: response.status,
        connection: response.headers.get("connection"),
        body: await response.text(),
      }),
    );
    await expect(oversized).resolves.toEqual({
      status: 413,
      connection: "close",
      body: JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Request body too large." },
        id: null,
      }),
    });
    expect(contexts).toHaveLength(1);

    const recovered = await initialize(server.url);
    expect(recovered.status).toBe(200);
    await recovered.body?.cancel();
  });

  it("logs an oversized body as a refused request, not a handler error", async () => {
    const logFile = join(dir, "requests.jsonl");
    handle = await startMcpHttpServer({
      logFile,
      createServer: () => new McpServer({ name: "mcp-http-test", version: "0" }),
    });

    const oversized = await post(handle.url, initializeRequestOfSize(bodyLimitBytes + 1));
    expect(oversized.status).toBe(413);
    await oversized.body?.cancel();
    // The log is an append stream: it is complete only once close has flushed it.
    await handle.close();
    handle = undefined;

    const entries: unknown[] = await readLogEntries(logFile);
    expect(entries).toContainEqual(
      expect.objectContaining({
        ev: "request",
        http: "POST",
        refused: true,
        limit_bytes: bodyLimitBytes,
      }),
    );
    expect(entries).not.toContainEqual(expect.objectContaining({ ev: "handler_error" }));
  });

  it("aborts connectionClosed when the client disconnects before the response", async () => {
    const { handle: server, entered } = await startHoldingServer();
    const client = new AbortController();

    const call = post(server.url, holdRequest, client.signal).then((response) => response.text());
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
    // The response's close has already fired; closing the server also closes the kept-alive
    // socket, which must not abort a request that completed on it.
    await server.close();
    handle = undefined;

    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.connectionClosed.aborted).toBe(false);
  });

  it("closes with a request still open", async () => {
    const { handle: server, entered } = await startHoldingServer();

    const call = post(server.url, holdRequest).then((response) => response.text());
    const refused = expect(call).rejects.toThrow();
    const ctx = await entered;
    const aborted = once(ctx.connectionClosed, "abort");

    await server.close();
    handle = undefined;

    await refused;
    await aborted;
  });
});

describe("MCP HTTP server body log", () => {
  /** Serves one tool, `echo`, that answers with the text it was given. */
  const startEchoServer = async (options: {
    bodyLogFile: string;
    reportLogFailure?: (error: unknown) => void;
  }) => {
    handle = await startMcpHttpServer({
      ...options,
      createServer: () => {
        const server = new McpServer({ name: "mcp-http-test", version: "0" });
        server.registerTool(
          "echo",
          { description: "Answers with its text.", inputSchema: { text: z.string() } },
          async ({ text }) => ({ content: [{ type: "text", text }] }),
        );
        return server;
      },
    });
    return handle;
  };

  const echoCall = (id: number, meta: Record<string, unknown> | undefined) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "echo", arguments: { text: `call ${id}` }, ...(meta ? { _meta: meta } : {}) },
  });

  it("has a call's request and response lines on disk once its response arrives", async () => {
    const bodyLogFile = join(dir, "bodies.jsonl");
    const server = await startEchoServer({ bodyLogFile });
    const request = echoCall(7, { [TOOL_USE_ID_META]: "toolu_echo" });

    const response = await post(server.url, request);
    expect(await response.text()).toContain("call 7");

    // Read before closing the server: the lines are written before the response goes out, not only by close.
    expect(await readLogEntries(bodyLogFile)).toEqual([
      { tool_use_id: "toolu_echo", direction: "request", body: request },
      {
        tool_use_id: "toolu_echo",
        direction: "response",
        body: { jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "call 7" }] } },
      },
    ]);
  });

  it("logs only tool calls that carry a tool-use id", async () => {
    const bodyLogFile = join(dir, "bodies.jsonl");
    const server = await startEchoServer({ bodyLogFile });

    for (const body of [initializeRequest(), echoCall(8, undefined), echoCall(9, { other: "x" })]) {
      const response = await post(server.url, body);
      expect(response.status).toBe(200);
      await response.text();
    }
    await server.close();
    handle = undefined;

    await expect(readLogEntries(bodyLogFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps answering tool calls when its body log cannot be written", async () => {
    const failures: unknown[] = [];
    // A directory cannot be opened for appending, so the log fails with EISDIR.
    const server = await startEchoServer({
      bodyLogFile: dir,
      reportLogFailure: (error) => failures.push(error),
    });

    for (const id of [1, 2]) {
      const response = await post(server.url, echoCall(id, { [TOOL_USE_ID_META]: `toolu_${id}` }));
      expect(await response.text()).toContain(`call ${id}`);
    }

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code: "EISDIR" });
  });
});
