import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";

/** A JSON-lines diagnostics log whose writes never wait on the disk and never fail a request. */
export interface RequestLog {
  /** Queues one record; throws only if the failure reporter does. */
  write(entry: Record<string, unknown>): void;
  /** Writes what is queued and closes the file; later writes are ignored. Safe to call again. */
  close(): Promise<void>;
}

/**
 * Records beyond this many queued bytes are dropped rather than held: the log is diagnostics, and a
 * disk slower than the request rate must not grow the server's memory.
 */
const MAX_QUEUED_BYTES = 1024 * 1024;

/**
 * Appends records through one write stream, so no request waits on the disk. The first failure (an
 * unopenable path, a failed write) is passed to `reportFailure` and turns logging off, so a bad path
 * is reported once instead of on every request. While `maxQueuedBytes` or more wait for the disk,
 * records are dropped and counted; the count is logged as `{ ev: "dropped", count }` ahead of the
 * next record that fits, or at close.
 */
export const createRequestLog = (options: {
  file: string;
  reportFailure: (error: unknown) => void;
  maxQueuedBytes?: number;
}): RequestLog => {
  const { reportFailure, maxQueuedBytes = MAX_QUEUED_BYTES } = options;
  const stream = createWriteStream(options.file, { flags: "a" });
  let state: "open" | "closed" | "failed" = "open";
  let dropped = 0;
  let closing: Promise<void> | undefined;

  stream.on("error", (error) => {
    if (state === "failed") return;
    state = "failed";
    stream.destroy();
    reportFailure(error);
  });

  const writeDropped = () => {
    if (dropped === 0) return;
    stream.write(JSON.stringify({ ev: "dropped", count: dropped }) + "\n");
    dropped = 0;
  };

  return {
    write: (entry) => {
      if (state !== "open") return;
      if (stream.writableLength >= maxQueuedBytes) {
        dropped += 1;
        return;
      }
      writeDropped();
      stream.write(JSON.stringify(entry) + "\n");
    },
    close: () => {
      closing ??= (async () => {
        if (state === "open") {
          state = "closed";
          writeDropped();
          stream.end();
        }
        // A failure while flushing has already gone to reportFailure through the error listener.
        await finished(stream).catch(() => undefined);
      })();
      return closing;
    },
  };
};
