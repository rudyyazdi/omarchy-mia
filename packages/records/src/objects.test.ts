import {
  mkdirSync,
  mkdtempDisposableSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { catalogPaths } from "./catalog.ts";
import { ObjectStore } from "./objects.ts";

const bytes = Buffer.from("retained bytes");
const live = () => ({ signal: new AbortController().signal });

describe("ObjectStore.put", () => {
  it("stores bytes read-only under their digest, as putSync does", async () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-objects-"));
    const store = new ObjectStore(catalogPaths(directory.path));
    const stored = await store.put(bytes, live());
    expect(stored).toEqual(new ObjectStore(catalogPaths(join(directory.path, "x"))).putSync(bytes));
    const path = store.pathFor(stored.digest);
    expect(readFileSync(path)).toEqual(bytes);
    expect(statSync(path).mode & 0o777).toBe(0o400);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(store.verifySync(stored.digest, bytes.byteLength)).toBe("verified");
  });

  it("stores the same bytes once, even when put concurrently", async () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-objects-"));
    const store = new ObjectStore(catalogPaths(directory.path));
    const [one, two] = await Promise.all([store.put(bytes, live()), store.put(bytes, live())]);
    expect(one).toEqual(two);
    expect(await store.put(bytes, live())).toEqual(one);
    expect(readdirSync(dirname(store.pathFor(one.digest)))).toEqual([one.digest]);
    expect(readdirSync(store.paths.staging)).toEqual([]);
    expect(store.verifySync(one.digest)).toBe("verified");
  });

  it("stores nothing once its signal has aborted", async () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-objects-"));
    const store = new ObjectStore(catalogPaths(directory.path));
    const controller = new AbortController();
    controller.abort(new Error("deadline"));
    await expect(store.put(bytes, { signal: controller.signal })).rejects.toThrow("deadline");
    expect(store.verifySync(ObjectStore.digestOf(bytes))).toBe("missing");
  });

  it("removes its staged file when the object cannot be moved into place", async () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-objects-"));
    const store = new ObjectStore(catalogPaths(directory.path));
    const parent = dirname(store.pathFor(ObjectStore.digestOf(bytes)));
    mkdirSync(dirname(parent), { recursive: true });
    writeFileSync(parent, ""); // a file where the object's directory belongs
    await expect(store.put(bytes, live())).rejects.toThrow();
    expect(readdirSync(store.paths.staging)).toEqual([]);
  });
});
