import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import {
  endWithError,
  McpServer,
  readJsonBody,
  sendJson,
  startMcpHttpServer,
  type McpRequestContext,
} from "@mia/mcp-http";
import { sha256Hex, type Cancellable } from "@mia/protocol";
import { Ledger, LedgerEntrySchema } from "./ledger.ts";

/** Whether the slow tool honours cancellation while it waits at its barrier. */
export const SlowModeSchema = z.enum(["cancellable", "uncancellable"]);
export type SlowMode = z.infer<typeof SlowModeSchema>;

export const PendingSlowCallSchema = z.object({
  call_id: z.string(),
  mode: SlowModeSchema,
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

const EnteredSchema = z.object({ call_id: z.string(), mode: SlowModeSchema });
const ReleaseBodySchema = z.object({ call_id: z.string().optional() });

export interface FixtureOptions {
  dir: string;
  host?: string;
  mcpPort?: number;
  harnessPort?: number;
  /** Receives the MCP endpoint's request/response lifecycle log; unset logs nothing. */
  mcpLogFile?: string;
}

/**
 * The fixture's body log, in its directory: each `tools/call` request and response body, keyed by the runtime's
 * tool-use id. A profile names it as the fixture server's `bodyLog`, and a server in debug mode records the lines of
 * each call from it (issue #6). It is append-only, like the ledger, and a harness reset leaves it: lines are matched by
 * tool-use id, which the real runtime never reuses. fake-claude's ids are fixed, so a test that runs it twice against
 * one fixture in debug mode would see the first call's lines again; each such test gets a fixture of its own.
 */
export const BODY_LOG_FILE = "mcp-bodies.jsonl";

export interface FixtureHandle {
  mcpUrl: string;
  harnessUrl: string;
  /** Where the fixture writes its body log (`BODY_LOG_FILE`). */
  bodyLogFile: string;
  ledger: Ledger;
  close(): Promise<void>;
}

/**
 * How long one `/wait-entered` long poll stays open when the request names no `timeout_ms`. It
 * bounds a single request, not the caller's wait: `FixtureHarness.waitEntered` polls again.
 */
const WAIT_ENTERED_POLL_MS = 60_000;
/** The error a `/wait-entered` long poll answers with when it ends at its bound. */
const NOTHING_ENTERED = "no slow call entered before timeout";
const NothingEnteredSchema = z.object({ error: z.literal(NOTHING_ENTERED) });

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
  const enteredWaiters = new Set<(call: PendingSlowCall) => void>();

  const notifyEntered = (call: PendingSlowCall) => {
    for (const waiter of enteredWaiters) waiter(call);
    enteredWaiters.clear();
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
        inputSchema: { mode: SlowModeSchema },
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

  const bodyLogFile = join(options.dir, BODY_LOG_FILE);
  const mcp = await startMcpHttpServer({
    host,
    port: options.mcpPort ?? 0,
    logFile: options.mcpLogFile,
    bodyLogFile,
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

  const handleHarnessRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
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
      const timeoutMs = Number(url.searchParams.get("timeout_ms") ?? WAIT_ENTERED_POLL_MS);
      const { promise, resolve: entered } = Promise.withResolvers<PendingSlowCall | null>();
      // The fixture's own bound caps what a request asks for; an invalid delay ends the poll at once.
      const delay = timeoutMs >= 1 ? Math.min(Math.trunc(timeoutMs), WAIT_ENTERED_POLL_MS) : 1;
      const deadline = AbortSignal.timeout(delay);
      const stopWaiting = () => entered(null);
      deadline.addEventListener("abort", stopWaiting, { once: true });
      // A client that aborts its poll closes the response: drop its waiter now, not at the bound.
      res.once("close", stopWaiting);
      enteredWaiters.add(entered);
      const call = await promise;
      deadline.removeEventListener("abort", stopWaiting);
      res.off("close", stopWaiting);
      enteredWaiters.delete(entered);
      if (call) sendJson(res, 200, { call_id: call.call_id, mode: call.mode });
      else sendJson(res, 408, { error: NOTHING_ENTERED });
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
  };

  const harnessServer: Server = createServer((req, res) => {
    handleHarnessRequest(req, res).catch((error: unknown) => endWithError(res, error));
  });
  const listening = Promise.withResolvers<undefined>();
  harnessServer.once("error", listening.reject);
  harnessServer.listen(options.harnessPort ?? 0, host, () => listening.resolve(undefined));
  await listening.promise;
  const harnessAddress = harnessServer.address();
  if (harnessAddress === null || typeof harnessAddress === "string")
    throw new Error("harness server did not bind a TCP port");

  let shutdownStarted: Promise<void> | null = null;
  const shutdown = async () => {
    for (const call of pending.values()) call.release();
    await mcp.close();
    const closed = once(harnessServer, "close");
    harnessServer.closeAllConnections();
    harnessServer.close();
    await closed;
  };

  return {
    mcpUrl: mcp.url,
    harnessUrl: `http://${host}:${harnessAddress.port}`,
    bodyLogFile,
    ledger,
    // Memoised: a repeated shutdown must await the first, not close an already closed server.
    close: () => (shutdownStarted ??= shutdown()),
  };
};

/** Parses a response body that may not be JSON; anything that is not comes back as `undefined`. */
const jsonOrUndefined = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** How often `waitForState` reads the fixture state. */
const STATE_POLL_MS = 25;

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
  /**
   * Resolve with the first slow call that has entered and not been released, however long that
   * takes; reject once `signal` aborts. The fixture ends each long poll at a bound of its own (a
   * 408 naming that), and polling again is what keeps the caller's signal the only deadline. Any
   * other failure, including a 408 from something that is not the fixture, rejects.
   */
  async waitEntered({ signal }: Cancellable = {}): Promise<{
    call_id: string;
    mode: SlowMode;
  }> {
    for (;;) {
      const res = await fetch(`${this.baseUrl}/wait-entered`, { method: "POST", signal });
      if (!res.ok) {
        const text = await res.text();
        if (res.status === 408 && NothingEnteredSchema.safeParse(jsonOrUndefined(text)).success)
          continue;
        throw new Error(`wait-entered failed: ${res.status} ${text}`);
      }
      return EnteredSchema.parse(await res.json());
    }
  }
  /**
   * Poll the state until `settled` holds, then return it; once `signal` aborts, return the last
   * state seen instead, so the caller's own assertion reports what was actually observed. The
   * fixture is a separate process: its ledger settles a moment after the event that caused it, so a
   * caller polls until it has, bounded by its own signal, rather than sleeping long enough "most of
   * the time".
   */
  async waitForState(
    settled: (state: FixtureState) => boolean,
    { signal }: Cancellable = {},
  ): Promise<FixtureState> {
    for (;;) {
      const state = await this.state();
      if (settled(state) || signal?.aborted === true) return state;
      // The pause only rejects when the signal aborts; the next pass then reads and returns the state.
      await sleep(STATE_POLL_MS, undefined, { signal, ref: false }).catch(() => undefined);
    }
  }

  async release(callId?: string): Promise<void> {
    await fetch(`${this.baseUrl}/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(callId ? { call_id: callId } : {}),
    });
  }
}
