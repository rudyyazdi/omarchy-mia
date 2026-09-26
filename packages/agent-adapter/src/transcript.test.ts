import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { retainStdout } from "./transcript.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mia-transcript-"));
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

/** Runs `retainStdout` over `chunks`, retaining each line upper-cased and skipping lines that read `skip`. */
const retain = async (file: string, chunks: (string | Buffer)[]) => {
  const stdout = new PassThrough();
  const handled: string[] = [];
  const failures: unknown[] = [];
  const read = retainStdout({
    stdout,
    file,
    handleLine: async (line) => {
      handled.push(line);
      return line === "skip" ? null : line.toUpperCase();
    },
    reportFailure: (error) => failures.push(error),
  });
  for (const chunk of chunks) stdout.write(chunk);
  stdout.end();
  await read;
  return { handled, failures };
};

describe("retainStdout", () => {
  it("hands over every line, including one split across chunks or left unterminated, and has retained them all when it resolves", async () => {
    const file = join(dir, "turn.stream.jsonl");
    const { handled, failures } = await retain(file, ["one\ntw", "o\nskip\n", "three"]);
    expect(handled).toEqual(["one", "two", "skip", "three"]);
    expect(await readFile(file, "utf8")).toBe("ONE\nTWO\nTHREE\n");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(failures).toEqual([]);
  });

  it("hands over a character whose bytes are split across chunks whole", async () => {
    const file = join(dir, "turn.stream.jsonl");
    const { handled } = await retain(file, [Buffer.from([0xe2, 0x82]), Buffer.from([0xac, 0x0a])]);
    expect(handled).toEqual(["€"]);
    expect(await readFile(file, "utf8")).toBe("€\n");
  });

  it("appends to a transcript that already exists", async () => {
    const file = join(dir, "turn.stream.jsonl");
    await retain(file, ["one\n"]);
    await retain(file, ["two\n"]);
    expect(await readFile(file, "utf8")).toBe("ONE\nTWO\n");
  });

  it("creates no transcript when no line is retained", async () => {
    const file = join(dir, "turn.stream.jsonl");
    await retain(file, ["skip\n"]);
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a transcript it cannot open once and still hands over every line", async () => {
    const { handled, failures } = await retain(dir, ["one\n", "two\n", "three\n"]);
    expect(handled).toEqual(["one", "two", "three"]);
    expect(failures).toEqual([expect.objectContaining({ code: "EISDIR" })]);
  });

  it("hands over the next line only once the previous one's handling has settled", async () => {
    const stdout = new PassThrough();
    const handled: string[] = [];
    const firstStarted = Promise.withResolvers<undefined>();
    const firstRelease = Promise.withResolvers<undefined>();
    let released = false;
    const read = retainStdout({
      stdout,
      file: join(dir, "turn.stream.jsonl"),
      handleLine: async (line) => {
        handled.push(`${line} (first released: ${released})`);
        if (line === "one") {
          firstStarted.resolve(undefined);
          await firstRelease.promise;
        }
        return line;
      },
      reportFailure: () => undefined,
    });
    stdout.write("one\n");
    stdout.write("two\nthree\n");
    stdout.end();
    await firstStarted.promise;
    released = true;
    firstRelease.resolve(undefined);
    await read;
    expect(handled).toEqual([
      "one (first released: false)",
      "two (first released: true)",
      "three (first released: true)",
    ]);
  });

  it("reports a failed write once and still hands over every line", async () => {
    const { handled, failures } = await retain("/dev/full", ["one\n", "two\n", "three\n"]);
    expect(handled).toEqual(["one", "two", "three"]);
    expect(failures).toEqual([expect.objectContaining({ code: "ENOSPC" })]);
  });

  it("rejects when handling a line rejects, instead of throwing from the stream", async () => {
    const stdout = new PassThrough();
    const read = retainStdout({
      stdout,
      file: join(dir, "turn.stream.jsonl"),
      handleLine: async () => {
        throw new Error("handler failed");
      },
      reportFailure: () => undefined,
    });
    stdout.write("one\n");
    await expect(read).rejects.toThrow("handler failed");
    expect(stdout.destroyed).toBe(true);
  });

  it("stops reading, and hands over no line it already read, once its signal aborts", async () => {
    const controller = new AbortController();
    const stdout = new PassThrough();
    const handled: string[] = [];
    const read = retainStdout({
      stdout,
      file: join(dir, "turn.stream.jsonl"),
      handleLine: async (line) => {
        handled.push(line);
        controller.abort();
        return line;
      },
      reportFailure: () => undefined,
      signal: controller.signal,
    });
    stdout.write("one\ntwo\nthree\n");
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
    expect(handled).toEqual(["one"]);
    expect(stdout.destroyed).toBe(true);
  });
});
