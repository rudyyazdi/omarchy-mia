import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { errorMessage } from "@mia/protocol";
import { ConfigurationError, RuntimeConfigSchema, validateRuntimeConfig } from "./config.ts";

/**
 * A profile is explicit about everything. Relative paths resolve against the profile file's directory.
 * Placeholders of the form ${ENV_NAME} in string values are substituted from the environment; an unset
 * placeholder, or one written in a key, is a configuration error. The server and the text client both
 * load a profile through `loadProfileSync`, so a profile the server rejects also stops the client.
 */
export const ProfileSchema = z
  .object({
    profile: z.string().min(1),
    stateDirectory: z.string().min(1),
    server: z
      .object({
        host: z.literal("127.0.0.1"),
        port: z.number().int().min(0).max(65535),
        secretFile: z.string().min(1),
      })
      .strict(),
    runtime: RuntimeConfigSchema,
    /** Architecture document whose revision is recorded in provenance. */
    architectureDocument: z.string().min(1),
    /** Human-readable note recorded in provenance, e.g. whether the model pin was verified live. */
    notes: z.array(z.string()).default([]),
  })
  .strict();
export type Profile = z.infer<typeof ProfileSchema>;

const PLACEHOLDER = /\$\{([A-Z0-9_]+)\}/g;

/** What every substitution needs besides the value: the environment, and the profile file errors name. */
interface Substitution {
  env: NodeJS.ProcessEnv;
  file: string;
}

const substitute = (text: string, field: string, context: Substitution): string =>
  text.replace(PLACEHOLDER, (_, name: string) => {
    const value = context.env[name];
    if (value === undefined)
      throw new ConfigurationError(
        `profile ${context.file}: ${field} references \${${name}} but it is not set in the environment`,
      );
    return value;
  });

/**
 * Substitution runs on parsed string values, never on the raw text: a value holding `"`, `\` or `}` then
 * stays that literal string and cannot end its field, add one or override one. Keys are never substituted,
 * and a placeholder in one is rejected rather than kept as a literal key.
 */
const substituteValues = (
  json: unknown,
  path: readonly string[],
  context: Substitution,
): unknown => {
  if (typeof json === "string") return substitute(json, path.join(".") || "(root)", context);
  if (Array.isArray(json))
    return json.map((item, index) => substituteValues(item, [...path, String(index)], context));
  if (typeof json === "object" && json !== null)
    return Object.fromEntries(
      Object.entries(json).map(([key, item]) => {
        const field = [...path, key].join(".");
        if (key.match(PLACEHOLDER))
          throw new ConfigurationError(
            `profile ${context.file}: ${field} has a placeholder in its key; placeholders are substituted only in values`,
          );
        return [key, substituteValues(item, [...path, key], context)];
      }),
    );
  return json;
};

export const loadProfileSync = (path: string, env: NodeJS.ProcessEnv): Profile => {
  const absolute = resolve(path);
  let raw: string;
  try {
    raw = readFileSync(absolute, "utf8");
  } catch (error) {
    throw new ConfigurationError(`cannot read profile ${absolute}: ${errorMessage(error)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new ConfigurationError(`profile ${absolute} is not valid JSON: ${errorMessage(error)}`);
  }
  const parsed = ProfileSchema.safeParse(substituteValues(json, [], { env, file: absolute }));
  if (!parsed.success)
    throw new ConfigurationError(
      `profile ${absolute} is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  const base = dirname(absolute);
  const abs = (candidate: string) => (isAbsolute(candidate) ? candidate : resolve(base, candidate));
  const profile: Profile = {
    ...parsed.data,
    stateDirectory: abs(parsed.data.stateDirectory),
    architectureDocument: abs(parsed.data.architectureDocument),
    server: { ...parsed.data.server, secretFile: abs(parsed.data.server.secretFile) },
    runtime: {
      ...parsed.data.runtime,
      mcpServers: Object.fromEntries(
        Object.entries(parsed.data.runtime.mcpServers).map(([name, server]) => [
          name,
          server.type !== "stdio" && server.bodyLog !== undefined
            ? { ...server, bodyLog: abs(server.bodyLog) }
            : server,
        ]),
      ),
      workingDirectory: abs(parsed.data.runtime.workingDirectory),
      agentPromptFile: abs(parsed.data.runtime.agentPromptFile),
      outputDirectories: parsed.data.runtime.outputDirectories.map(abs),
    },
  };
  validateRuntimeConfig(profile.runtime);
  return profile;
};
