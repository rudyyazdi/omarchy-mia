import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { Transform, Writable, type Readable, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { LineSplitter } from "./stream.ts";

/**
 * Appends to `file`, opened (and created, owner-only) on the first write, so a turn that retains nothing leaves no
 * file. The first failure, to open or to write, goes to `reportFailure` and turns retention off; later chunks are
 * accepted and dropped, so a bad transcript never stops the runtime's output from being read.
 */
const transcriptSink = (file: string, reportFailure: (error: unknown) => void): Writable => {
  let handle: Promise<FileHandle> | null = null;
  let failed = false;
  let closing: Promise<void> | null = null;
  const append = async (chunk: string): Promise<void> => {
    if (failed) return;
    try {
      handle ??= open(file, "a", 0o600);
      await (await handle).write(chunk);
    } catch (error) {
      failed = true;
      reportFailure(error);
    }
  };
  // A failed open or close loses nothing the transcript still needs: every write has already settled.
  const close = (): Promise<void> => {
    closing ??= handle ? handle.then((opened) => opened.close()) : Promise.resolve();
    return closing;
  };
  return new Writable({
    decodeStrings: false,
    write: (chunk: string, _encoding, callback) => {
      // `append` reports its own failures, so neither outcome fails the stream.
      append(chunk).then(
        () => callback(),
        () => callback(),
      );
    },
    final: (callback) => {
      close().then(
        () => callback(),
        () => callback(),
      );
    },
    destroy: (error, callback) => {
      close().then(
        () => callback(error),
        () => callback(error),
      );
    },
  });
};

/**
 * Reads the runtime's stdout one line at a time, hands each line to `handleLine`, and appends the text it returns
 * (the redacted transcript line) to `file`. Resolves once stdout has ended and every retained line is written, so
 * a reader of `file` after it resolves sees the whole transcript.
 *
 * Reading and writing share one pipeline, so a slow disk pauses stdout (and so the runtime) instead of queueing
 * lines in memory. Rejects only if stdout fails or `handleLine` throws; a transcript failure is reported instead.
 */
export const retainStdout = async (input: {
  stdout: Readable;
  file: string;
  /** Handles one line of stdout; returns the text to retain for it, or null to retain nothing. */
  handleLine: (line: string) => string | null;
  /** Called at most once, with the first failure to open or write `file`. */
  reportFailure: (error: unknown) => void;
}): Promise<void> => {
  const { stdout, handleLine } = input;
  const splitter = new LineSplitter();
  /** The transcript text for these lines, or undefined (push nothing) when none is retained. */
  const retain = (lines: string[]): string | undefined => {
    const text = lines
      .flatMap((line) => {
        const retained = handleLine(line);
        return retained === null ? [] : [`${retained}\n`];
      })
      .join("");
    return text === "" ? undefined : text;
  };
  // A throw from `handleLine` fails the pipeline instead of escaping into stdout's event listener.
  const pushRetained = (lines: () => string[], callback: TransformCallback): void => {
    let text: string | undefined;
    try {
      text = retain(lines());
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    callback(null, text);
  };
  stdout.setEncoding("utf8");
  await pipeline(
    stdout,
    new Transform({
      decodeStrings: false,
      transform: (chunk: string, _encoding, callback) => {
        pushRetained(() => splitter.push(chunk), callback);
      },
      flush: (callback) => {
        pushRetained(() => splitter.flush(), callback);
      },
    }),
    transcriptSink(input.file, input.reportFailure),
  );
};
