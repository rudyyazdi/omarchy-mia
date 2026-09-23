import { Command } from "commander";
import { errorMessage } from "@mia/protocol";
import { runLive, type LiveOptions } from "./live.ts";
import { readScenarioList, type ScenarioName } from "./scenarios.ts";

const program: Command = new Command()
  .name("live")
  .option("--repeat <N>", "promptfoo repeat count", "2")
  // Checked before anything starts: promptfoo would silently match none.
  .option(
    "--scenarios <names>",
    "comma-separated scenario names to run",
    (value: string): ScenarioName[] => {
      const read = readScenarioList(value);
      return read.ok ? read.names : program.error(`--scenarios: ${read.error}`, { exitCode: 2 });
    },
  )
  .option(
    "--agent-prompt <path>",
    "agent prompt file, relative to the repo root",
    "prompts/agent-v1.md",
  )
  .option("--model <model>", "runtime model", "claude-sonnet-5")
  .option("--out <dir>", "evidence directory (default: .mia-state/live/<timestamp>)");
program.parse();

runLive(program.opts<LiveOptions>(), process.env).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`live: ${errorMessage(error)}`);
    process.exit(1);
  },
);
