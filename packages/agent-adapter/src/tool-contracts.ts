import { match } from "ts-pattern";
import { z } from "zod";
import { redactValue } from "@mia/protocol";
import { serverOf, type RuntimeConfig } from "./config.ts";

/**
 * The tool contracts a conversation's provenance retains (role `tool_contracts`, version d1): its configured MCP
 * servers, redacted, its per-tool policy and its built-in tools. The tool lists the runtime reports are recorded per
 * execution. Retained as JSON, so its fields and their order are the persisted format.
 */
export interface ToolContracts {
  mcpServers: unknown;
  toolPolicy: RuntimeConfig["toolPolicy"];
  builtinTools: RuntimeConfig["builtinTools"];
}

export const toolContracts = (runtime: RuntimeConfig): ToolContracts => ({
  mcpServers: redactValue(runtime.mcpServers),
  toolPolicy: runtime.toolPolicy,
  builtinTools: runtime.builtinTools,
});

const RetainedServers = z.object({ mcpServers: z.record(z.string(), z.unknown()) });
/**
 * Only the fields read here are checked: a server was redacted before it was retained, so its entry need not
 * satisfy the profile's schema any more (a redacted URL is no URL).
 */
const RetainedServer = z.looseObject({ bodyLog: z.string().optional() });

/**
 * What a retained server entry says of its body log. A server whose name reads as a credential (`token-fixture`)
 * had its whole entry redacted, so whether it writes one cannot be told.
 */
export type RetainedBodyLog = "body_log" | "no_body_log" | "redacted";

/**
 * What the MCP servers of a conversation say of their body logs, read from its retained tool contracts, or why that
 * is unknown. Only the controlled MCP fixture writes one (issue #6), so its bodies are the ones debug mode records.
 */
export type BodyLogServers =
  | { status: "known"; servers: ReadonlyMap<string, RetainedBodyLog> }
  | { status: "unknown"; reason: string };

/** The servers of a retained tool-contracts object, parsed from JSON. */
export const bodyLogServersIn = (contracts: unknown): BodyLogServers => {
  const parsed = RetainedServers.safeParse(contracts);
  if (!parsed.success)
    return { status: "unknown", reason: "the retained tool contracts list no MCP servers" };
  const servers = Object.entries(parsed.data.mcpServers).map(
    ([name, entry]): [string, RetainedBodyLog] => {
      const server = RetainedServer.safeParse(entry);
      if (!server.success) return [name, "redacted"];
      return [name, server.data.bodyLog === undefined ? "no_body_log" : "body_log"];
    },
  );
  return { status: "known", servers: new Map(servers) };
};

/** Whether the server a tool identity (mcp__<server>__<tool>) names writes a body log, or why that is unknown. */
export type ServerBodyLog =
  { kind: "writes" } | { kind: "none" } | { kind: "unknown"; reason: string };

export const serverBodyLog = (servers: BodyLogServers, identity: string): ServerBodyLog =>
  match(servers)
    .with({ status: "unknown" }, ({ reason }): ServerBodyLog => ({ kind: "unknown", reason }))
    .with({ status: "known" }, ({ servers: known }): ServerBodyLog => {
      const server = serverOf(identity);
      const retained = server === null ? undefined : known.get(server);
      return match(retained)
        .with("body_log", (): ServerBodyLog => ({ kind: "writes" }))
        .with("no_body_log", (): ServerBodyLog => ({ kind: "none" }))
        .with("redacted", (): ServerBodyLog => ({
          kind: "unknown",
          reason: "its server's retained entry was redacted",
        }))
        .with(undefined, (): ServerBodyLog => ({
          kind: "unknown",
          reason: "the retained tool contracts do not list its server",
        }))
        .exhaustive();
    })
    .exhaustive();
