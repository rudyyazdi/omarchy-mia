import { resolve } from "node:path";
import {
  Catalog,
  diagnosticsViews,
  exportConversation,
  listConversations,
  reconcileObjects,
  snapshotConversation,
  taskViews,
  verifyExport,
  type ConversationSnapshot,
} from "@mia/records";
import {
  artifactsJson,
  formatArtifacts,
  formatConversationHeader,
  formatConversationList,
  formatDiagnostics,
  formatExport,
  formatTask,
  formatUnresolved,
} from "./format.ts";

/**
 * The global options every `mia debug` subcommand receives: commander's, with `state` already
 * defaulted from the environment by the entry point.
 */
export interface GlobalOptions {
  state: string;
  output?: string;
  json: boolean;
}

const out = (value: unknown) =>
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));

const printLines = (lines: string[]) => {
  for (const line of lines) out(line);
};

/**
 * Open the catalog read-only for one command and always close it. No command writes to it, and a
 * writable open would create and migrate an empty catalog at a mistyped `--state`.
 */
const withCatalog = (options: GlobalOptions, run: (catalog: Catalog) => void): void => {
  const catalog = Catalog.openSync(resolve(options.state), { readonly: true });
  try {
    run(catalog);
  } finally {
    catalog.close();
  }
};

/** Read one conversation snapshot and render it, as JSON on `--json`. */
const showSnapshot = (
  options: GlobalOptions,
  conversationId: string,
  render: {
    json: (snapshot: ConversationSnapshot) => unknown;
    text: (snapshot: ConversationSnapshot) => void;
  },
): void =>
  withCatalog(options, (catalog) => {
    const snapshot = snapshotConversation(catalog, conversationId);
    if (options.json) out(render.json(snapshot));
    else render.text(snapshot);
  });

export const showConversations = (options: GlobalOptions): void =>
  withCatalog(options, (catalog) => {
    const list = listConversations(catalog);
    if (options.json) out(list);
    else printLines(formatConversationList(list));
  });

/**
 * Prints each section as soon as it is derived, so a record that fails to parse still leaves
 * everything before it on screen.
 */
const printConversation = (snapshot: ConversationSnapshot): void => {
  printLines(formatConversationHeader(snapshot));
  for (const task of taskViews(snapshot)) printLines(formatTask(task));
  out(`\ndiagnostics:`);
  printLines(formatDiagnostics(diagnosticsViews(snapshot)));
  printLines(formatUnresolved(snapshot));
};

export const showConversation = (options: GlobalOptions, conversationId: string): void =>
  showSnapshot(options, conversationId, { json: (snapshot) => snapshot, text: printConversation });

export const showArtifacts = (options: GlobalOptions, conversationId: string): void =>
  showSnapshot(options, conversationId, {
    json: artifactsJson,
    text: (snapshot) => printLines(formatArtifacts(snapshot)),
  });

export const exportToDirectory = (
  options: GlobalOptions & { output: string },
  conversationId: string,
): void =>
  withCatalog(options, (catalog) =>
    out(formatExport(exportConversation(catalog, conversationId, resolve(options.output)))),
  );

/** Prints the verification result and reports whether the export verified. */
export const verifyExportDirectory = (exportDirectory: string): boolean => {
  const result = verifyExport(resolve(exportDirectory));
  out(result);
  return result.ok;
};

export const reconcile = (options: GlobalOptions): void =>
  withCatalog(options, (catalog) => out(reconcileObjects(catalog)));
