import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";

/** A JSON-lines diagnostics log whose writes never wait on the disk and never fail a request. */
export interface RequestLog {
  /** Queues one record, with the caller's stamp added; never throws. */
  write(entry: Record<string, unknown>): void;
  /** Writes what is queued and closes the file; later writes are ignored. Safe to call again. */
  close(): Promise<void>;
}

/**
 * Records are dropped rather than held once this many bytes wait for the disk: the log is
 * diagnostics, and a disk slower than the request rate must not grow the server's memory.
 */
const MAX_QUEUED_BYTES = 1024 * 1024;

/**
 * Appends records through one write stream, opened (and created) at once, so no request waits on
 * the disk. The first failure (an unopenable path, a failed write, an unserialisable record) goes to
 * `reportFailure`, from an event listener, so it must not throw; it turns logging off, so a bad path
 * is reported once instead of on every request.
 *
 * Tradeoffs of writing in the background: records still queued are lost if the process dies without
 * `close`, and a file deleted or rotated while open keeps receiving records on its unlinked inode.
 * While at least `maxQueuedBytes` wait for the disk, records are dropped and counted; the count is
 * logged as `{ ev: "dropped", count }` ahead of the next record that fits, or at close.
 */
export const createRequestLog = (options: {
  file: string;
  reportFailure: (error: unknown) => void;
  /** Fields added to every record, including the dropped count (a timestamp, the server's port). */
  stamp?: () => Record<string, unknown>;
  maxQueuedBytes?: number;
}): RequestLog => {
  const { reportFailure, stamp = () => ({}), maxQueuedBytes = MAX_QUEUED_BYTES } = options;
  const stream = createWriteStream(options.file, { flags: "a" });
  let state: "open" | "closed" | "failed" = "open";
  let dropped = 0;
  let closing: Promise<void> | undefined;

  const fail = (error: unknown) => {
    if (state === "failed") return;
    state = "failed";
    stream.destroy();
    reportFailure(error);
  };
  stream.on("error", fail);

  const append = (entry: Record<string, unknown>) => {
    try {
      stream.write(JSON.stringify({ ...stamp(), ...entry }) + "\n");
    } catch (error) {
      fail(error);
    }
  };

  const appendDropped = () => {
    if (dropped === 0) return;
    append({ ev: "dropped", count: dropped });
    dropped = 0;
  };

  return {
    write: (entry) => {
      if (state !== "open") return;
      if (stream.writableLength >= maxQueuedBytes) {
        dropped += 1;
        return;
      }
      appendDropped();
      append(entry);
    },
    close: () => {
      closing ??= (async () => {
        if (state === "open") {
          state = "closed";
          appendDropped();
          stream.end();
        }
        // A failure while flushing has already gone to reportFailure through the error listener.
        await finished(stream).catch(() => undefined);
      })();
      return closing;
    },
  };
};
