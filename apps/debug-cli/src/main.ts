/**
 * mia debug: read-only inspection of the private conversation catalog. Works offline, never contacts a
 * runtime or provider, never approves or replays anything.
 */
import { Command } from "commander";
import { defaultStateDir } from "@mia/records";
import * as commands from "./commands.ts";

// Bad arguments exit 2 with commander's own help for `mia debug` (its subcommands and the global options).
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
const options = (): commands.GlobalOptions => {
  const { state, ...rest } = program.opts<
    Omit<commands.GlobalOptions, "state"> & { state?: string }
  >();
  return { ...rest, state: state ?? defaultStateDir(process.env) };
};

const debug = program.command("debug").allowExcessArguments();
const subcommand = (spec: string) => debug.command(spec).allowExcessArguments();

subcommand("conversations").action(() => commands.showConversations(options()));
subcommand("conversation <conversation-id>").action((id: string) =>
  commands.showConversation(options(), id),
);
subcommand("artifacts <conversation-id>").action((id: string) =>
  commands.showArtifacts(options(), id),
);
subcommand("export <conversation-id>").action((id: string) => {
  const { output, ...rest } = options();
  if (!output) usage();
  commands.exportToDirectory({ ...rest, output }, id);
});
subcommand("verify <export-directory>").action((directory: string) =>
  process.exit(commands.verifyExportDirectory(directory) ? 0 : 1),
);
subcommand("reconcile").action(() => commands.reconcile(options()));
subcommand("watch <conversation-id>")
  .option("--no-open", "print the page's address without opening a browser")
  .action(async (id: string, { open }: { open: boolean }) => {
    const interrupt = new AbortController();
    process.once("SIGINT", () => interrupt.abort());
    process.exitCode = await commands.watch(options(), id, { open, signal: interrupt.signal });
  });

await program.parseAsync();
