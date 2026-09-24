import {
  chmodSync,
  existsSync,
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

const objectPathUnder = (root: string) =>
  new ObjectStore(catalogPaths(root)).pathFor(ObjectStore.digestOf(bytes));

/** A store under `root` that records each directory fsync, with whether `bytes` were in place when it ran. */
const recordingStore = (root: string) => {
  const flushed: { directory: string; objectInPlace: boolean }[] = [];
  const record = (directory: string) =>
    flushed.push({ directory, objectInPlace: existsSync(objectPathUnder(root)) });
  const store = new ObjectStore(catalogPaths(root), {
    flush: async (directory) => {
      record(directory);
      await Promise.resolve();
    },
  });
  return { store, flushed };
};

/** The fsyncs a first store under `root` owes: the parent of every directory it created, then the object's. */
const firstStoreFsyncs = (root: string) => [
  { directory: root, objectInPlace: false },
  { directory: join(root, "objects"), objectInPlace: false },
  { directory: join(root, "objects", "sha256"), objectInPlace: false },
  { directory: dirname(objectPathUnder(root)), objectInPlace: true },
];

describe("ObjectStore durability", () => {
  it("fsyncs the directories it created, then the renamed object's directory, before put resolves", async () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-objects-"));
    const { store, flushed } = recordingStore(directory.path);
    await store.put(bytes, live());
    expect(flushed).toEqual(firstStoreFsyncs(directory.path));
  });

  it("fsyncs the objects directory, then the object's, when only the object's directory is new", async () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-objects-"));
    const { store, flushed } = recordingStore(directory.path);
    mkdirSync(store.paths.objects, { recursive: true }); // as Catalog.openSync leaves it
    await store.put(bytes, live());
    expect(flushed).toEqual([
      { directory: store.paths.objects, objectInPlace: false },
      { directory: dirname(objectPathUnder(directory.path)), objectInPlace: true },
    ]);
  });

  it("fsyncs only the object's directory when its parents exist, and nothing for stored bytes", async () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-objects-"));
    const { store, flushed } = recordingStore(directory.path);
    const objectDirectory = dirname(objectPathUnder(directory.path));
    mkdirSync(objectDirectory, { recursive: true });
    await store.put(bytes, live());
    await store.put(bytes, live());
    expect(flushed).toEqual([{ directory: objectDirectory, objectInPlace: true }]);
  });

  it("does not resolve put until the object's directory fsync has finished", async () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-objects-"));
    const objectDirectory = dirname(objectPathUnder(directory.path));
    const reached = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const store = new ObjectStore(catalogPaths(directory.path), {
      flush: async (flushed) => {
        if (flushed !== objectDirectory) return;
        reached.resolve(undefined);
        await release.promise;
      },
    });
    let settled = false;
    const put = store.put(bytes, live()).finally(() => {
      settled = true;
    });
    await reached.promise;
    expect(settled).toBe(false);
    release.resolve(undefined);
    await put;
    expect(settled).toBe(true);
  });

  it("rejects put, leaving the object in place, when the object's directory cannot be fsynced", async () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-objects-"));
    const objectDirectory = dirname(objectPathUnder(directory.path));
    const store = new ObjectStore(catalogPaths(directory.path), {
      flush: async (flushed) => {
        if (flushed === objectDirectory) throw new Error("fsync failed");
        await Promise.resolve();
      },
    });
    await expect(store.put(bytes, live())).rejects.toThrow("fsync failed");
    expect(store.verifySync(ObjectStore.digestOf(bytes))).toBe("verified");
    expect(readdirSync(store.paths.staging)).toEqual([]);
  });

  it("stores nothing when a directory it created cannot be fsynced", async () => {
    using root = mkdtempDisposableSync(join(tmpdir(), "mia-objects-"));
    const store = new ObjectStore(catalogPaths(root.path), {
      flush: async () => {
        await Promise.resolve();
        throw new Error("fsync failed");
      },
    });
    await expect(store.put(bytes, live())).rejects.toThrow("fsync failed");
    expect(store.verifySync(ObjectStore.digestOf(bytes))).toBe("missing");
    expect(readdirSync(store.paths.staging)).toEqual([]);
  });
});

describe("ObjectStore.put", () => {
  it("stores bytes read-only under their digest", async () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-objects-"));
    const store = new ObjectStore(catalogPaths(directory.path));
    const stored = await store.put(bytes, live());
    expect(stored).toEqual({
      digest: ObjectStore.digestOf(bytes),
      byteCount: bytes.byteLength,
      storageKey: store.storageKey(ObjectStore.digestOf(bytes)),
    });
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

describe("ObjectStore.readVerified", () => {
  /** A store under a fresh directory holding `bytes`, removed when the test's `using` scope ends. */
  const storing = async () => {
    const directory = mkdtempDisposableSync(join(tmpdir(), "mia-objects-"));
    const store = new ObjectStore(catalogPaths(directory.path));
    const { digest } = await store.put(bytes, live());
    return { directory, store, digest, [Symbol.dispose]: () => directory.remove() };
  };
  const options = { expectedBytes: null, maxBytes: 1024, ...live() };

  it("returns the stored bytes once they match their digest and recorded size", async () => {
    using stored = await storing();
    expect(
      await stored.store.readVerified(stored.digest, {
        ...options,
        expectedBytes: bytes.byteLength,
      }),
    ).toEqual({ status: "verified", bytes });
  });

  it("refuses by the size on disk, before reading, an object over the bound or of another size", async () => {
    using stored = await storing();
    const { store, digest } = stored;
    expect(
      await store.readVerified(digest, { ...options, maxBytes: bytes.byteLength - 1 }),
    ).toEqual({ status: "over_limit" });
    expect(
      await store.readVerified(digest, { ...options, expectedBytes: bytes.byteLength + 1 }),
    ).toEqual({ status: "corrupt" });
  });

  it("reports a missing object, and one whose bytes no longer match its digest", async () => {
    using stored = await storing();
    const { store, digest } = stored;
    expect(await store.readVerified("0".repeat(64), options)).toEqual({ status: "missing" });
    const path = store.pathFor(digest);
    chmodSync(path, 0o600);
    writeFileSync(path, "altered bytes!");
    expect(await store.readVerified(digest, options)).toEqual({ status: "corrupt" });
  });
});
