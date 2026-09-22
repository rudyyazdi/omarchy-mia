import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import {
  McpServer,
  readJsonBody,
  sendJson,
  startMcpHttpServer,
  type McpRequestContext,
} from "@mia/mcp-http";
import { errorMessage, sha256Hex } from "@mia/protocol";
import { Ledger, LedgerEntrySchema } from "./ledger.ts";

export const PendingSlowCallSchema = z.object({
  call_id: z.string(),
  mode: z.enum(["cancellable", "uncancellable"]),
  entered_at: z.string(),
  released: z.boolean(),
  cancelled: z.boolean(),
});
export type PendingSlowCall = z.infer<typeof PendingSlowCallSchema>;

/** What the private harness API serves at GET /state. */
export const FixtureStateSchema = z.object({
  counter: z.number(),
  ledger: z.array(LedgerEntrySchema),
  pending: z.array(PendingSlowCallSchema),
});
export type FixtureState = z.infer<typeof FixtureStateSchema>;

const EnteredSchema = z.object({ call_id: z.string(), mode: z.string() });
const ReleaseBodySchema = z.object({ call_id: z.string().optional() });

export interface FixtureOptions {
  dir: string;
  host?: string;
  mcpPort?: number;
  harnessPort?: number;
}

export interface FixtureHandle {
  mcpUrl: string;
  harnessUrl: string;
  ledger: Ledger;
  close(): Promise<void>;
}

type ControlledSlowCall = PendingSlowCall & { release: () => void; cancel: () => void };

/**
 * Controlled MCP fixture: tools read / change / slow / artifact / forbidden.
 * A private harness API (separate loopback port, never exposed to the agent) controls barriers
 * and reads the ledger. Nothing here sleeps; slow calls wait at a barrier until released or cancelled.
 */
