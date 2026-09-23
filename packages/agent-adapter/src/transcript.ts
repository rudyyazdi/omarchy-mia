import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { Transform, Writable, type Readable, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { LineSplitter } from "./stream.ts";

/**
 * Appends to `file`, opened (and created, owner-only) on the first write, so a turn that retains nothing leaves no
 * file. The first failure, to open, write or close, goes to `reportFailure` and turns retention off; later chunks
 * are accepted and dropped, so a bad transcript never stops the runtime's output from being read.
 */
const transcriptSink = (file: string, reportFailure: (error: unknown) => void): Writable => {
  let handle: Promise<FileHandle> | null = null;
  let failed = false;
  let closing: Promise<void> | null = null;
  const fail = (error: unknown): void => {
    if (failed) return;
    failed = true;
    reportFailure(error);
  };
  const append = async (chunk: Buffer): Promise<void> => {
    if (failed) return;
    try {
      handle ??= open(file, "a", 0o600);
      // appendFile writes the whole chunk, where a single write() may stop short on a nearly full disk.
      await (await handle).appendFile(chunk);
    } catch (error) {
      fail(error);
    }
  };
  const close = (): Promise<void> => {
    closing ??= handle ? handle.then((opened) => opened.close()) : Promise.resolve();
    return closing;
  };
  return new Writable({
    // Strings arrive converted to Buffers (decodeStrings defaults to true), so every chunk is a Buffer.
    write: (chunk: Buffer, _encoding, callback) => {
      // `append` reports its own failures, so neither outcome fails the stream.
      append(chunk).then(
        () => callback(),
        () => callback(),
      );
    },
    // Some filesystems report a deferred write error only at close, so a failed close is reported too.
    final: (callback) => {
      close().then(
        () => callback(),
        (error: unknown) => {
          fail(error);
          callback();
        },
      );
    },
    // Destroyed only when the read stops early, so the transcript is incomplete anyway; closing just frees the handle.
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
 * Reading and writing share one pipeline, so a slow disk or a slow `handleLine` pauses stdout (and so the runtime)
 * instead of queueing lines in memory: the next line is handed over only once the previous one's handling has
 * settled. The tradeoff is ordering: a line's events are handled before its text is written, so a crash mid-turn
 * can leave the records with events whose transcript lines (up to the streams' buffers) were never written.
 *
 * Rejects if stdout fails, `handleLine` rejects, or `signal` aborts, and then stops reading; a transcript failure
 * is reported instead. When `handleLine` rejects, the text of the lines before it in the same chunk is dropped.
 */
export const retainStdout = async (input: {
  stdout: Readable;
  file: string;
  /** Handles one line of stdout; resolves to the text to retain for it, or null to retain nothing. */
  handleLine: (line: string) => Promise<string | null>;
  /** Called at most once, with the first failure to open, write or close `file`. */
  reportFailure: (error: unknown) => void;
  signal?: AbortSignal;
}): Promise<void> => {
  const { stdout, handleLine } = input;
  const splitter = new LineSplitter();
  /** The transcript text for these lines, or undefined (push nothing) when none is retained. */
  const retain = async (lines: string[]): Promise<string | undefined> => {
    let text = "";
    for (const line of lines) {
      const retained = await handleLine(line);
      if (retained !== null) text += `${retained}\n`;
    }
    return text === "" ? undefined : text;
  };
  // The transform is not called again until `callback` runs, so lines are handled one at a time, in order. A
  // failure of `handleLine` fails the pipeline instead of escaping into stdout's event listener.
  const pushRetained = (lines: () => string[], callback: TransformCallback): void => {
    Promise.try(() => retain(lines())).then(
      (text) => callback(null, text),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
    );
  };
  // Decoded before splitting, so a character split across chunks reaches `handleLine` whole.
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
    { signal: input.signal },
  );
};
