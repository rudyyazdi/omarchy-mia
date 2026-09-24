import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { errorMessage, isRecord } from "@mia/protocol";
import { createBodyLog, responseId, toolCallsIn, type BodyLog } from "./body-log.ts";
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
   * JSON-lines file for request/response lifecycle diagnostics; unset or empty logs nothing.
   * Lines are written in the background and are all on disk once `close` resolves. A write failure
   * is reported once on stderr and turns logging off; it never fails a request.
   */
  logFile?: string;
  /**
   * JSON-lines file that receives the body of each `tools/call` request and of its response, keyed by the call's
   * tool-use id (`TOOL_USE_ID_META`); unset or empty logs none, and a call without a tool-use id is not logged. A
   * request's line is written before it is handled and a response's before it is sent, so a client that has seen
   * a response finds both lines. A write failure is reported once and turns the body log off; it never fails a
   * request.
   */
  bodyLogFile?: string;
  /** Receives the first failed write of either log; defaults to a line on stderr. */
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

/** Answers a failed request with a 500 JSON error, or just ends it if the headers already went out. */
export const endWithError = (res: ServerResponse, error: unknown): void => {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(500, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: errorMessage(error) }));
};

/** A JSON-RPC error body for a request refused before it reached the MCP transport. */
const sendJsonRpcRefusal = (
  res: ServerResponse,
  refusal: { status: number; message: string; headers?: Record<string, string> },
): void => {
  res.writeHead(refusal.status, { ...refusal.headers, "content-type": "application/json" });
  res.end(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: refusal.message }, id: null }),
  );
};

/** The client sent more than the body limit: its mistake, answered with 413 rather than a 500. */
class BodyTooLargeError extends Error {
  override readonly name = "BodyTooLargeError";
  constructor(readonly limitBytes: number) {
    super("request body too large");
  }
}

const MAX_MCP_BODY_BYTES = 4 * 1024 * 1024;

type SendOptions = Parameters<StreamableHTTPServerTransport["send"]>[1];

/** A stateless transport that awaits `beforeSend` with each message it sends, before sending it. */
class ObservedTransport extends StreamableHTTPServerTransport {
  readonly #beforeSend: (message: JSONRPCMessage) => Promise<void>;
  constructor(beforeSend: (message: JSONRPCMessage) => Promise<void>) {
    super({ sessionIdGenerator: undefined });
    this.#beforeSend = beforeSend;
  }
  override async send(message: JSONRPCMessage, options?: SendOptions): Promise<void> {
    await this.#beforeSend(message);
    return super.send(message, options);
  }
}

/**
 * The transport for one HTTP request: with a body log and a `tools/call` in `body`, it logs the request now and
 * each response to it before sending that response; otherwise it is a plain stateless transport.
 */
const transportFor = async (
  body: unknown,
  bodyLog: BodyLog | undefined,
): Promise<StreamableHTTPServerTransport> => {
  const calls = bodyLog ? toolCallsIn(body) : new Map();
  if (!bodyLog || calls.size === 0)
    return new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  for (const call of calls.values())
    await bodyLog.append({ tool_use_id: call.toolUseId, direction: "request", body: call.body });
  return new ObservedTransport(async (message) => {
    const id = responseId(message);
    const call = id === null ? undefined : calls.get(id);
    if (call)
      await bodyLog.append({ tool_use_id: call.toolUseId, direction: "response", body: message });
  });
};

const readBody = async (req: IncomingMessage, limitBytes: number): Promise<string> => {
  const chunks: Buffer[] = [];
  let size = 0;
  const stream: AsyncIterable<unknown> = req;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > limitBytes) throw new BodyTooLargeError(limitBytes);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
};

/**
 * Serve an MCP server over Streamable HTTP on loopback, in stateless mode: each POST gets a fresh
 * McpServer + transport so tool handlers can observe their own connection lifetime.
 * Set `logFile` to log request/response lifecycle for diagnostics.
 */
