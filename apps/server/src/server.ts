import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ApprovalBridge, ClaudeCodeAdapter, loadProfile, type Profile } from "@mia/agent-adapter";
import { Catalog, RecordWriter } from "@mia/records";
import { Engine, type TurnRunner } from "./engine.ts";
import { startGateway, type GatewayHandle } from "./gateway.ts";

export interface MiaServer {
  profile: Profile;
  gateway: GatewayHandle;
  engine: Engine;
  catalog: Catalog;
  bridge: ApprovalBridge;
  close(): Promise<void>;
}

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
      engine.send = gateway.send;
      log(
        `listening on ${gateway.url} (profile ${profile.profile}, model ${profile.runtime.model}, effort ${profile.runtime.effort})`,
      );
      let shutdownStarted: Promise<void> | null = null;
      const shutdown = async () => {
        await gateway.close();
        await bridge.close();
        catalog.close();
      };
      return {
        profile,
        gateway,
        engine,
        catalog,
        bridge,
        // Memoised: SIGINT then SIGTERM must await the one shutdown, not release these resources twice.
        close: () => (shutdownStarted ??= shutdown()),
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