export const startFixture = async (options: FixtureOptions): Promise<FixtureHandle> => {
  const host = options.host ?? "127.0.0.1";
  const ledger = new Ledger(options.dir);
  const artifactsDir = join(options.dir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });

  const pending = new Map<string, ControlledSlowCall>();
  const enteredWaiters: ((call: PendingSlowCall) => void)[] = [];

  const notifyEntered = (call: PendingSlowCall) => {
    while (enteredWaiters.length > 0) enteredWaiters.shift()?.(call);
  };

  const createServerForRequest = (ctx: McpRequestContext): McpServer => {
    const server = new McpServer({ name: "d1-controlled-fixture", version: "0.1.0" });
    const callId = () => `fx-${ctx.requestId}-${randomUUID().slice(0, 8)}`;

    server.registerTool(
      "read",
      { description: "Return the fixture counter. Has no side effects.", inputSchema: {} },
      async () => {
        const id = callId();
        const value = ledger.counter();
        ledger.append({
          kind: "returned",
          tool: "read",
          callId: id,
          args: {},
          detail: `counter=${value}`,
        });
        return { content: [{ type: "text", text: JSON.stringify({ counter: value }) }] };
      },
    );

    server.registerTool(
      "change",
      {
        description: "Increment the fixture counter by delta. Consequential.",
        inputSchema: { delta: z.number().int() },
      },
      async ({ delta }) => {
        const id = callId();
        ledger.append({ kind: "entered", tool: "change", callId: id, args: { delta } });
        const value = ledger.increment(delta);
        ledger.append({
          kind: "committed",
          tool: "change",
          callId: id,
          args: { delta },
          detail: `counter=${value}`,
        });
        ledger.append({ kind: "returned", tool: "change", callId: id, args: { delta } });
        return { content: [{ type: "text", text: JSON.stringify({ counter: value }) }] };
      },
    );

    server.registerTool(
      "slow",
      {
        description:
          "Long-running consequential action. Signals entered, waits at a barrier, then increments the counter once when released.",
        inputSchema: { mode: z.enum(["cancellable", "uncancellable"]) },
      },
      async ({ mode }, extra) => {
        const id = callId();
        ledger.append({ kind: "entered", tool: "slow", callId: id, args: { mode } });
        const { promise: outcomePromise, resolve: resolveOutcome } = Promise.withResolvers<
          "released" | "cancelled"
        >();
        const call: ControlledSlowCall = {
          call_id: id,
          mode,
          entered_at: new Date().toISOString(),
          released: false,
          cancelled: false,
          release: () => {
            if (call.released || call.cancelled) return;
            call.released = true;
            resolveOutcome("released");
          },
          cancel: () => {
            if (call.released || call.cancelled) return;
            if (mode === "uncancellable") return; // ignores cancellation until released
            call.cancelled = true;
            resolveOutcome("cancelled");
          },
        };
        pending.set(id, call);
        const onCancel = () => call.cancel();
        extra.signal.addEventListener("abort", onCancel, { once: true });
        ctx.connectionClosed.addEventListener("abort", onCancel, { once: true });
        notifyEntered(call);
        const outcome = await outcomePromise;
        if (outcome === "cancelled") {
          ledger.append({ kind: "cancelled", tool: "slow", callId: id, args: { mode } });
          pending.delete(id);
          return { isError: true, content: [{ type: "text", text: "cancelled before commit" }] };
        }
        const value = ledger.increment(1);
        ledger.append({
          kind: "committed",
          tool: "slow",
          callId: id,
          args: { mode },
          detail: `counter=${value}`,
        });
        pending.delete(id);
        ledger.append({ kind: "returned", tool: "slow", callId: id, args: { mode } });
        return { content: [{ type: "text", text: JSON.stringify({ counter: value }) }] };
      },
    );

    server.registerTool(
      "artifact",
      {
        description:
          "Write an immutable text artifact inside the fixture directory and return its location and digest.",
        inputSchema: { name: z.string().min(1).max(128), text: z.string().max(65536) },
      },
      async ({ name, text }) => {
        const id = callId();
        ledger.append({
          kind: "entered",
          tool: "artifact",
          callId: id,
          args: { name, bytes: text.length },
        });
        const target = resolve(artifactsDir, name);
        if (!target.startsWith(artifactsDir + sep) || name.includes("..") || name.includes("/")) {
          ledger.append({
            kind: "rejected",
            tool: "artifact",
            callId: id,
            args: { name },
            detail: "path outside fixture directory",
          });
          return {
            isError: true,
            content: [{ type: "text", text: "rejected: path outside fixture directory" }],
          };
        }
        const bytes = Buffer.from(text, "utf8");
        const sha256 = sha256Hex(bytes);
        writeFileSync(target, bytes, { mode: 0o600 });
        ledger.append({ kind: "committed", tool: "artifact", callId: id, args: { name, sha256 } });
        ledger.append({ kind: "returned", tool: "artifact", callId: id, args: { name } });
        const result = {
          artifact: { path: target, sha256, size: bytes.length, mime_type: "text/plain", name },
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      },
    );

    server.registerTool(
      "forbidden",
      { description: "Must never execute. Any execution is a policy failure.", inputSchema: {} },
      async () => {
        const id = callId();
        ledger.append({
          kind: "committed",
          tool: "forbidden",
          callId: id,
          args: {},
          detail: "FORBIDDEN TOOL EXECUTED",
        });
        return { content: [{ type: "text", text: "forbidden tool executed" }] };
      },
    );
    return server;
  };

  const mcp = await startMcpHttpServer({
    host,
    port: options.mcpPort ?? 0,
    createServer: createServerForRequest,
  });

  const snapshot = (): FixtureState => ({
    counter: ledger.counter(),
    ledger: ledger.entries(),
    pending: [...pending.values()].map(({ call_id, mode, entered_at, released, cancelled }) => ({
      call_id,
      mode,
      entered_at,
      released,
      cancelled,
    })),
  });

  const harnessServer: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (req.method === "GET" && url.pathname === "/state") return sendJson(res, 200, snapshot());
      if (req.method === "POST" && url.pathname === "/reset") {
        for (const call of pending.values()) call.release();
        pending.clear();
        ledger.reset();
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/wait-entered") {
        // Long-poll until a slow call has entered (or one is already pending and unreleased).
        const existing = [...pending.values()].find((call) => !call.released && !call.cancelled);
        if (existing) return sendJson(res, 200, { call_id: existing.call_id, mode: existing.mode });
        const timeoutMs = Number(url.searchParams.get("timeout_ms") ?? "60000");
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          sendJson(res, 408, { error: "no slow call entered before timeout" });
        }, timeoutMs);
        enteredWaiters.push((call) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          sendJson(res, 200, { call_id: call.call_id, mode: call.mode });
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/release") {
        const body = ReleaseBodySchema.parse(await readJsonBody(req));
        let targets: ControlledSlowCall[];
        if (body.call_id) {
          const named = pending.get(body.call_id);
          targets = named ? [named] : [];
        } else {
          targets = [...pending.values()];
        }
        for (const call of targets) call.release();
        return sendJson(res, 200, { released: targets.map((call) => call.call_id) });
      }
      sendJson(res, 404, { error: "unknown harness endpoint" });
    } catch (error) {
      sendJson(res, 500, { error: errorMessage(error) });
    }
  });
  await new Promise<void>((resolveListen, reject) => {
    harnessServer.once("error", reject);
    harnessServer.listen(options.harnessPort ?? 0, host, () => resolveListen());
  });
  const harnessAddress = harnessServer.address();
  if (harnessAddress === null || typeof harnessAddress === "string")
    throw new Error("harness server did not bind a TCP port");

  let shutdownStarted: Promise<void> | null = null;
  const shutdown = async () => {
    for (const call of pending.values()) call.release();
    await mcp.close();
    await new Promise<void>((resolveClosed) => {
      harnessServer.closeAllConnections();
      harnessServer.close(() => resolveClosed());
    });
  };

  return {
    mcpUrl: mcp.url,
    harnessUrl: `http://${host}:${harnessAddress.port}`,
    ledger,
    // Memoised: a repeated shutdown must await the first, not close an already closed server.
    close: () => (shutdownStarted ??= shutdown()),
  };
};

/** Client for the private harness API. */
export class FixtureHarness {
  constructor(readonly baseUrl: string) {}
  async state(): Promise<FixtureState> {
    const res = await fetch(`${this.baseUrl}/state`);
    return FixtureStateSchema.parse(await res.json());
  }
  async reset(): Promise<void> {
    await fetch(`${this.baseUrl}/reset`, { method: "POST" });
  }
  async waitEntered(timeoutMs = 60_000): Promise<{ call_id: string; mode: string }> {
    const res = await fetch(`${this.baseUrl}/wait-entered?timeout_ms=${timeoutMs}`, {
      method: "POST",
    });
    if (!res.ok) throw new Error(`wait-entered failed: ${res.status} ${await res.text()}`);
    return EnteredSchema.parse(await res.json());
  }
  async release(callId?: string): Promise<void> {
    await fetch(`${this.baseUrl}/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(callId ? { call_id: callId } : {}),
    });
  }
}
