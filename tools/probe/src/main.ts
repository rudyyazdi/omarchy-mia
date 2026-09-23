import { Command } from "commander";
import { runProbe, type ProbeOptions } from "./probe.ts";

const program = new Command()
  .name("probe")
  .option("--model <model>", "runtime model to probe", "claude-sonnet-5")
  .option(
    "--out <dir>",
    "evidence directory (a timestamped subdirectory is created)",
    ".mia-state/probe",
  )
  .option(
    "--examples <dir>",
    "where redacted protocol examples are frozen",
    "docs/D1/protocol-examples",
  )
  .option("--only <names>", "comma-separated step names to run");
program.parse();
await runProbe(program.opts<ProbeOptions>(), process.env);
