import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach } from "vitest";
import {
  readRuntimeFile,
  untilAborted,
  type Profile,
  type RuntimeFileReader,
} from "@mia/agent-adapter";
import {
  collectArtifact,
  startServer,
  type ArtifactCollector,
  type MiaServer,
  type TurnRunner,
} from "@mia/server";
import type { AckError, AckPayload } from "@mia/protocol";
import { describeAck, MiaClient } from "@mia/text-client";
import { Catalog, newId } from "@mia/records";
import { ScriptedRuntime } from "./scripted-runtime.ts";

export interface TestServer {
  server: MiaServer;
  profile: Profile;
  dir: string;
  /** What the server logged, in order: how a test observes a loss the records cannot hold. */
  logs: readonly string[];
  /** Resolves with the next line the server logs that `matches`; call it before what makes the server log it. */
  waitForLog(matches: (line: string) => boolean): Promise<string>;
  /** Aborts the deadline of every evidence read in progress (turn end or conversation start), as if it had timed out. */
  expireEvidenceReads(): void;
  /**
   * Holds the next evidence read of `path` (a turn's transcript or hook evidence, or a starting conversation's prompt
   * or architecture document) until `release`, as a read blocked on a stale mount would be;
   * `started` resolves once the engine has asked for it. Its deadline or shutdown still abandons it.
   */
  holdEvidenceRead(path: string): HeldRead;
  /**
   * Holds the next capture of the tool output declared at `path` until `release`, as a slow disk would;
   * `started` resolves once the engine has asked for it. Once released, the file is captured for real.
   */
  holdArtifactCapture(path: string): HeldRead;
  /** Replaces the clock the engine stamps its records and sent events with; the system clock until then. */
  setClock(now: () => Date): void;
  connect(clientId?: string): Promise<MiaClient>;
  catalog(): Catalog;
  close(): Promise<void>;
}

export interface HeldRead {
  started: Promise<void>;
  release(): void;
}

/** The server side of a HeldRead: what the engine's use of the held path signals, and what it waits for. */
interface PendingHold {
  started: () => void;
  released: Promise<void>;
}

/** Holds the next use of `path`: `started` resolves once it is reached, and it waits until `release`. */
const holdOn = (holdsByPath: Map<string, PendingHold>, path: string): HeldRead => {
  const started = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();
  holdsByPath.set(path, { started: () => started.resolve(undefined), released: released.promise });
  return { started: started.promise, release: () => released.resolve(undefined) };
};

/** Consumes the hold on `path`, if any, signalling at once that it was reached; resolves once it is released. */
const reachHold = (holdsByPath: Map<string, PendingHold>, path: string): Promise<void> => {
  const hold = holdsByPath.get(path);
  if (!hold) return Promise.resolve();
  holdsByPath.delete(path);
  hold.started();
  return hold.released;
};

/** A test's own timeout bounds its waits; connecting gets a shorter deadline so a dead server fails fast. */
const CONNECT_TIMEOUT_MS = 10_000;
/** How long closing waits for a turn the test left running; a scripted turn that survives interruption never ends. */
const TEARDOWN_TURN_WAIT_MS = 3_000;
/** What the engine logs when the kernel refuses a dispatch nested inside another's effects (see `createKernel`). */
const NESTED_DISPATCH = "dispatch while another dispatch is in progress";

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
 * Start a server over a fresh directory, with debug mode off unless `options.debugMode`. Without an adapter it
 * runs the real one, which launches `overrides.executable` with `options.env`.
 */
