import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ApprovalBridge, ClaudeCodeAdapter } from "@mia/agent-adapter";
import { Catalog, RecordWriter } from "@mia/records";
import { loadProfile, type Profile } from "./config.ts";
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

export const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export async function startServer(input: {
  profilePath?: string;
  profile?: Profile;
  adapter?: TurnRunner;
  log?: (m: string) => void;
}): Promise<MiaServer> {
  const profile = input.profile ?? loadProfile(input.profilePath!);
  const log = input.log ?? ((m: string) => process.stderr.write(`[mia-server] ${m}\n`));
  mkdirSync(profile.stateDirectory, { recursive: true, mode: 0o700 });
  const catalog = new Catalog(profile.stateDirectory);
  const writer = new RecordWriter(catalog);
  const bridge = new ApprovalBridge();
  await bridge.start();
  const adapter: TurnRunner = input.adapter ?? new ClaudeCodeAdapter(profile.runtime, bridge);
  const engine = new Engine({
    profile,
    catalog,
    writer,
    adapter,
    sourceRoot: SOURCE_ROOT,
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
  return {
    profile,
    gateway,
    engine,
    catalog,
    bridge,
    close: async () => {
      await gateway.close();
      await bridge.close();
      catalog.close();
    },
  };
}