export const startMcpHttpServer = async (
  options: McpHttpServerOptions,
): Promise<McpHttpServerHandle> => {
  const host = options.host ?? "127.0.0.1";
  const path = "/mcp";
  let requestCounter = 0;
  const { logFile, bodyLogFile } = options;
  let boundPort: number | null = null;
  const reportFailureOf =
    (log: string) =>
    (error: unknown): void => {
      if (options.reportLogFailure) options.reportLogFailure(error);
      else process.stderr.write(`[mia-mcp-http] ${log} disabled: ${errorMessage(error)}\n`);
    };
  const requestLog =
    logFile === undefined || logFile === ""
      ? undefined
      : createRequestLog({
          file: logFile,
          reportFailure: reportFailureOf(`request log ${logFile}`),
          stamp: () => ({ at: new Date().toISOString(), port: boundPort }),
        });
  const bodyLog =
    bodyLogFile === undefined || bodyLogFile === ""
      ? undefined
      : createBodyLog({
          file: bodyLogFile,
          reportFailure: reportFailureOf(`body log ${bodyLogFile}`),
        });
  const closeLogs = async (): Promise<void> => {
    await Promise.all([requestLog?.close(), bodyLog?.close()]);
  };
  const log = (entry: Record<string, unknown>) => requestLog?.write(entry);
  // Logged responses whose close line is not written yet, so close() can wait for them before
  // closing the log. One entry per response in progress: bounded by what the server is serving.
  const openResponses = new Set<ServerResponse>();

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
      sendJsonRpcRefusal(res, {
        status: 405,
        message: "Method not allowed.",
        headers: { allow: "POST, DELETE" },
      });
      return;
    }
    let bodyText = "";
    if (req.method === "POST") {
      try {
        bodyText = await readBody(req, MAX_MCP_BODY_BYTES);
      } catch (error) {
        if (!(error instanceof BodyTooLargeError)) throw error;
        log({
          ev: "request",
          req: reqNo,
          http: "POST",
          refused: true,
          limit_bytes: error.limitBytes,
        });
        // readBody stopped reading mid-body, so the rest of it is still on the socket and the
        // connection cannot carry another request: close it rather than leave a kept-alive
        // client waiting on a socket nothing reads until the keep-alive timeout resets it.
        sendJsonRpcRefusal(res, {
          status: 413,
          message: "Request body too large.",
          headers: { connection: "close" },
        });
        return;
      }
    }
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
      openResponses.add(res);
      res.on("close", () => {
        openResponses.delete(res);
        log({
          ev: "close",
          req: reqNo,
          status: res.statusCode,
          finished: res.writableFinished,
          ms: Date.now() - startedAt,
        });
      });
      // A kept-alive socket outlives its request: remove the listener with the response, or
      // every request on the connection adds one more.
      const onSocketError = (socketError: Error) =>
        log({ ev: "socket_error", req: reqNo, error: String(socketError) });
      req.socket.once("error", onSocketError);
      res.once("close", () => req.socket.off("error", onSocketError));
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
    const transport = await transportFor(parsedBody, bodyLog);
    // The client may have gone while the body log was written; its close has fired, so nothing would close these.
    if (res.destroyed) return;
    const server = options.createServer(ctx);
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
  try {
    await listening.promise;
  } catch (error) {
    await closeLogs();
    throw error;
  }
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    httpServer.close();
    await closeLogs();
    throw new Error("MCP HTTP server did not bind a TCP address");
  }
  boundPort = address.port;
  return {
    url: `http://${host}:${address.port}${path}`,
    port: address.port,
    host,
    close: async () => {
      const closed = once(httpServer, "close");
      httpServer.closeAllConnections();
      httpServer.close();
      // The server closes before the destroyed sockets do, so wait for the responses they carried:
      // a request cut off by shutdown still gets its close line.
      await Promise.all([closed, ...[...openResponses].map((res) => once(res, "close"))]);
      await closeLogs();
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
