import { constants, type Stats } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { errorMessage } from "@mia/protocol";
import {
  checkDeclaredPath,
  decideEligibility,
  MAX_ARTIFACT_BYTES,
  verifyContent,
  type Capture,
  type CapturePolicy,
  type DeclaredArtifact,
  type PathFacts,
} from "./artifact-capture.ts";

const factsOf = (resolvedPath: string, stats: Stats): PathFacts => ({
  exists: true,
  resolvedPath,
  regularFile: stats.isFile(),
  byteSize: stats.size,
});

/** A path that cannot be resolved (absent, dangling symlink, unreachable) counts as absent. */
const inspectPath = async (path: string): Promise<PathFacts> => {
  try {
    const resolvedPath = await realpath(path);
    return factsOf(resolvedPath, await stat(resolvedPath));
  } catch {
    return { exists: false };
  }
};

/** An output directory that does not exist yet can contain nothing, so it drops out of the policy. */
const resolvePolicy = async (outputDirectories: readonly string[]): Promise<CapturePolicy> => {
  const directories = await Promise.all(outputDirectories.map(inspectPath));
  return {
    resolvedOutputDirectories: directories.flatMap((facts) =>
      facts.exists ? [facts.resolvedPath] : [],
    ),
    maxBytes: MAX_ARTIFACT_BYTES,
  };
};

/**
 * Re-decides on the opened file's own stat, then reads at most one byte more than it reported, so a
 * file replaced by a non-regular file or a symlink, or grown, after the first decision can neither
 * slip past the policy nor exceed the limit. Non-blocking open keeps a swapped-in FIFO from hanging.
 */
const readAdmitted = async (
  resolvedPath: string,
  policy: CapturePolicy,
  declared: DeclaredArtifact,
): Promise<Capture> => {
  const handle = await open(
    resolvedPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const eligibility = decideEligibility(factsOf(resolvedPath, await handle.stat()), policy);
    if (eligibility.status !== "eligible") return eligibility;
    const buffer = Buffer.alloc(eligibility.byteSize + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > eligibility.byteSize)
      return { status: "failed", reason: "declared file changed during collection" };
    return verifyContent(buffer.subarray(0, length), declared);
  } finally {
    await handle.close();
  }
};

/** Captures a declared tool output: `collectArtifact`, or a test's own. It never rejects. */
export type ArtifactCollector = (
  declared: DeclaredArtifact,
  outputDirectories: readonly string[],
) => Promise<Capture>;

/**
 * Opens a declared file only after the pure policy has admitted its resolved path. The checks guard
 * against a declaration naming a file outside the output directories or over the size limit. A file
 * that still cannot be read is a failed capture, never a rejection. The I/O is asynchronous, so reading
 * a file of up to the size limit stalls only the runtime whose output declared it.
 */
export const collectArtifact: ArtifactCollector = async (declared, outputDirectories) => {
  const refused = checkDeclaredPath(declared);
  if (refused) return refused;
  const policy = await resolvePolicy(outputDirectories);
  const eligibility = decideEligibility(await inspectPath(declared.path), policy);
  if (eligibility.status !== "eligible") return eligibility;
  try {
    return await readAdmitted(eligibility.resolvedPath, policy, declared);
  } catch (error) {
    return { status: "failed", reason: `declared file unreadable: ${errorMessage(error)}` };
  }
};
