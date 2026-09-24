import { Command } from "commander";
import { errorMessage } from "@mia/protocol";
import { EVIDENCE_READ_TIMEOUT_MS, SHUTDOWN_TURN_WAIT_MS, startServer } from "./server.ts";

const program = new Command()
  .name("mia-server")
  .requiredOption("--config <profile.json>", "server profile to run")
  .option("--debug", "record debug detail for the conversations this server starts", false)
  // Usage errors exit 2 (as before commander); --help and --version keep commander's exit 0.
  .exitOverride((commanderError) => process.exit(commanderError.exitCode === 0 ? 0 : 2))
  .parse();
const { config, debug } = program.opts<{ config: string; debug: boolean }>();

try {
  const server = await startServer({
    profilePath: config,
    env: process.env,
    debugMode: debug,
    evidenceReadDeadline: () => AbortSignal.timeout(EVIDENCE_READ_TIMEOUT_MS),
  });
  const shutdown = () => {
    server.close(AbortSignal.timeout(SHUTDOWN_TURN_WAIT_MS)).then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(`mia-server: ${errorMessage(error)}`);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} catch (error) {
  console.error(`mia-server: ${errorMessage(error)}`);
  process.exit(1);
}
