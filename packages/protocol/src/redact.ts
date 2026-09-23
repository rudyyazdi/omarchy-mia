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

type Span = { end: number; complete: boolean };

/** The span of the JSON string literal opening at `start`; one cut short runs to the end of the text. */
const stringSpan = (text: string, start: number): Span => {
  let index = start + 1;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === '"') return { end: index + 1, complete: true };
    index += char === "\\" ? 2 : 1;
  }
  return { end: text.length, complete: false };
};

const skipSpace = (text: string, start: number): number => {
  let index = start;
  while (index < text.length && /\s/.test(text.charAt(index))) index += 1;
  return index;
};

/** The span of the JSON object or array opening at `start`, skipping string literals whole. */
const containerSpan = (text: string, start: number): Span => {
  let depth = 0;
  let index = start;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === '"') {
      index = stringSpan(text, index).end;
      continue;
    }
    if (char === "{" || char === "[") depth += 1;
    if (char === "}" || char === "]") depth -= 1;
    index += 1;
    if (depth === 0) return { end: index, complete: true };
  }
  return { end: text.length, complete: false };
};

/**
 * The span of the JSON value opening at `start`. A string, object or array cut short runs to the end of the
 * text; any other value runs to the next delimiter, so a number or literal cut short cannot be told from a
 * whole one.
 */
const valueSpan = (text: string, start: number): Span => {
  const opening = text.charAt(start);
  if (opening === '"') return stringSpan(text, start);
  if (opening === "{" || opening === "[") return containerSpan(text, start);
  let index = start;
  while (index < text.length && !/[\s,\]}]/.test(text.charAt(index))) index += 1;
  return { end: index, complete: true };
};

/** The decoded value of a JSON literal, or undefined when it is cut short or not JSON. */
const parseLiteral = (literal: string): unknown => {
  try {
    const parsed: unknown = JSON.parse(literal);
    return parsed;
  } catch {
    return undefined;
  }
};

const decodeKey = (literal: string): string => {
  const parsed = parseLiteral(literal);
  return typeof parsed === "string" ? parsed : literal.slice(1, -1);
};

/**
 * Redact, by key, text that looks like JSON but does not parse, typically a runtime line cut short: the value
 * of each `"<key>": <value>` pair whose key is sensitive (`isSensitiveKey`, except a token count) becomes
 * `"[REDACTED]"`. A value cut short is redacted to the end of the text and keeps no closing quote, so the cut
 * stays visible. String literals are skipped whole, so a quoted key inside a string value is not a pair.
 * Value-shaped secrets are left to `redactString`.
 */
export const redactSensitivePairs = (text: string): string => {
  let out = "";
  let copied = 0;
  let index = 0;
  while (index < text.length) {
    if (text.charAt(index) !== '"') {
      index += 1;
      continue;
    }
    const keySpan = stringSpan(text, index);
    const colon = skipSpace(text, keySpan.end);
    if (!keySpan.complete || text.charAt(colon) !== ":") {
      index = keySpan.end;
      continue;
    }
    const key = decodeKey(text.slice(index, keySpan.end));
    const valueStart = skipSpace(text, colon + 1);
    const value = valueSpan(text, valueStart);
    if (
      !isSensitiveKey(key) ||
      value.end === valueStart ||
      isTokenCount(key, parseLiteral(text.slice(valueStart, value.end)))
    ) {
      index = colon + 1;
      continue;
    }
    out += `${text.slice(copied, valueStart)}"${REDACTED}${value.complete ? '"' : ""}`;
    copied = value.end;
    index = value.end;
  }
  return out + text.slice(copied);
};
