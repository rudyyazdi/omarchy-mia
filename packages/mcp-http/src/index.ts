import { appendFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/** Per-HTTP-request context handed to the MCP server factory. */
export interface McpRequestContext {
  /** Fires when the underlying HTTP connection closes before a response was completed. */
  readonly connectionClosed: AbortSignal;
  readonly requestId: number;
}

export interface McpHttpServerOptions {
  host?: string;
  port?: number;
  /** Build a fresh McpServer per request (stateless Streamable HTTP mode). */
  createServer: (ctx: McpRequestContext) => McpServer;
}

export interface McpHttpServerHandle {
  readonly url: string;
  readonly port: number;
  readonly host: string;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage, limitBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limitBytes) throw new Error("request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Serve an MCP server over Streamable HTTP on loopback, in stateless mode: each POST gets a fresh
 * McpServer + transport so tool handlers can observe their own connection lifetime.
 * Set MIA_MCP_HTTP_LOG=<file> to log request/response lifecycle for diagnostics.
 */
export async function startMcpHttpServer(options: McpHttpServerOptions): Promise<McpHttpServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const path = "/mcp";
  let requestCounter = 0;
  const logFile = process.env.MIA_MCP_HTTP_LOG;
  let boundPort: number | null = null;
  const log = (entry: Record<string, unknown>) => {
    if (logFile) appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), port: boundPort, ...entry }) + "\n");
  };

  const httpServer: Server = createServer(async (req, res) => {
    const startedAt = Date.now();
    const reqNo = ++requestCounter;
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname !== path) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      if (req.method === "GET") {
        // Refuse the standalone SSE stream (allowed by the Streamable HTTP spec). Claude Code 2.1.274 closes an
        // idle standalone stream after ~2.5s and then treats the session as expired, re-sending any in-flight
        // tool call; refusing the stream removes that duplicate-execution trigger for Mia-owned servers.
        if (logFile) log({ ev: "request", req: reqNo, http: "GET", refused: true });
        res.writeHead(405, { allow: "POST, DELETE", "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
        return;
      }
      const bodyText = req.method === "POST" ? await readBody(req, 4 * 1024 * 1024) : "";
      let parsedBody: unknown = undefined;
      if (bodyText.length > 0) {
        try {
          parsedBody = JSON.parse(bodyText);
        } catch {
          parsedBody = undefined;
        }
      }
      if (logFile) {
        const rpc = (parsedBody ?? {}) as { method?: unknown; id?: unknown };
        log({ ev: "request", req: reqNo, http: req.method, accept: req.headers.accept, rpc_method: rpc.method ?? null, rpc_id: rpc.id ?? null, body_bytes: bodyText.length });
        res.on("finish", () => log({ ev: "finish", req: reqNo, status: res.statusCode, ms: Date.now() - startedAt }));
        res.on("close", () => log({ ev: "close", req: reqNo, status: res.statusCode, finished: res.writableFinished, ms: Date.now() - startedAt }));
        req.socket.once("error", (e) => log({ ev: "socket_error", req: reqNo, error: String(e) }));
      }
      const closeController = new AbortController();
      let completed = false;
      res.on("finish", () => {
        completed = true;
      });
      res.on("close", () => {
        if (!completed) closeController.abort(new Error("connection closed before response"));
      });
      const ctx: McpRequestContext = { connectionClosed: closeController.signal, requestId: reqNo };
      const server = options.createServer(ctx);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close().catch(() => undefined);
        void server.close().catch(() => undefined);
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      log({ ev: "handler_error", req: reqNo, error: String(error) });
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      } else {
        res.end();
      }
    }
  });
  httpServer.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port ?? 0, host, () => resolve());
  });
  const address = httpServer.address() as AddressInfo;
  boundPort = address.port;
  return {
    url: `http://${host}:${address.port}${path}`,
    port: address.port,
    host,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}

export { McpServer };

export async function readJsonBody(req: IncomingMessage, limitBytes = 1024 * 1024): Promise<unknown> {
  const text = await readBody(req, limitBytes);
  if (text.length === 0) return {};
  return JSON.parse(text);
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
