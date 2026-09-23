import { isRecord } from "./value.ts";

/** `token(?!s)` keeps count keys such as `input_tokens` readable while `access_token` stays sensitive. */
const SENSITIVE_KEY =
  /(token(?!s)|secret|password|passwd|api[-_]?key|authorization|credential|cookie|private[-_]?key|bearer)/i;
const SENSITIVE_VALUE: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export const REDACTED = "[REDACTED]";

/** Extra literal strings to redact (e.g. the local client secret) registered at runtime. */
const registeredSecrets = new Set<string>();

export const registerSecret = (secret: string): void => {
  if (secret.length >= 8) registeredSecrets.add(secret);
};

export const redactString = (text: string): string => {
  let out = text;
  for (const secret of registeredSecrets) out = out.split(secret).join(REDACTED);
  for (const pattern of SENSITIVE_VALUE) out = out.replace(pattern, REDACTED);
  return out;
};

const walk = (value: unknown, key: string | undefined): unknown => {
  // A number or boolean under a sensitive key carries no credential; a string or subtree might.
  const scalar = typeof value === "number" || typeof value === "boolean";
  if (key !== undefined && SENSITIVE_KEY.test(key) && !scalar) return REDACTED;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => walk(item, undefined));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value))
      out[entryKey] = walk(entryValue, entryKey);
    return out;
  }
  return value;
};

/**
 * Recursively redact a JSON-like value. Keys that look sensitive are replaced whole;
 * strings are scanned for secret-shaped values. Returns a new value; input is not mutated. The shape is
 * not preserved (a sensitive key replaces its whole subtree), so the result is unknown.
 */
export const redactValue = (value: unknown): unknown => walk(value, undefined);
