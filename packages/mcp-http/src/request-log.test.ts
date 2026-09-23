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

describe("request log", () => {
  it("appends one JSON line per entry", async () => {
    const file = join(dir, "requests.jsonl");
    const failures: unknown[] = [];
    const log = createRequestLog(file, (error) => failures.push(error));
    log({ ev: "request", req: 1 });
    log({ ev: "finish", req: 1 });
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { ev: "request", req: 1 },
      { ev: "finish", req: 1 },
    ]);
    expect(failures).toEqual([]);
  });

  it("reports the first failed write once and stops logging, without throwing", () => {
    const failures: unknown[] = [];
    const log = createRequestLog(dir, (error) => failures.push(error));
    expect(() => log({ ev: "request", req: 1 })).not.toThrow();
    expect(() => log({ ev: "finish", req: 1 })).not.toThrow();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code: "EISDIR" });
  });

  it("stays off after a failure even once the path becomes writable", async () => {
    const failures: unknown[] = [];
    const log = createRequestLog(dir, (error) => failures.push(error));
    log({ ev: "request", req: 1 });
    await rm(dir, { recursive: true });
    log({ ev: "finish", req: 1 });
    await expect(access(dir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(failures).toHaveLength(1);
  });
});
