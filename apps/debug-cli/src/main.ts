/**
 * mia debug: read-only inspection of the private conversation catalog. Works offline, never contacts a
 * runtime or provider, never approves or replays anything.
 */
import { Command } from "commander";
import { defaultStateDir } from "@mia/records";
import {
  exportToDirectory,
  reconcile,
  showArtifacts,
  showConversation,
  showConversations,
  verifyExportDirectory,
  type GlobalOptions,
} from "./commands.ts";

/**
 * Bad arguments exit 2 with commander's own help for `mia debug` on stderr, which lists the
 * subcommands commander already defines plus the global options, so no synopsis is written twice.
 */
const usage: () => never = () => {
  console.error(debug.helpInformation());
  process.exit(2);
};

const program = new Command()
  .name("mia")
  .option("--state <DIR>", "state directory (defaults to the XDG state directory)")
  .option("--output <directory>", "export target directory (export only)")
  .option("--json", "print the raw snapshot as JSON", false)
  .exitOverride((error) => {
    if (error.exitCode === 0) process.exit(0);
    usage();
  })
  .configureOutput({ writeErr: () => undefined })
  .configureHelp({ showGlobalOptions: true });
const options = (): GlobalOptions => {
  const { state, ...rest } = program.opts<Omit<GlobalOptions, "state"> & { state?: string }>();
  return { ...rest, state: state ?? defaultStateDir(process.env) };
};

const debug = program.command("debug").allowExcessArguments();
const subcommand = (spec: string) => debug.command(spec).allowExcessArguments();

subcommand("conversations").action(() => showConversations(options()));
subcommand("conversation <conversation-id>").action((id: string) =>
  showConversation(options(), id),
);
subcommand("artifacts <conversation-id>").action((id: string) => showArtifacts(options(), id));
subcommand("export <conversation-id>").action((id: string) => {
  const { output, ...rest } = options();
  if (!output) usage();
  exportToDirectory({ ...rest, output }, id);
});
subcommand("verify <export-directory>").action((directory: string) =>
  process.exit(verifyExportDirectory(directory) ? 0 : 1),
);
subcommand("reconcile").action(() => reconcile(options()));

program.parse();
