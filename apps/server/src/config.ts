import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { ConfigurationError, RuntimeConfigSchema, validateRuntimeConfig, type RuntimeConfig } from "@mia/agent-adapter";

/**
 * A profile is explicit about everything. Relative paths resolve against the profile file's directory.
 * Placeholders of the form ${ENV_NAME} are substituted from the environment (used by test harnesses to
 * inject fixture URLs); any other unresolved placeholder is a configuration error.
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

function substitute(text: string, env: NodeJS.ProcessEnv): string {
  return text.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
    const value = env[name];
    if (value === undefined) throw new ConfigurationError(`profile references \${${name}} but it is not set in the environment`);
    return value;
  });
}

export function loadProfile(path: string, env: NodeJS.ProcessEnv = process.env): Profile {
  const absolute = resolve(path);
  let raw: string;
  try {
    raw = readFileSync(absolute, "utf8");
  } catch (error) {
    throw new ConfigurationError(`cannot read profile ${absolute}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(substitute(raw, env));
  } catch (error) {
    throw new ConfigurationError(`profile ${absolute} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = ProfileSchema.safeParse(json);
  if (!parsed.success) throw new ConfigurationError(`profile ${absolute} is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const base = dirname(absolute);
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(base, p));
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
}

export type { RuntimeConfig };
