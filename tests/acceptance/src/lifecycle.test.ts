import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startServer } from "@mia/server";
import { Catalog } from "@mia/records";
import { ScriptedRuntime } from "./scripted-runtime.ts";
import { startTestServer, testProfile } from "./harness.ts";

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
        startServer({ profile, adapter: new ScriptedRuntime(), log: () => undefined }),
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

  it("resolves close() on every call, not only the first", async () => {
    const testServer = await startTestServer(new ScriptedRuntime());
    try {
      await expect(testServer.server.close()).resolves.toBeUndefined();
      await expect(testServer.server.close()).resolves.toBeUndefined();
    } finally {
      await testServer.close();
    }
  });
});
