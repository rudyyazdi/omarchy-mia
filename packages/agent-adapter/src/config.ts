import { z } from "zod";

export const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof EffortSchema>;

export const ToolPolicySchema = z.enum(["allow", "ask", "deny"]);
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;

export const McpServerConfigSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("http"),
      url: z.string().url(),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("sse"),
      url: z.string().url(),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("stdio"),
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
      env: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
]);
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/**
 * Everything the adapter needs to launch the runtime. Nothing here has a default: a profile
 * must state model, effort, tool surface, MCP wiring and per-tool policy explicitly.
 */
export const RuntimeConfigSchema = z
  .object({
    kind: z.literal("claude-code"),
    /** Executable name or absolute path; resolved on PATH at launch. */
    executable: z.string().min(1),
    model: z.string().min(1),
    effort: EffortSchema,
    /** Agent working directory (created if missing). Never a personal path in committed examples. */
    workingDirectory: z.string().min(1),
    /** Built-in Claude Code tools to enable. Empty array means none. */
    builtinTools: z.array(z.string()),
    mcpServers: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), McpServerConfigSchema),
    /**
     * Mia policy per fully qualified tool identity (mcp__<server>__<tool>).
     * allow: permitted without prompting, still subject to the action gate.
     * ask: requires an explicit per-call user decision.
     * deny: rejected before any prompt.
     * Tools not listed are denied with a visible error.
     */
    toolPolicy: z.record(
      z.string().regex(/^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_.-]+$/),
      ToolPolicySchema,
    ),
    /** Mia-owned agent instructions appended to the runtime's system prompt. */
    agentPromptFile: z.string().min(1),
    /** Directories from which tool-result-declared artifacts may be collected. */
    outputDirectories: z.array(z.string()),
    /** Extra environment for the runtime process (never credentials). */
    env: z.record(z.string(), z.string()).default({}),
    /** Extra Claude Code settings layer (used by tests to inject conflicting inherited settings). */
    extraSettings: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

export class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";
}

/** Validate policy against wiring: every policy entry must name a configured MCP server. */
export const validateRuntimeConfig = (config: RuntimeConfig): void => {
  for (const identity of Object.keys(config.toolPolicy)) {
    const match = /^mcp__([A-Za-z0-9_-]+)__/.exec(identity);
    const server = match?.[1];
    if (!server || !(server in config.mcpServers)) {
      throw new ConfigurationError(
        `toolPolicy names ${identity} but no MCP server "${server}" is configured`,
      );
    }
  }
  if ("mia_approval" in config.mcpServers) {
    throw new ConfigurationError(
      `mcpServers may not define "mia_approval"; that name is reserved for the approval bridge`,
    );
  }
  for (const tool of config.builtinTools) {
    // Built-in tools are not routed through the approval bridge by rule; D1 has proven gating only for MCP tools.
    throw new ConfigurationError(
      `builtinTools includes "${tool}", but D1 has no enforceable approval boundary for built-in tools; remove it or add a proven adapter boundary`,
    );
  }
  const secretLike = /(token|secret|password|api[-_]?key|authorization)/i;
  for (const key of Object.keys(config.env)) {
    if (secretLike.test(key))
      throw new ConfigurationError(`env must not carry credentials (found key ${key})`);
  }
};
