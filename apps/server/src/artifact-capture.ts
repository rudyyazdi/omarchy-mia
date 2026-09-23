import { isAbsolute, sep } from "node:path";
import { z } from "zod";
import { sha256Hex } from "@mia/protocol";
import type { CaptureStatus } from "@mia/records";

const DeclaredArtifactSchema = z.object({
  path: z.string(),
  sha256: z.string().optional(),
  name: z.string().optional(),
  mime_type: z.string().optional(),
});
const ArtifactDeclarationSchema = z.object({ artifact: DeclaredArtifactSchema });

export interface DeclaredArtifact {
  path: string;
  sha256?: string;
  name?: string;
  mimeType?: string;
}

/** What the filesystem reported about a declared path; `resolvedPath` has every symlink followed. */
export type PathFacts =
  | { exists: false }
  | { exists: true; resolvedPath: string; regularFile: boolean; byteSize: number };

/**
 * The largest file retained. The whole file is read synchronously inside the tool-result transaction,
 * so this bounds how long one declaration can stall the server and how much it holds in memory.
 */
export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

export interface CapturePolicy {
  /** Output directories with every symlink followed, so containment compares resolved paths. */
  resolvedOutputDirectories: readonly string[];
  maxBytes: number;
}

export type NotRetained = {
  status: Extract<CaptureStatus, "external_only" | "missing" | "failed">;
  reason: string;
};

export type Eligibility =
  { status: "eligible"; resolvedPath: string; byteSize: number } | NotRetained;

export type Capture = { status: Extract<CaptureStatus, "retained">; bytes: Buffer } | NotRetained;

/** The artifact fields a capture sets: its bytes, or its capture status and why nothing was retained. */
export const captureFields = (
  capture: Capture,
): { bytes: Buffer } | { captureStatus: NotRetained["status"]; captureReason: string } =>
  capture.status === "retained"
    ? { bytes: capture.bytes }
    : { captureStatus: capture.status, captureReason: capture.reason };

/** Text blocks of a tool result: a bare string, or the `text` of every block that carries one. */
const resultTexts = (content: unknown): string[] => {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: unknown) => {
    const text = typeof block === "object" && block !== null && "text" in block ? block.text : null;
    return typeof text === "string" ? [text] : [];
  });
};

/** A tool result may declare a generated file as {"artifact": {...}} in any of its text blocks. */
export const extractDeclaredArtifact = (content: unknown): DeclaredArtifact | null => {
  for (const text of resultTexts(content)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue; // not JSON
    }
    const declaration = ArtifactDeclarationSchema.safeParse(parsed);
    if (!declaration.success) continue;
    const { path, sha256, name, mime_type: mimeType } = declaration.data.artifact;
    return { path, sha256, name, mimeType };
  }
  return null;
};

/**
 * A relative path would resolve against the server's working directory, not the one the tool ran in,
 * so it names no particular file and is refused before any filesystem lookup.
 */
export const checkDeclaredPath = (declared: DeclaredArtifact): NotRetained | null =>
  isAbsolute(declared.path) ? null : { status: "failed", reason: "declared path must be absolute" };

const isInside = (path: string, directory: string): boolean =>
  path.startsWith(directory.endsWith(sep) ? directory : directory + sep);

/** Admits only a regular file within the size limit whose resolved path lies strictly inside an output directory. */
export const decideEligibility = (facts: PathFacts, policy: CapturePolicy): Eligibility => {
  if (!facts.exists)
    return { status: "missing", reason: "declared file not found at collection time" };
  if (
    !policy.resolvedOutputDirectories.some((directory) => isInside(facts.resolvedPath, directory))
  )
    return {
      status: "external_only",
      reason: "declared path resolves outside the configured output directories",
    };
  if (!facts.regularFile)
    return { status: "failed", reason: "declared path is not a regular file" };
  if (facts.byteSize > policy.maxBytes)
    return {
      status: "failed",
      reason: `declared file is ${facts.byteSize} bytes, over the ${policy.maxBytes}-byte limit`,
    };
  return { status: "eligible", resolvedPath: facts.resolvedPath, byteSize: facts.byteSize };
};

/** Retains the bytes unless the declaration carries a digest they do not match; an empty digest declares none. */
export const verifyContent = (bytes: Buffer, declared: DeclaredArtifact): Capture => {
  const digest = sha256Hex(bytes);
  return declared.sha256 && declared.sha256 !== digest
    ? {
        status: "failed",
        reason: `declared sha256 ${declared.sha256} does not match file ${digest}`,
      }
    : { status: "retained", bytes };
};
