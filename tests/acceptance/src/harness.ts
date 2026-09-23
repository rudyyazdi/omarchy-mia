import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach } from "vitest";
import { readRuntimeFile, type Profile, type RuntimeFileReader } from "@mia/agent-adapter";
import { startServer, type MiaServer, type TurnRunner } from "@mia/server";
import type { AckError, AckPayload } from "@mia/protocol";
import { describeAck, MiaClient } from "@mia/text-client";
import { Catalog } from "@mia/records";
import { ScriptedRuntime } from "./scripted-runtime.ts";

export interface TestServer {
  server: MiaServer;
  profile: Profile;
  dir: string;
  /** What the server logged, in order: how a test observes a loss the records cannot hold. */
  logs: readonly string[];
  /** Aborts the deadline of every turn-end evidence read in progress, as if it had timed out. */
  expireEvidenceReads(): void;
  /**
   * Holds the next turn-end evidence read of `path` until `release`, as a read blocked on a stale mount would be;
   * `started` resolves once the engine has asked for it. Its deadline or shutdown still abandons it.
   */
  holdEvidenceRead(path: string): HeldRead;
  connect(clientId?: string): Promise<MiaClient>;
  catalog(): Catalog;
  close(): Promise<void>;
}

export interface HeldRead {
  started: Promise<void>;
  release(): void;
}

/** Resolves once `released` does or `signal` aborts, whichever is first. */
const releasedOrAborted = async (
  released: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> => {
  if (!signal) return released;
  if (signal.aborted) return;
  const aborted = Promise.withResolvers<undefined>();
  const onAbort = () => aborted.resolve(undefined);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([released, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

/** A test's own timeout bounds its waits; connecting gets a shorter deadline so a dead server fails fast. */
const CONNECT_TIMEOUT_MS = 10_000;
/** How long closing waits for a turn the test left running; a scripted turn that survives interruption never ends. */
const TEARDOWN_TURN_WAIT_MS = 3_000;

export const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
/** The fake Claude Code executable the real adapter launches in offline tests. */
export const FAKE_RUNTIME = resolve(REPO_ROOT, "tests/fake-claude/bin.sh");
/** What the fake's shell wrapper needs to find `node`; the test process's env is not read. */
export const FAKE_RUNTIME_ENV = { PATH: dirname(process.execPath) };

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

/** The result of an ack the test expects accepted; throws with the ack's error otherwise. */
export const ackResult = (ack: AckPayload): Record<string, unknown> => {
  if (ack.disposition !== "accepted")
    throw new Error(`expected an accepted ack, got ${describeAck(ack)}`);
  return must(ack.result, "ack result");
};

/** The error of an ack the test expects refused; throws if the command was accepted. */
export const ackError = (ack: AckPayload): AckError => {
  if (ack.disposition === "accepted") throw new Error("expected a refused ack, got accepted");
  return ack.error;
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
      // Never resolvable, so starting a test server does not probe a real Claude Code on the machine.
      executable: "mia-test-runtime-not-installed",
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

/**
 * Start a server over a fresh directory. Without an adapter it runs the real one, which launches
 * `overrides.executable` with `env`.
 */
export const startTestServer = async (
  adapter: TurnRunner | undefined,
  overrides: Partial<Profile["runtime"]> = {},
  env: NodeJS.ProcessEnv = {},
): Promise<TestServer> => {
  const dir = mkdtempSync(join(tmpdir(), "mia-acceptance-"));
  const profile = testProfile(dir, overrides);
  const logs: string[] = [];
  // Replaced on every expiry, so a read that starts afterwards gets a deadline of its own.
  let evidenceDeadline = new AbortController();
  const holds = new Map<string, { started: () => void; released: Promise<void> }>();
  // Reads for real once released, or with the aborted signal, so an abandoned read is reported as in production.
  const readEvidence: RuntimeFileReader = async (path, options = {}) => {
    const hold = holds.get(path);
    if (hold) {
      holds.delete(path);
      hold.started();
      await releasedOrAborted(hold.released, options.signal);
    }
    return readRuntimeFile(path, options);
  };
  const server = await startServer({
    profile,
    ...(adapter ? { adapter } : {}),
    log: (message) => logs.push(message),
    evidenceReadDeadline: () => evidenceDeadline.signal,
    readEvidence,
    env,
  });
  const clients: MiaClient[] = [];
  return {
    server,
    profile,
    dir,
    logs,
    expireEvidenceReads: () => {
      evidenceDeadline.abort(new DOMException("evidence read deadline", "TimeoutError"));
      evidenceDeadline = new AbortController();
    },
    holdEvidenceRead: (path) => {
      const started = Promise.withResolvers<undefined>();
      const released = Promise.withResolvers<undefined>();
      holds.set(path, { started: () => started.resolve(undefined), released: released.promise });
      return { started: started.promise, release: () => released.resolve(undefined) };
    },
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
      try {
        await server.close(AbortSignal.timeout(TEARDOWN_TURN_WAIT_MS));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
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
