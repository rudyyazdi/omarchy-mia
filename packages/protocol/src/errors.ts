/** Whether a filesystem call failed because the path does not exist (`ENOENT`). */
export const isNotFound = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/** Message of any thrown value, for logs and error payloads. */
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
