import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ApprovalBridge, ClaudeCodeAdapter, loadProfile, type Profile } from "@mia/agent-adapter";
import { errorMessage } from "@mia/protocol";
import { Catalog, RecordWriter } from "@mia/records";
import { Engine, type TurnRunner } from "./engine.ts";
import { startGateway, type GatewayHandle } from "./gateway.ts";

export interface MiaServer {
  profile: Profile;
  gateway: GatewayHandle;
  engine: Engine;
  catalog: Catalog;
  bridge: ApprovalBridge;
  /**
   * Shut down: stop accepting commands, interrupt the active turn and wait for it until `turnWait` aborts,
   * close the gateway and the bridge, then close the catalog. Every step runs even when an earlier one fails,
   * and the returned promise rejects with all their errors only after the last. Memoised: a second call (a
   * SIGTERM after a SIGINT) awaits the first run and sees its outcome; its own `turnWait` is not used.
   */
  close(turnWait: AbortSignal): Promise<void>;
}

/**
 * The turn wait an entry point should give `close`: longer than the adapter takes to kill a runtime and
 * observe its exit, so a killed turn is normally recorded before the catalog closes.
 */
export const SHUTDOWN_TURN_WAIT_MS = 10_000;

export const SOURCE_ROOT = resolve(import.meta.dirname, "..", "..", "..");

const resolveProfile = (input: {
  profilePath?: string;
  profile?: Profile;
  env: NodeJS.ProcessEnv;
}): Profile => {
  if (input.profile) return input.profile;
  if (input.profilePath !== undefined) return loadProfile(input.profilePath, input.env);
  throw new Error("startServer needs a profile or a profilePath");
};

export const startServer = async (input: {
  profilePath?: string;
  profile?: Profile;
  adapter?: TurnRunner;
  log?: (message: string) => void;
  /**
   * The server process's environment: fills a profile's `${ENV}` placeholders, is what the runtime
   * inherits, and names the bridge's request log (`MIA_MCP_HTTP_LOG`). The entry point passes its own.
   */
  env: NodeJS.ProcessEnv;
}): Promise<MiaServer> => {
  const profile = resolveProfile(input);
  const log = input.log ?? ((message: string) => process.stderr.write(`[mia-server] ${message}\n`));
  mkdirSync(profile.stateDirectory, { recursive: true, mode: 0o700 });
  // Acquire in order; on any throw release what is already held, in reverse, before rethrowing.
  const catalog = new Catalog(profile.stateDirectory);
  try {
    const writer = new RecordWriter(catalog);
    const bridge = new ApprovalBridge({ logFile: input.env.MIA_MCP_HTTP_LOG });
    await bridge.start();
    try {
      const adapter: TurnRunner =
        input.adapter ?? new ClaudeCodeAdapter(profile.runtime, bridge, input.env);
      const engine = new Engine({
        profile,
        catalog,
        writer,
        adapter,
        sourceRoot: SOURCE_ROOT,
        env: input.env,
        log,
      });
      const gateway = await startGateway({
        host: profile.server.host,
        port: profile.server.port,
        secretFile: profile.server.secretFile,
        engine,
        writer,
        log,
      });
      log(
        `listening on ${gateway.url} (profile ${profile.profile}, model ${profile.runtime.model}, effort ${profile.runtime.effort})`,
      );
      let shutdownStarted: Promise<void> | null = null;
      const shutdown = async (turnWait: AbortSignal) => {
        const errors: unknown[] = [];
        const step = async (release: () => Promise<void> | void) => {
          try {
            await release();
          } catch (error) {
            errors.push(error);
          }
        };
        // In this order: the turn must finish before the catalog that records it closes, and the gateway
        // closes after the turn so the interruption still reaches the client.
        await step(() => engine.shutdown(turnWait));
        await step(() => gateway.close());
        await step(() => bridge.close());
        await step(() => catalog.close());
        if (errors.length > 0)
          throw new AggregateError(
            errors,
            `shutdown failed: ${errors.map((error) => errorMessage(error)).join("; ")}`,
          );
      };
      return {
        profile,
        gateway,
        engine,
        catalog,
        bridge,
        // Memoised: SIGINT then SIGTERM must await the one shutdown, not release these resources twice.
        close: (turnWait) => (shutdownStarted ??= shutdown(turnWait)),
      };
    } catch (error) {
      await bridge.close();
      throw error;
    }
  } catch (error) {
    catalog.close();
    throw error;
  }
};
