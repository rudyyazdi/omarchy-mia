import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLogEntries } from "./log-fixture.ts";
import { createRequestLog } from "./request-log.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mia-request-log-"));
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

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
    expect(await readLogEntries(file)).toEqual([
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

  // /dev/full opens but fails every write with ENOSPC; it exists only on Linux.
  it.skipIf(process.platform !== "linux")(
    "reports a write that fails after the file opened, once",
    async () => {
      const { failures, reported, reportFailure } = failureRecorder();
      const log = createRequestLog({ file: "/dev/full", reportFailure });
      log.write({ ev: "request", req: 1 });
      await reported;
      log.write({ ev: "finish", req: 1 });
      await log.close();
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ code: "ENOSPC" });
    },
  );

  it("reports a record it cannot serialise and stays off, without throwing", async () => {
    const { file, failures, log } = openLog();
    log.write({ ev: "request", req: 1 });
    expect(() => log.write({ ev: "finish", req: 1n })).not.toThrow();
    log.write({ ev: "close", req: 1 });
    await log.close();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(TypeError);
    expect(await readFile(file, "utf8").catch(() => "")).not.toContain('"close"');
  });

  it("drops records while the queue is full and logs how many", async () => {
    const file = join(dir, "requests.jsonl");
    let sequence = 0;
    const log = createRequestLog({
      file,
      reportFailure: () => undefined,
      stamp: () => ({ seq: ++sequence }),
      maxQueuedBytes: 1,
    });
    // The first record is still queued for the disk when the next two arrive.
    log.write({ ev: "request", req: 1 });
    log.write({ ev: "finish", req: 1 });
    log.write({ ev: "close", req: 1 });
    await log.close();
    expect(await readLogEntries(file)).toEqual([
      { seq: 1, ev: "request", req: 1 },
      { seq: 2, ev: "dropped", count: 2 },
    ]);
  });

  it("ignores writes after close, and closes again without error", async () => {
    const { file, failures, log } = openLog();
    log.write({ ev: "request", req: 1 });
    const closing = log.close();
    // Still flushing: a write now must not reach the ended stream and fail it.
    expect(() => log.write({ ev: "finish", req: 1 })).not.toThrow();
    await closing;
    expect(() => log.write({ ev: "close", req: 1 })).not.toThrow();
    await expect(log.close()).resolves.toBeUndefined();
    expect(await readLogEntries(file)).toEqual([{ ev: "request", req: 1 }]);
    expect(failures).toEqual([]);
  });
});
