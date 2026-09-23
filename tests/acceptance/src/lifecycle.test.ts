import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startServer } from "@mia/server";
import type { ApprovalStatus, TaskStatus } from "@mia/protocol";
import { Catalog } from "@mia/records";
import { ScriptedRuntime, type ScriptedTurn } from "./scripted-runtime.ts";
import {
  ackError,
  ackResult,
  FAKE_RUNTIME,
  FAKE_RUNTIME_ENV,
  must,
  mustString,
  startTestServer,
  testProfile,
} from "./harness.ts";

/** Listening TCP servers this process owns: a socket nobody closed is still counted here. */
const listeningServers = (): number =>
  process.getActiveResourcesInfo().filter((resource) => resource === "TCPServerWrap").length;

const listenOnFreePort = async (): Promise<{ server: Server; port: number }> => {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("blocking server did not bind a TCP port");
  return { server, port: address.port };
};

const closeServer = (server: Server): Promise<void> =>
  new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));

/** A turn wait that never aborts: the test itself decides when the turn ends. */
const unbounded = (): AbortSignal => new AbortController().signal;

/** Whether any process in the group led by `pid` is still alive (signal 0 only checks). */
const processGroupExists = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
};

describe("server lifecycle", () => {
  it("releases the catalog and the approval bridge when the gateway cannot bind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mia-lifecycle-"));
    const blocker = await listenOnFreePort();
    const profile = testProfile(
      dir,
      {},
      {
        server: {
          host: "127.0.0.1",
          port: blocker.port,
          secretFile: join(dir, "state", "client-secret"),
        },
      },
    );
    try {
      const before = listeningServers();
      expect(before).toBeGreaterThan(0); // the blocker itself, so the count below means something

      await expect(
        startServer({
          profile,
          adapter: new ScriptedRuntime(),
          log: () => undefined,
          env: {},
        }),
      ).rejects.toThrow();

      // The catalog is usable again right away: nothing holds the database open.
      const catalog = new Catalog(profile.stateDirectory);
      expect(catalog.nextSequence("conversation-that-does-not-exist")).toBe(1);
      catalog.close();

      // No extra listener survived the failed start, so the bridge is not still bound.
      await expect.poll(listeningServers, { timeout: 5_000 }).toBe(before);
    } finally {
      await closeServer(blocker.server);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("logs approval bridge requests to the MIA_MCP_HTTP_LOG of the environment it is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mia-lifecycle-"));
    const logFile = join(dir, "bridge-requests.jsonl");
    try {
      const server = await startServer({
        profile: testProfile(dir),
        adapter: new ScriptedRuntime(),
        log: () => undefined,
        env: { MIA_MCP_HTTP_LOG: logFile },
      });
      try {
        // The bridge refuses a GET, and logs the refusal.
        const response = await fetch(server.bridge.url, { signal: AbortSignal.timeout(5_000) });
        expect(response.status).toBe(405);
      } finally {
        await server.close(unbounded());
      }
      // The log is written in the background; closing the server writes out what is queued.
      const entries: unknown[] = readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(entries).toEqual([expect.objectContaining({ ev: "request", http: "GET" })]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves close() on every call, not only the first", async () => {
    const testServer = await startTestServer(new ScriptedRuntime());
    try {
      await expect(testServer.server.close(unbounded())).resolves.toBeUndefined();
      await expect(testServer.server.close(unbounded())).resolves.toBeUndefined();
    } finally {
      await testServer.close();
    }
  });

  it("closes the bridge and the catalog when closing the gateway fails, and every caller sees that failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mia-lifecycle-"));
    try {
      const server = await startServer({
        profile: testProfile(dir),
        adapter: new ScriptedRuntime(),
        log: () => undefined,
        env: {},
      });
      const bridgeUrl = server.bridge.url;
      const closeGateway = server.gateway.close;
      let gatewayCloses = 0;
      const gatewayFailure = new Error("simulated gateway close failure");
      server.gateway.close = async () => {
        gatewayCloses += 1;
        await closeGateway(); // release the port for real, so the failure is all this test adds
        throw gatewayFailure;
      };

      // SIGINT, then SIGTERM before the first shutdown has finished.
      const first = server.close(unbounded());
      const second = server.close(unbounded());

      const failure: unknown = await first.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure).toMatchObject({ errors: [gatewayFailure] });
      await expect(second).rejects.toBe(failure);
      expect(gatewayCloses).toBe(1);
      expect(server.catalog.db.isOpen).toBe(false);
      await expect(fetch(bridgeUrl, { signal: AbortSignal.timeout(5_000) })).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("shutdown mid-turn", () => {
  it("refuses commands while it waits for the interrupted turn, and closes only once the turn has finished", async () => {
    const runtime = new ScriptedRuntime();
    const testServer = await startTestServer(runtime);
    let turn: ScriptedTurn | null = null;
    try {
      const client = await testServer.connect("client-A");
      await client.startConversation();
      const next = runtime.nextTurn();
      const taskId = mustString(ackResult(await client.submitText("hello")).task_id, "task_id");
      turn = await next;
      turn.survivesInterrupt = true; // the turn ends only when the test ends it

      let closed = false;
      const closing = testServer.server.close(unbounded()).then(() => {
        closed = true;
      });
      const requested = await client.waitFor("interruption_requested");
      expect(requested.payload.task_id).toBe(taskId);
      expect(turn.interrupted).toBe(true);
      expect(ackError(await client.submitText("another"))).toMatchObject({
        code: "invalid_state",
        message: "the server is shutting down",
      });
      expect(closed).toBe(false);

      turn.end();
      await closing;
      const catalog = testServer.catalog();
      try {
        expect(
          catalog.get<{ status: TaskStatus }>("SELECT status FROM tasks WHERE id = ?", taskId),
        ).toEqual({ status: "interrupted" });
      } finally {
        catalog.close();
      }
    } finally {
      turn?.end(); // a failed assertion must not leave the shutdown waiting on this turn forever
      await testServer.close();
    }
  });

  it("kills the runtime's process group and records the task interrupted before the catalog closes", async () => {
    const testServer = await startTestServer(
      undefined,
      { executable: FAKE_RUNTIME },
      FAKE_RUNTIME_ENV,
    );
    try {
      const client = await testServer.connect("client-A");
      await client.startConversation();
      const taskId = mustString(ackResult(await client.submitText("CHANGE")).task_id, "task_id");
      // The runtime is now blocked on the approval bridge, mid-turn.
      await client.waitFor("approval_requested");
      const pid = must(testServer.server.engine.task?.handle?.pid, "runtime pid");
      expect(processGroupExists(pid)).toBe(true);

      await testServer.server.close(unbounded());

      expect(processGroupExists(pid)).toBe(false);
      // The gateway closed only after the turn finished, so the client already holds its outcome.
      expect((await client.waitFor("task_finished")).payload.status).toBe("interrupted");
      expect(process.getActiveResourcesInfo()).not.toContain("Timeout");
      const catalog = testServer.catalog();
      try {
        expect(
          catalog.get<{ status: TaskStatus }>("SELECT status FROM tasks WHERE id = ?", taskId),
        ).toEqual({ status: "interrupted" });
        expect(catalog.all<{ status: ApprovalStatus }>("SELECT status FROM approvals")).toEqual([
          { status: "invalidated" },
        ]);
      } finally {
        catalog.close();
      }
    } finally {
      await testServer.close();
    }
  });
});
