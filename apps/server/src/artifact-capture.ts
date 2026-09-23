import { sep } from "node:path";
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
export type DeclaredArtifact = z.infer<typeof DeclaredArtifactSchema>;

/** What the filesystem reported about a declared path; `resolvedPath` has every symlink followed. */
export type PathFacts = { exists: false } | { exists: true; resolvedPath: string };

/** Output directories with every symlink followed, so containment compares resolved paths. */
export interface CapturePolicy {
  resolvedOutputDirectories: readonly string[];
}

export type NotRetained = {
  status: Extract<CaptureStatus, "external_only" | "missing" | "failed">;
  reason: string;
};

export type Eligibility = { status: "eligible"; resolvedPath: string } | NotRetained;

export type Capture = { status: "retained"; bytes: Buffer } | NotRetained;

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
    if (declaration.success) return declaration.data.artifact;
  }
  return null;
};

/** Decides from facts alone whether a declared file may be read; nothing outside the output directories is. */
export const decideEligibility = (facts: PathFacts, policy: CapturePolicy): Eligibility => {
  if (!facts.exists)
    return { status: "missing", reason: "declared file not found at collection time" };
  const inside = policy.resolvedOutputDirectories.some((directory) =>
    facts.resolvedPath.startsWith(directory + sep),
  );
  return inside
    ? { status: "eligible", resolvedPath: facts.resolvedPath }
    : {
        status: "external_only",
        reason: "declared path resolves outside the configured output directories",
      };
};

/** Retains the bytes unless the declaration carries a digest they do not match. */
export const verifyContent = (bytes: Buffer, declared: DeclaredArtifact): Capture => {
  const digest = sha256Hex(bytes);
  return declared.sha256 !== undefined && declared.sha256 !== digest
    ? {
        status: "failed",
        reason: `declared sha256 ${declared.sha256} does not match file ${digest}`,
      }
    : { status: "retained", bytes };
};
