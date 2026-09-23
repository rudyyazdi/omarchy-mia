import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
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
const inspectPath = (path: string): PathFacts => {
  try {
    const resolvedPath = realpathSync(path);
    return factsOf(resolvedPath, statSync(resolvedPath));
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
  maxBytes: MAX_ARTIFACT_BYTES,
});

/**
 * Re-decides on the opened file's own stat, then reads at most one byte more than it reported, so a
 * file replaced by a non-regular file or a symlink, or grown, after the first decision can neither
 * slip past the policy nor exceed the limit. Non-blocking open keeps a swapped-in FIFO from hanging.
 */
const readAdmitted = (
  resolvedPath: string,
  policy: CapturePolicy,
  declared: DeclaredArtifact,
): Capture => {
  const descriptor = openSync(
    resolvedPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const eligibility = decideEligibility(factsOf(resolvedPath, fstatSync(descriptor)), policy);
    if (eligibility.status !== "eligible") return eligibility;
    const buffer = Buffer.alloc(eligibility.byteSize + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > eligibility.byteSize)
      return { status: "failed", reason: "declared file changed during collection" };
    return verifyContent(buffer.subarray(0, length), declared);
  } finally {
    closeSync(descriptor);
  }
};

/**
 * Opens a declared file only after the pure policy has admitted its resolved path. The checks guard
 * against a declaration naming a file outside the output directories or over the size limit. A file
 * that still cannot be read is a failed capture, never a throw.
 */
export const collectArtifact = (
  declared: DeclaredArtifact,
  outputDirectories: readonly string[],
): Capture => {
  const refused = checkDeclaredPath(declared);
  if (refused) return refused;
  const policy = resolvePolicy(outputDirectories);
  const eligibility = decideEligibility(inspectPath(declared.path), policy);
  if (eligibility.status !== "eligible") return eligibility;
  try {
    return readAdmitted(eligibility.resolvedPath, policy, declared);
  } catch (error) {
    return { status: "failed", reason: `declared file unreadable: ${errorMessage(error)}` };
  }
};
