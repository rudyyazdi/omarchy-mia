import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { errorMessage } from "@mia/protocol";
import { ConfigurationError, RuntimeConfigSchema, validateRuntimeConfig } from "./config.ts";

/**
 * A profile is explicit about everything. Relative paths resolve against the profile file's directory.
 * Placeholders of the form ${ENV_NAME} in string values are substituted from the environment (used by
 * test harnesses to inject fixture URLs); an unset placeholder is a configuration error. The server and
 * the text client both load a profile through `loadProfile`, so they see the same profile or neither starts.
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

const substitute = (text: string, env: NodeJS.ProcessEnv): string =>
  text.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
    const value = env[name];
    if (value === undefined)
      throw new ConfigurationError(
        `profile references \${${name}} but it is not set in the environment`,
      );
    return value;
  });

/**
 * Substitution runs on parsed string values, never on the raw text: a value holding `"`, `\` or `}` then
 * stays that literal string and cannot end its field, add one or override one. Keys are left untouched.
 */
const substituteValues = (json: unknown, env: NodeJS.ProcessEnv): unknown => {
  if (typeof json === "string") return substitute(json, env);
  if (Array.isArray(json)) return json.map((item) => substituteValues(item, env));
  if (typeof json === "object" && json !== null)
    return Object.fromEntries(
      Object.entries(json).map(([key, item]) => [key, substituteValues(item, env)]),
    );
  return json;
};

export const loadProfile = (path: string, env: NodeJS.ProcessEnv): Profile => {
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
  const parsed = ProfileSchema.safeParse(substituteValues(json, env));
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
      workingDirectory: abs(parsed.data.runtime.workingDirectory),
      agentPromptFile: abs(parsed.data.runtime.agentPromptFile),
      outputDirectories: parsed.data.runtime.outputDirectories.map(abs),
    },
  };
  validateRuntimeConfig(profile.runtime);
  return profile;
};
