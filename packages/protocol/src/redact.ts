import { isRecord } from "./value.ts";

const SENSITIVE_KEY =
  /(token|secret|password|passwd|api[-_]?key|authorization|credential|cookie|private[-_]?key|bearer)/i;
const SENSITIVE_VALUE: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export const REDACTED = "[REDACTED]";

/** Whether a key names a credential: its value is redacted in records and refused in the runtime env, unless it is a token count (`isTokenCount`). */
export const isSensitiveKey = (key: string): boolean => SENSITIVE_KEY.test(key);

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

const COUNT_SUFFIX = /tokens$/i;

/**
 * Whether a key/value pair is a count of tokens (`input_tokens: 1200`, `MAX_THINKING_TOKENS=8000`), not a credential.
 * The key alone cannot tell (`API_TOKENS` may hold either), so the value must be a count too: a number, or a short
 * digit string (env values are strings; a long one is more likely a numeric secret). Only the `tokens` suffix is
 * excused, so a key that is sensitive without it (`SECRET_TOKENS`) never counts.
 */
export const isTokenCount = (key: string, value: unknown): boolean =>
  COUNT_SUFFIX.test(key) &&
  !isSensitiveKey(key.replace(COUNT_SUFFIX, "")) &&
  (typeof value === "number" || (typeof value === "string" && /^\d{1,9}$/.test(value)));

const walk = (value: unknown, key: string | undefined): unknown => {
  if (key !== undefined && isSensitiveKey(key) && !isTokenCount(key, value)) return REDACTED;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => walk(item, undefined));
  // Keys are scanned too: a secret can arrive as a key (a header map, a per-token cache). fromEntries
  // defines own properties, so a "__proto__" key stays evidence instead of replacing the prototype.
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        redactString(entryKey),
        walk(entryValue, entryKey),
      ]),
    );
  return value;
};

/**
 * Recursively redact a JSON-like value. Keys that look sensitive are replaced whole, except a token
 * count (`isTokenCount`); strings and keys are scanned for secret-shaped values. Returns a new value; input is not mutated. The shape is
 * not preserved (a sensitive key replaces its whole subtree, and keys that redact alike collapse into one), so the result is unknown.
 */
export const redactValue = (value: unknown): unknown => walk(value, undefined);
