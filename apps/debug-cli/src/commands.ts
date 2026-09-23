import { resolve } from "node:path";
import {
  Catalog,
  defaultStateDir,
  exportConversation,
  listConversations,
  reconcileObjects,
  snapshotConversation,
  verifyExport,
  type ConversationSnapshot,
} from "@mia/records";
import {
  artifactsJson,
  formatArtifacts,
  formatConversation,
  formatConversationList,
  formatExport,
} from "./format.ts";

/** The global options every `mia debug` subcommand receives, as commander parsed them. */
export interface GlobalOptions {
  state?: string;
  output?: string;
  json: boolean;
}

const out = (value: unknown) =>
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));

const printLines = (lines: string[]) => {
  for (const line of lines) out(line);
};

/** Open the catalog for one command, read-only unless the command writes, and always close it. */
const withCatalog = (
  options: GlobalOptions,
  readonly: boolean,
  run: (catalog: Catalog) => void,
): void => {
  const catalog = new Catalog(resolve(options.state ?? defaultStateDir()), { readonly });
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
    text: (snapshot: ConversationSnapshot) => string[];
  },
): void =>
  withCatalog(options, true, (catalog) => {
    const snapshot = snapshotConversation(catalog, conversationId);
    if (options.json) out(render.json(snapshot));
    else printLines(render.text(snapshot));
  });

export const showConversations = (options: GlobalOptions): void =>
  withCatalog(options, true, (catalog) => {
    const list = listConversations(catalog);
    if (options.json) out(list);
    else printLines(formatConversationList(list));
  });

export const showConversation = (options: GlobalOptions, conversationId: string): void =>
  showSnapshot(options, conversationId, { json: (snapshot) => snapshot, text: formatConversation });

export const showArtifacts = (options: GlobalOptions, conversationId: string): void =>
  showSnapshot(options, conversationId, { json: artifactsJson, text: formatArtifacts });

export const exportToDirectory = (
  options: GlobalOptions & { output: string },
  conversationId: string,
): void =>
  withCatalog(options, false, (catalog) =>
    out(formatExport(exportConversation(catalog, conversationId, resolve(options.output)))),
  );

/** Prints the verification result and reports whether the export verified. */
export const verifyExportDirectory = (exportDirectory: string): boolean => {
  const result = verifyExport(resolve(exportDirectory));
  out(result);
  return result.ok;
};

export const reconcile = (options: GlobalOptions): void =>
  withCatalog(options, false, (catalog) => out(reconcileObjects(catalog)));
