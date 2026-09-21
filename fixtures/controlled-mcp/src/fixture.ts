import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
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
import { Ledger } from "./ledger.ts";

export interface PendingSlowCall {
  call_id: string;
  mode: "cancellable" | "uncancellable";
  entered_at: string;
  released: boolean;
  cancelled: boolean;
}

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

/**
 * Controlled MCP fixture: tools read / change / slow / artifact / forbidden.
 * A private harness API (separate loopback port, never exposed to the agent) controls barriers
 * and reads the ledger. Nothing here sleeps; slow calls wait at a barrier until released or cancelled.
 */
export async function startFixture(options: FixtureOptions): Promise<FixtureHandle> {
  const host = options.host ?? "127.0.0.1";
  const ledger = new Ledger(options.dir);
  const artifactsDir = join(options.dir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });

  const pending = new Map<string, PendingSlowCall & { release: () => void; cancel: () => void }>();
  const enteredWaiters: Array<(call: PendingSlowCall) => void> = [];

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
        ledger.append("returned", "read", id, {}, `counter=${value}`);
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
        ledger.append("entered", "change", id, { delta });
        const value = ledger.increment(delta);
        ledger.append("committed", "change", id, { delta }, `counter=${value}`);
        ledger.append("returned", "change", id, { delta });
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
        ledger.append("entered", "slow", id, { mode });
        const outcome = await new Promise<"released" | "cancelled">((resolveOutcome) => {
          const call: PendingSlowCall & { release: () => void; cancel: () => void } = {
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
        });
        if (outcome === "cancelled") {
          ledger.append("cancelled", "slow", id, { mode });
          pending.delete(id);
          return { isError: true, content: [{ type: "text", text: "cancelled before commit" }] };
        }
        const value = ledger.increment(1);
        ledger.append("committed", "slow", id, { mode }, `counter=${value}`);
        pending.delete(id);
        ledger.append("returned", "slow", id, { mode });
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
        ledger.append("entered", "artifact", id, { name, bytes: text.length });
        const target = resolve(artifactsDir, name);
        if (!target.startsWith(artifactsDir + sep) || name.includes("..") || name.includes("/")) {
          ledger.append("rejected", "artifact", id, { name }, "path outside fixture directory");
          return {
            isError: true,
            content: [{ type: "text", text: "rejected: path outside fixture directory" }],
          };
        }
        const bytes = Buffer.from(text, "utf8");
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        writeFileSync(target, bytes, { mode: 0o600 });
        ledger.append("committed", "artifact", id, { name, sha256 });
        ledger.append("returned", "artifact", id, { name });
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
        ledger.append("committed", "forbidden", id, {}, "FORBIDDEN TOOL EXECUTED");
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

  const snapshot = () => ({
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
        const existing = [...pending.values()].find((c) => !c.released && !c.cancelled);
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
        const body = (await readJsonBody(req)) as { call_id?: string };
        const targets = body.call_id
          ? [pending.get(body.call_id)].filter(Boolean)
          : [...pending.values()];
        for (const call of targets) call?.release();
        return sendJson(res, 200, { released: targets.map((c) => c?.call_id) });
      }
      sendJson(res, 404, { error: "unknown harness endpoint" });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolveListen, reject) => {
    harnessServer.once("error", reject);
    harnessServer.listen(options.harnessPort ?? 0, host, () => resolveListen());
  });
  const harnessAddress = harnessServer.address() as AddressInfo;

  return {
    mcpUrl: mcp.url,
    harnessUrl: `http://${host}:${harnessAddress.port}`,
    ledger,
    close: async () => {
      for (const call of pending.values()) call.release();
      await mcp.close();
      await new Promise<void>((r) => {
        harnessServer.closeAllConnections();
        harnessServer.close(() => r());
      });
    },
  };
}

/** Client for the private harness API. */
export class FixtureHarness {
  constructor(readonly baseUrl: string) {}
  async state(): Promise<{
    counter: number;
    ledger: import("./ledger.ts").LedgerEntry[];
    pending: PendingSlowCall[];
  }> {
    const res = await fetch(`${this.baseUrl}/state`);
    return (await res.json()) as never;
  }
  async reset(): Promise<void> {
    await fetch(`${this.baseUrl}/reset`, { method: "POST" });
  }
  async waitEntered(timeoutMs = 60_000): Promise<{ call_id: string; mode: string }> {
    const res = await fetch(`${this.baseUrl}/wait-entered?timeout_ms=${timeoutMs}`, {
      method: "POST",
    });
    if (!res.ok) throw new Error(`wait-entered failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as never;
  }
  async release(callId?: string): Promise<void> {
    await fetch(`${this.baseUrl}/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(callId ? { call_id: callId } : {}),
    });
  }
}