export const startTestServer = async (
  adapter: TurnRunner | undefined,
  overrides: Partial<Profile["runtime"]> = {},
  options: { env?: NodeJS.ProcessEnv; debugMode?: boolean } = {},
): Promise<TestServer> => {
  const { env = {}, debugMode = false } = options;
  const dir = mkdtempSync(join(tmpdir(), "mia-acceptance-"));
  const profile = testProfile(dir, overrides);
  const logs: string[] = [];
  const logWaiters = new Set<(line: string) => void>();
  const log = (line: string) => {
    logs.push(line);
    for (const waiter of logWaiters) waiter(line);
  };
  // Replaced on every expiry, so a read that starts afterwards gets a deadline of its own.
  let evidenceDeadline = new AbortController();
  const holds = new Map<string, PendingHold>();
  // Reads for real once released, or with the aborted signal, so an abandoned read is reported as in production.
  const readEvidence: RuntimeFileReader = async (path, options = {}) => {
    const released = reachHold(holds, path);
    await untilAborted(
      () => released,
      options.signal,
      () => undefined,
    );
    return readRuntimeFile(path, options);
  };
  const captureHolds = new Map<string, PendingHold>();
  const captureArtifact: ArtifactCollector = async (declared, outputDirectories) => {
    await reachHold(captureHolds, declared.path);
    return collectArtifact(declared, outputDirectories);
  };
  let clock = () => new Date();
  // Every id the engine records is drawn before its transaction opens (#132). The transitions are pure and cannot draw
  // one; this refuses a draw while the catalog commits their records, where only writer calls run. Set once the
  // server's catalog is open.
  let inTransaction = (): boolean => false;
  const drawOutsideTransactions = (prefix: Parameters<typeof newId>[0]): string => {
    if (inTransaction()) throw new Error(`id "${prefix}" drawn inside a transaction`);
    return newId(prefix);
  };
  const server = await startServer({
    profile,
    ...(adapter ? { adapter } : {}),
    log,
    evidenceReadDeadline: () => evidenceDeadline.signal,
    readEvidence,
    collectArtifact: captureArtifact,
    now: () => clock(),
    newId: drawOutsideTransactions,
    debugMode,
    env,
  });
  inTransaction = () => server.catalog.db.isTransaction;
  const clients: MiaClient[] = [];
  return {
    server,
    profile,
    dir,
    logs,
    waitForLog: (matches) => {
      const { promise, resolve } = Promise.withResolvers<string>();
      const waiter = (line: string) => {
        if (!matches(line)) return;
        logWaiters.delete(waiter);
        resolve(line);
      };
      logWaiters.add(waiter);
      return promise;
    },
    expireEvidenceReads: () => {
      evidenceDeadline.abort(new DOMException("evidence read deadline", "TimeoutError"));
      evidenceDeadline = new AbortController();
    },
    holdEvidenceRead: (path) => holdOn(holds, path),
    holdArtifactCapture: (path) => holdOn(captureHolds, path),
    setClock: (now) => {
      clock = now;
    },
    connect: async (clientId?: string) => {
      const client = new MiaClient({
        url: server.gateway.url,
        secret: MiaClient.readSecretSync(profile.server.secretFile),
        ...(clientId ? { clientId } : {}),
        build: { name: "test-client", version: "0", commit: null, dirty: null },
      });
      await client.connect({ signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
      clients.push(client);
      return client;
    },
    catalog: () => Catalog.openSync(profile.stateDirectory, { readonly: true }),
    close: async () => {
      for (const client of clients) client.close();
      try {
        await server.close(AbortSignal.timeout(TEARDOWN_TURN_WAIT_MS));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      // The kernel refuses a dispatch from inside another's effects, and the engine only logs the refusal: a runtime
      // or fake that calls back synchronously from an effect would lose that record without any test failing.
      const nested = logs.filter((line) => line.includes(NESTED_DISPATCH));
      if (nested.length > 0) throw new Error(`nested dispatch refused: ${nested.join("; ")}`);
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
  // Forgotten before it closes, so a close that throws is not repeated by the next test's hooks.
  const closeCurrent = async (): Promise<void> => {
    const closing = current;
    current = null;
    await closing?.close();
  };
  const start = async (overrides: Partial<Profile["runtime"]> = {}): Promise<void> => {
    await closeCurrent();
    const session = await startScriptedSession(overrides);
    current = session.server;
    hold(session);
  };
  beforeEach(() => start());
  afterEach(closeCurrent);
  return start;
};
