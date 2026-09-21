import { Command } from "commander";
import { startFixture } from "./fixture.ts";

const program = new Command()
  .name("fixture")
  .usage("--dir <disposable-dir> [--mcp-port N] [--harness-port N]")
  .requiredOption("--dir <disposable-dir>", "directory that receives the ledger and artifacts")
  .option("--mcp-port <N>", "loopback port for the MCP endpoint (0 = ephemeral)", "0")
  .option("--harness-port <N>", "loopback port for the private harness API (0 = ephemeral)", "0")
  .exitOverride((error) => {
    if (error.exitCode === 0) process.exit(0);
    console.error("usage: fixture --dir <disposable-dir> [--mcp-port N] [--harness-port N]");
    process.exit(2);
  })
  .configureOutput({ writeErr: () => undefined });
program.parse();
const values = program.opts<{ dir: string; mcpPort: string; harnessPort: string }>();

const handle = await startFixture({
  dir: values.dir,
  mcpPort: Number(values.mcpPort),
  harnessPort: Number(values.harnessPort),
});
console.log(
  JSON.stringify({ mcp_url: handle.mcpUrl, harness_url: handle.harnessUrl, dir: values.dir }),
);
const shutdown = async () => {
  await handle.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
