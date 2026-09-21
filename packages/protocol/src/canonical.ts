import { createHash } from "node:crypto";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sortValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry !== undefined) out[key] = sortValue(entry);
    }
    return out;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
};

/**
 * Deterministic JSON encoding: object keys sorted, no whitespace, arrays kept in order.
 * Used for approval argument binding digests and command payload digests.
 */
export const canonicalJson = (value: unknown): string => JSON.stringify(sortValue(value));

export const sha256Hex = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

export const canonicalDigest = (value: unknown): string => sha256Hex(canonicalJson(value));
