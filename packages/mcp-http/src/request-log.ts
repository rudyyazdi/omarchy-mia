import { appendFileSync } from "node:fs";

/** Appends one diagnostics record; throws only if the failure reporter does. */
export type RequestLog = (entry: Record<string, unknown>) => void;

/**
 * A JSON-lines diagnostics log that cannot take the server down: the first write that fails is
 * passed to `reportFailure` and turns logging off, so a bad path is reported once instead of on
 * every request, and a request never fails because its log line could not be written.
 */
export const createRequestLog = (
  file: string,
  reportFailure: (error: unknown) => void,
): RequestLog => {
  let enabled = true;
  return (entry) => {
    if (!enabled) return;
    try {
      appendFileSync(file, JSON.stringify(entry) + "\n");
    } catch (error) {
      enabled = false;
      reportFailure(error);
    }
  };
};
