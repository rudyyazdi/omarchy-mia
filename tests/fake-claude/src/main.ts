/**
 * Fake Claude Code executable for offline end-to-end tests of the real adapter: honours the launch flags
 * Mia passes, speaks stream-json on stdout, asks the approval bridge for permission over MCP exactly like the
 * runtime does, and calls fixture tools.
 */
import { Command } from "commander";
import { runFakeClaude, type FakeClaudeFlags } from "./runtime.ts";

// The flags the real runtime accepts (see packages/agent-adapter/src/launch.ts); anything else is tolerated
// and ignored so the fake keeps working when the adapter adds a flag.
const program = new Command()
  .name("fake-claude")
  .allowUnknownOption()
  .allowExcessArguments()
  .option("-p")
  .option("--output-format <format>")
  .option("--verbose")
  .option("--include-partial-messages")
  .option("--model <model>", "model to report in the init message", "fake")
  .option("--effort <effort>")
  .option("--strict-mcp-config")
  .requiredOption("--mcp-config <path>", "MCP server configuration written by the adapter")
  .option("--settings <path>")
  .option("--permission-mode <mode>")
  .option("--permission-prompt-tool <identity>", "bridge tool to ask for permission", "")
  .option("--tools <list>")
  .option("--append-system-prompt-file <path>")
  .option("--session-id <id>")
  .option("--resume <id>")
  .option("--debug <category>")
  .option("--debug-file <path>");
program.parse();
await runFakeClaude(program.opts<FakeClaudeFlags>());
