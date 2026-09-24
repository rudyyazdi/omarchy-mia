import { z } from "zod";
import { redactValue } from "@mia/protocol";
import { serverOf, type RuntimeConfig } from "./config.ts";

/**
 * The tool contracts a conversation's provenance retains (role `tool_contracts`, version d1): its configured MCP
 * servers, redacted, and its per-tool policy. The tool lists the runtime reports are recorded per execution.
 */
export const toolContracts = (runtime: RuntimeConfig) => ({
  mcpServers: redactValue(runtime.mcpServers),
  toolPolicy: runtime.toolPolicy,
  builtinTools: runtime.builtinTools,
});

const RetainedServers = z.object({ mcpServers: z.record(z.string(), z.unknown()) });
/**
 * Only the field read here is checked: a server was redacted before it was retained, so its entry need not
 * satisfy the profile's schema any more (a redacted URL is no URL).
 */
const WithBodyLog = z.looseObject({ bodyLog: z.string() });

/**
 * Which MCP servers of a conversation write a body log, read from its retained tool contracts, or why that is
 * unknown. Only the controlled MCP fixture writes one (issue #6), so these are the servers whose bodies debug mode
 * records.
 */
export type BodyLogServers =
  { status: "known"; servers: ReadonlySet<string> } | { status: "unknown"; reason: string };

/** The servers with a `bodyLog` in a retained tool-contracts object, parsed from JSON. */
export const bodyLogServersIn = (contracts: unknown): BodyLogServers => {
  const parsed = RetainedServers.safeParse(contracts);
  if (!parsed.success)
    return { status: "unknown", reason: "the retained tool contracts list no MCP servers" };
  const servers = Object.entries(parsed.data.mcpServers)
    .filter(([, server]) => WithBodyLog.safeParse(server).success)
    .map(([name]) => name);
  return { status: "known", servers: new Set(servers) };
};

/** Whether the server a tool identity (mcp__<server>__<tool>) names is one of `servers`. */
export const writesBodyLog = (servers: ReadonlySet<string>, identity: string): boolean => {
  const server = serverOf(identity);
  return server !== null && servers.has(server);
};
