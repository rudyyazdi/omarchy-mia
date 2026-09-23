import { Command } from "commander";
import { errorMessage } from "@mia/protocol";
import { runTextClient, type ConnectionOptions, type TextClientDeadlines } from "./repl.ts";

const deadlines: TextClientDeadlines = {
  connect: () => AbortSignal.timeout(10_000),
  ack: () => AbortSignal.timeout(30_000),
};

/**
 * Bad arguments exit 2 with commander's own help on stderr: the option list and the argument
 * synopsis below are written once, where commander parses them, and never restated as a string.
 */
const usage: () => never = () => {
  console.error(program.helpInformation());
  process.exit(2);
};

const program = new Command()
  .name("mia-client")
  .usage("--config <profile.json> | --url ws://127.0.0.1:PORT --secret-file <path>")
  .option("--url <ws-url>", "server WebSocket URL")
  .option("--secret-file <path>", "file holding the client secret the server created")
  .option("--config <profile.json>", "server profile to read the connection from")
  .exitOverride((error) => {
    if (error.exitCode === 0) process.exit(0);
    usage();
  })
  .configureOutput({ writeErr: () => undefined });
program.parse();
const { url, secretFile, config } = program.opts<{
  url?: string;
  secretFile?: string;
  config?: string;
}>();

const connection = (): ConnectionOptions => {
  if (config) return { config, env: process.env };
  if (url && secretFile) return { url, secretFile };
  return usage();
};

runTextClient(connection(), { input: process.stdin, output: process.stdout }, deadlines).then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`mia-client: ${errorMessage(error)}`);
    process.exit(1);
  },
);
