/** Message of any thrown value, for logs and error payloads. */
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
