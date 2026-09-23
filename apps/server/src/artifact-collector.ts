import { readFileSync, realpathSync, statSync } from "node:fs";
import { errorMessage } from "@mia/protocol";
import {
  decideEligibility,
  verifyContent,
  type Capture,
  type CapturePolicy,
  type DeclaredArtifact,
  type PathFacts,
} from "./artifact-capture.ts";

/** A path that cannot be resolved (absent, dangling symlink, unreachable) counts as absent. */
const inspectPath = (path: string): PathFacts => {
  try {
    const resolvedPath = realpathSync(path);
    return { exists: true, resolvedPath, regularFile: statSync(resolvedPath).isFile() };
  } catch {
    return { exists: false };
  }
};

/** An output directory that does not exist yet can contain nothing, so it drops out of the policy. */
const resolvePolicy = (outputDirectories: readonly string[]): CapturePolicy => ({
  resolvedOutputDirectories: outputDirectories.flatMap((directory) => {
    const facts = inspectPath(directory);
    return facts.exists ? [facts.resolvedPath] : [];
  }),
});

/**
 * Reads a declared file only after the pure policy has admitted its resolved path. The checks guard
 * against a declaration naming a file outside the output directories, not against the file being
 * replaced between resolution and read. A file that still cannot be read is a failed capture, never a throw.
 */
export const collectArtifact = (
  declared: DeclaredArtifact,
  outputDirectories: readonly string[],
): Capture => {
  const eligibility = decideEligibility(
    inspectPath(declared.path),
    resolvePolicy(outputDirectories),
  );
  if (eligibility.status !== "eligible") return eligibility;
  let bytes: Buffer;
  try {
    bytes = readFileSync(eligibility.resolvedPath);
  } catch (error) {
    return { status: "failed", reason: `declared file unreadable: ${errorMessage(error)}` };
  }
  return verifyContent(bytes, declared);
};
