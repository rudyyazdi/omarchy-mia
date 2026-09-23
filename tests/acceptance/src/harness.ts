import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach } from "vitest";
import { startServer, type MiaServer, type Profile, type TurnRunner } from "@mia/server";
import { MiaClient } from "@mia/text-client";
import { Catalog } from "@mia/records";
import { ScriptedRuntime } from "./scripted-runtime.ts";

export interface TestServer {
  server: MiaServer;
  profile: Profile;
  dir: string;
  connect(clientId?: string): Promise<MiaClient>;
  catalog(): Catalog;
  close(): Promise<void>;
}

/** A test's own timeout bounds its waits; connecting gets a shorter deadline so a dead server fails fast. */
const CONNECT_TIMEOUT_MS = 10_000;

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
      await client.connect({ signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
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

export interface ScriptedSession {
  runtime: ScriptedRuntime;
  server: TestServer;
  client: MiaClient;
}

/**
 * The starting point every scripted suite needs: a scripted runtime behind a fresh server, one
 * connected client that has reported diagnostics and started a conversation. Suites differ in what
 * they then submit, not in how they get here, so getting here is defined once.
 */
const startScriptedSession = async (
  overrides: Partial<Profile["runtime"]> = {},
): Promise<ScriptedSession> => {
  const runtime = new ScriptedRuntime();
  const server = await startTestServer(runtime, overrides);
  const client = await server.connect("client-A");
  await client.sendDiagnostics();
  await client.startConversation();
  return { runtime, server, client };
};

/**
 * Register the setup and teardown of a scripted suite: one session per test, handed to `hold` so the
 * suite can keep it in its own variables, and closed afterwards whether the test replaced it or not.
 * The returned function restarts the session under a different runtime profile mid-test, which is
 * how a test states the policy it needs without owning the lifecycle.
 */
export const useScriptedSession = (
  hold: (session: ScriptedSession) => void,
): ((overrides?: Partial<Profile["runtime"]>) => Promise<void>) => {
  let current: TestServer | null = null;
  const start = async (overrides: Partial<Profile["runtime"]> = {}): Promise<void> => {
    await current?.close();
    const session = await startScriptedSession(overrides);
    current = session.server;
    hold(session);
  };
  beforeEach(() => start());
  afterEach(async () => {
    await current?.close();
    current = null;
  });
  return start;
};

export const tick = () => sleep(20);
