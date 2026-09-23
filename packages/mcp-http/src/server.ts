import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { errorMessage, isRecord } from "@mia/protocol";
import { createRequestLog } from "./request-log.ts";

/** Per-HTTP-request context handed to the MCP server factory. */
export interface McpRequestContext {
  /** Fires when the underlying HTTP connection closes before a response was completed. */
  readonly connectionClosed: AbortSignal;
  readonly requestId: number;
}

export interface McpHttpServerOptions {
  host?: string;
  port?: number;
  /**
   * JSON-lines file for request/response lifecycle diagnostics; defaults to MIA_MCP_HTTP_LOG.
   * A write failure is reported once on stderr and turns logging off; it never fails a request.
   */
  logFile?: string;
  /** Receives the request log's first failed write; defaults to a line on stderr. */
  reportLogFailure?: (error: unknown) => void;
  /** Build a fresh McpServer per request (stateless Streamable HTTP mode). */
  createServer: (ctx: McpRequestContext) => McpServer;
}

export interface McpHttpServerHandle {
  readonly url: string;
  readonly port: number;
  readonly host: string;
  close(): Promise<void>;
}

const endWithError = (res: ServerResponse, error: unknown): void => {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(500, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: errorMessage(error) }));
};

const readBody = async (req: IncomingMessage, limitBytes: number): Promise<string> => {
  const chunks: Buffer[] = [];
  let size = 0;
  const stream: AsyncIterable<unknown> = req;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > limitBytes) throw new Error("request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
};

/**
 * Serve an MCP server over Streamable HTTP on loopback, in stateless mode: each POST gets a fresh
 * McpServer + transport so tool handlers can observe their own connection lifetime.
 * Set MIA_MCP_HTTP_LOG=<file> (or `logFile`) to log request/response lifecycle for diagnostics.
 */
export const startMcpHttpServer = async (
  options: McpHttpServerOptions,
): Promise<McpHttpServerHandle> => {
  const host = options.host ?? "127.0.0.1";
  const path = "/mcp";
  let requestCounter = 0;
  const logFile = options.logFile ?? process.env.MIA_MCP_HTTP_LOG;
  let boundPort: number | null = null;
  const reportLogFailure =
    options.reportLogFailure ??
    ((error: unknown) =>
      process.stderr.write(
        `[mia-mcp-http] request log ${logFile} disabled: ${errorMessage(error)}\n`,
      ));
  const requestLog =
    logFile === undefined || logFile === ""
      ? undefined
      : createRequestLog(logFile, reportLogFailure);
  const log = (entry: Record<string, unknown>) =>
    requestLog?.({ at: new Date().toISOString(), port: boundPort, ...entry });

  const handleRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
    reqNo: number,
  ): Promise<void> => {
    const startedAt = Date.now();
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
      log({ ev: "request", req: reqNo, http: "GET", refused: true });
      res.writeHead(405, { allow: "POST, DELETE", "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed." },
          id: null,
        }),
      );
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
    if (requestLog) {
      const rpc: Record<string, unknown> = isRecord(parsedBody) ? parsedBody : {};
      log({
        ev: "request",
        req: reqNo,
        http: req.method,
        accept: req.headers.accept,
        rpc_method: rpc.method ?? null,
        rpc_id: rpc.id ?? null,
        body_bytes: bodyText.length,
      });
      res.on("finish", () =>
        log({ ev: "finish", req: reqNo, status: res.statusCode, ms: Date.now() - startedAt }),
      );
      res.on("close", () =>
        log({
          ev: "close",
          req: reqNo,
          status: res.statusCode,
          finished: res.writableFinished,
          ms: Date.now() - startedAt,
        }),
      );
      req.socket.once("error", (socketError) =>
        log({ ev: "socket_error", req: reqNo, error: String(socketError) }),
      );
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
  };

  // http.createServer ignores a handler's result, so the handler stays synchronous and owns the
  // failure: an async handler's rejection would go unhandled and exit the process.
  const httpServer: Server = createServer((req, res) => {
    const reqNo = ++requestCounter;
    handleRequest(req, res, reqNo).catch((error: unknown) => {
      log({ ev: "handler_error", req: reqNo, error: String(error) });
      endWithError(res, error);
    });
  });
  httpServer.keepAliveTimeout = 5_000;

  const listening = Promise.withResolvers<undefined>();
  httpServer.once("error", listening.reject);
  httpServer.listen(options.port ?? 0, host, () => listening.resolve(undefined));
  await listening.promise;
  const address = httpServer.address();
  if (address === null || typeof address === "string")
    throw new Error("MCP HTTP server did not bind a TCP address");
  boundPort = address.port;
  return {
    url: `http://${host}:${address.port}${path}`,
    port: address.port,
    host,
    close: async () => {
      const closed = once(httpServer, "close");
      httpServer.closeAllConnections();
      httpServer.close();
      await closed;
    },
  };
};

export { McpServer };

export const readJsonBody = async (
  req: IncomingMessage,
  limitBytes = 1024 * 1024,
): Promise<unknown> => {
  const text = await readBody(req, limitBytes);
  if (text.length === 0) return {};
  return JSON.parse(text);
};

export const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
