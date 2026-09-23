import { constants } from "node:fs";
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

/** The part of a stat result the policy reads. */
export interface CaptureStats {
  isFile: () => boolean;
  size: number;
}

/** The part of an open file the collector uses. */
export interface CaptureHandle {
  stat: () => Promise<CaptureStats>;
  read: (
    buffer: Buffer,
    options: { offset: number; length: number; position: null },
  ) => Promise<{ bytesRead: number }>;
  close: () => Promise<void>;
}

/**
 * The filesystem calls the collector makes: `node:fs/promises` in production. A test wraps the real
 * calls to observe which paths were touched, or to report a stat the file no longer matches.
 */
export interface CaptureFs {
  realpath: (path: string) => Promise<string>;
  stat: (path: string) => Promise<CaptureStats>;
  open: (path: string, flags: number) => Promise<CaptureHandle>;
}

const nodeFs: CaptureFs = { realpath, stat, open };

const factsOf = (resolvedPath: string, stats: CaptureStats): PathFacts => ({
  exists: true,
  resolvedPath,
  regularFile: stats.isFile(),
  byteSize: stats.size,
});

/** A path that cannot be resolved (absent, dangling symlink, unreachable) counts as absent. */
const inspectPath = async (fs: CaptureFs, path: string): Promise<PathFacts> => {
  try {
    const resolvedPath = await fs.realpath(path);
    return factsOf(resolvedPath, await fs.stat(resolvedPath));
  } catch {
    return { exists: false };
  }
};

/** An output directory that does not exist yet can contain nothing, so it drops out of the policy. */
const resolvePolicy = async (
  fs: CaptureFs,
  outputDirectories: readonly string[],
): Promise<CapturePolicy> => {
  const directories = await Promise.all(
    outputDirectories.map(async (directory) => inspectPath(fs, directory)),
  );
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
  fs: CaptureFs,
  admitted: { resolvedPath: string; policy: CapturePolicy },
  declared: DeclaredArtifact,
): Promise<Capture> => {
  const { resolvedPath, policy } = admitted;
  const handle = await fs.open(
    resolvedPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const eligibility = decideEligibility(factsOf(resolvedPath, await handle.stat()), policy);
    if (eligibility.status !== "eligible") return eligibility;
    const buffer = Buffer.alloc(eligibility.byteSize + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, {
        offset: length,
        length: buffer.length - length,
        position: null,
      });
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
export const createArtifactCollector =
  (fs: CaptureFs = nodeFs): ArtifactCollector =>
  async (declared, outputDirectories) => {
    const refused = checkDeclaredPath(declared);
    if (refused) return refused;
    const policy = await resolvePolicy(fs, outputDirectories);
    const eligibility = decideEligibility(await inspectPath(fs, declared.path), policy);
    if (eligibility.status !== "eligible") return eligibility;
    try {
      return await readAdmitted(fs, { resolvedPath: eligibility.resolvedPath, policy }, declared);
    } catch (error) {
      return { status: "failed", reason: `declared file unreadable: ${errorMessage(error)}` };
    }
  };

export const collectArtifact: ArtifactCollector = createArtifactCollector();
