import { createHash } from "node:crypto";
import { isRecord } from "./value.ts";

const sortValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortValue);
  // fromEntries defines own properties: assigning a "__proto__" key would set the copy's prototype
  // and drop the key, so two argument sets differing only under it would share one digest.
  if (isRecord(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .flatMap((key) => (value[key] === undefined ? [] : [[key, sortValue(value[key])]])),
    );
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
