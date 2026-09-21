const SENSITIVE_KEY = /(token|secret|password|passwd|api[-_]?key|authorization|credential|cookie|private[-_]?key|bearer)/i;
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

export function registerSecret(secret: string): void {
  if (secret.length >= 8) registeredSecrets.add(secret);
}

export function redactString(text: string): string {
  let out = text;
  for (const secret of registeredSecrets) out = out.split(secret).join(REDACTED);
  for (const re of SENSITIVE_VALUE) out = out.replace(re, REDACTED);
  return out;
}

/**
 * Recursively redact a JSON-like value. Keys that look sensitive are replaced whole;
 * strings are scanned for secret-shaped values. Returns a new value; input is not mutated.
 */
export function redactValue<T>(value: T): T {
  return walk(value, undefined) as T;
}

function walk(value: unknown, key: string | undefined): unknown {
  if (key !== undefined && SENSITIVE_KEY.test(key)) return REDACTED;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => walk(v, undefined));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v, k);
    return out;
  }
  return value;
}
