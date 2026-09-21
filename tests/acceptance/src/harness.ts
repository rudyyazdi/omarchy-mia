import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startServer, type MiaServer, type Profile, type TurnRunner } from "@mia/server";
import { MiaClient } from "@mia/text-client";
import { Catalog } from "@mia/records";

export interface TestServer {
  server: MiaServer;
  profile: Profile;
  dir: string;
  connect(clientId?: string): Promise<MiaClient>;
  catalog(): Catalog;
  close(): Promise<void>;
}

export const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

/** Narrow an optional value the test has already established must exist; throws with a readable message otherwise. */
export const must = <T>(value: T | null | undefined, what = "value"): T => {
  if (value === null || value === undefined) throw new Error(`expected ${what} to be present`);
  return value;
};

/** Narrow an unknown value (typically a field of an ack result) to a string. */
export const mustString = (value: unknown, what = "value"): string => {
  if (typeof value !== "string") throw new Error(`expected ${what} to be a string`);
  return value;
};

export const testProfile = (
  dir: string,
  overrides: Partial<Profile["runtime"]> = {},
  extra: Partial<Profile> = {},
): Profile => {
  const promptFile = join(dir, "agent-prompt.md");
  writeFileSync(promptFile, "# test agent prompt v-test\nBe brief.\n");
  return {
    profile: "acceptance-scripted",
    stateDirectory: join(dir, "state"),
    server: { host: "127.0.0.1", port: 0, secretFile: join(dir, "state", "client-secret") },
    runtime: {
      kind: "claude-code",
      executable: "claude",
      model: "scripted-model",
      effort: "medium",
      workingDirectory: join(dir, "work"),
      builtinTools: [],
      mcpServers: { d1: { type: "http", url: "http://127.0.0.1:1/mcp" } },
      toolPolicy: {
        mcp__d1__read: "allow",
        mcp__d1__change: "ask",
        mcp__d1__slow: "ask",
        mcp__d1__artifact: "ask",
        mcp__d1__forbidden: "deny",
      },
      agentPromptFile: promptFile,
      outputDirectories: [join(dir, "outputs")],
      env: {},
      extraSettings: {},
      ...overrides,
    },
    architectureDocument: resolve(REPO_ROOT, "docs/D1/PLAN.md"),
    notes: [],
    ...extra,
  };
};

export const startTestServer = async (
  adapter: TurnRunner,
  overrides: Partial<Profile["runtime"]> = {},
): Promise<TestServer> => {
  const dir = mkdtempSync(join(tmpdir(), "mia-acceptance-"));
  const profile = testProfile(dir, overrides);
  const logs: string[] = [];
  const server = await startServer({ profile, adapter, log: (message) => logs.push(message) });
  const clients: MiaClient[] = [];
  return {
    server,
    profile,
    dir,
    connect: async (clientId?: string) => {
      const client = new MiaClient({
        url: server.gateway.url,
        secret: MiaClient.readSecret(profile.server.secretFile),
        ...(clientId ? { clientId } : {}),
        build: { name: "test-client", version: "0", commit: null, dirty: null },
      });
      await client.connect();
      clients.push(client);
      return client;
    },
    catalog: () => new Catalog(profile.stateDirectory, { readonly: true }),
    close: async () => {
      for (const client of clients) client.close();
      await Promise.race([server.engine.waitForIdle(), sleep(3_000)]);
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

export const tick = () => sleep(20);
