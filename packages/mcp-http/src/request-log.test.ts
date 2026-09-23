import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequestLog } from "./request-log.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mia-request-log-"));
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

const readEntries = async (file: string): Promise<unknown[]> =>
  (await readFile(file, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));

/** Collects reported failures; `reported` resolves on the first one. */
const failureRecorder = () => {
  const failures: unknown[] = [];
  const first = Promise.withResolvers<undefined>();
  const reportFailure = (error: unknown) => {
    failures.push(error);
    first.resolve(undefined);
  };
  return { failures, reported: first.promise, reportFailure };
};

/** A log on a writable file in the test directory. */
const openLog = () => {
  const file = join(dir, "requests.jsonl");
  const { failures, reportFailure } = failureRecorder();
  return { file, failures, log: createRequestLog({ file, reportFailure }) };
};

describe("request log", () => {
  it("appends one JSON line per entry, all written by close", async () => {
    const { file, failures, log } = openLog();
    log.write({ ev: "request", req: 1 });
    log.write({ ev: "finish", req: 1 });
    await log.close();
    expect(await readEntries(file)).toEqual([
      { ev: "request", req: 1 },
      { ev: "finish", req: 1 },
    ]);
    expect(failures).toEqual([]);
  });

  it("reports the first failure once and stops logging, without throwing", async () => {
    const { failures, reported, reportFailure } = failureRecorder();
    const log = createRequestLog({ file: dir, reportFailure });
    expect(() => log.write({ ev: "request", req: 1 })).not.toThrow();
    await reported;
    expect(() => log.write({ ev: "finish", req: 1 })).not.toThrow();
    await log.close();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code: "EISDIR" });
  });

  it("stays off after a failure even once the path becomes writable", async () => {
    const { failures, reported, reportFailure } = failureRecorder();
    const log = createRequestLog({ file: dir, reportFailure });
    await reported;
    await rm(dir, { recursive: true });
    log.write({ ev: "finish", req: 1 });
    await log.close();
    await expect(access(dir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(failures).toHaveLength(1);
  });

  it("drops records while the queue is full and logs how many", async () => {
    const file = join(dir, "requests.jsonl");
    const log = createRequestLog({ file, reportFailure: () => undefined, maxQueuedBytes: 1 });
    // The first record is still queued for the disk when the next two arrive.
    log.write({ ev: "request", req: 1 });
    log.write({ ev: "finish", req: 1 });
    log.write({ ev: "close", req: 1 });
    await log.close();
    expect(await readEntries(file)).toEqual([
      { ev: "request", req: 1 },
      { ev: "dropped", count: 2 },
    ]);
  });

  it("ignores writes after close, and closes again without error", async () => {
    const { file, failures, log } = openLog();
    log.write({ ev: "request", req: 1 });
    await log.close();
    expect(() => log.write({ ev: "finish", req: 1 })).not.toThrow();
    await expect(log.close()).resolves.toBeUndefined();
    expect(await readEntries(file)).toEqual([{ ev: "request", req: 1 }]);
    expect(failures).toEqual([]);
  });
});
