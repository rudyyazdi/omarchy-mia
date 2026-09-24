import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { access, chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { sha256Hex } from "@mia/protocol";
import type { CatalogPaths } from "./catalog.ts";
import type { ObjectIntegrity } from "./schema.ts";

/** Writes `bytes` to a new owner-only file at `path` and fsyncs it. */
const writeDurably = async (
  path: string,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<void> => {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes, { signal });
    await handle.sync();
  } finally {
    await handle.close().catch(() => {
      // The bytes are fsynced before the close, so a failed close loses nothing, and it must not hide the
      // error of a write that failed.
    });
  }
};

/**
 * Makes a directory's entries durable: a rename or mkdir survives a crash only once the directory it changed is
 * fsynced. Injected so a test can observe when that happens.
 */
export interface DirectoryFsync {
  flush: (directory: string) => Promise<void>;
}

const fsyncDirectory = async (directory: string): Promise<void> => {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => {
      // Closing a directory handle loses nothing, and it must not hide the error of a failed fsync.
    });
  }
};

const diskDirectories: DirectoryFsync = { flush: fsyncDirectory };

/**
 * The directories whose entries a recursive mkdir of `leaf` changed, top down, given the first directory it
 * created (mkdir's result; undefined when `leaf` already existed): the parent of each directory it created.
 */
const parentsOfCreated = (firstCreated: string | undefined, leaf: string): string[] => {
  if (firstCreated === undefined) return [];
  const below = relative(firstCreated, leaf)
    .split(sep)
    .filter((segment) => segment.length > 0);
  const created = [
    firstCreated,
    ...below.map((_, index) => join(firstCreated, ...below.slice(0, index + 1))),
  ];
  return created.map((directory) => dirname(directory));
};

export interface StoredObject {
  digest: string;
  byteCount: number;
  storageKey: string;
}

/**
 * Content-addressed immutable object store. Bytes are staged, hashed, fsynced and renamed into
 * place, and the directories the rename and mkdir changed are fsynced, before any catalog row references
 * them. A crash may leave an orphan in staging or an unreferenced object; it can never produce a catalog row
 * that points at unwritten bytes. An object already in place counts as stored: a put that finds it does not
 * fsync again, so it relies on the put that renamed it having synced it.
 */
export class ObjectStore {
  constructor(
    readonly paths: CatalogPaths,
    private readonly directories: DirectoryFsync = diskDirectories,
  ) {}

  static digestOf(bytes: Uint8Array): string {
    return sha256Hex(bytes);
  }

  storageKey(digest: string): string {
    return join("objects", "sha256", digest.slice(0, 2), digest);
  }

  pathFor(digest: string): string {
    return join(this.paths.root, this.storageKey(digest));
  }

  /** Where `bytes` are stored, computed without touching the disk. */
  private describe(bytes: Uint8Array): StoredObject {
    const digest = ObjectStore.digestOf(bytes);
    return { digest, byteCount: bytes.byteLength, storageKey: this.storageKey(digest) };
  }

  /**
   * Store `bytes` before the transaction that references them opens, so the write, fsync and rename stall only
   * the commit that needs the object, never the other connections. Idempotent: bytes already stored are left as
   * they are, without another fsync. An abort or a failure before the rename removes the staged file and leaves
   * no object. A failed directory fsync after the rename rejects, so this caller records no reference; the object
   * stays in place, and a later put of the same bytes finds it and trusts it like any stored object.
   */
  async put(bytes: Uint8Array, options: { signal: AbortSignal }): Promise<StoredObject> {
    const { signal } = options;
    const stored = this.describe(bytes);
    const target = this.pathFor(stored.digest);
    const present = await access(target).then(
      () => true,
      () => false,
    );
    if (present) return stored;
    signal.throwIfAborted();
    await mkdir(this.paths.staging, { recursive: true, mode: 0o700 });
    const staged = join(this.paths.staging, `${randomUUID()}.tmp`);
    try {
      await writeDurably(staged, bytes, signal);
      signal.throwIfAborted();
      const directory = dirname(target);
      const firstCreated = await mkdir(directory, { recursive: true, mode: 0o700 });
      for (const parent of parentsOfCreated(firstCreated, directory))
        await this.directories.flush(parent);
      await rename(staged, target);
    } catch (error) {
      await rm(staged, { force: true });
      throw error;
    }
    await chmod(target, 0o400).catch(() => {
      /* best effort */
    });
    await this.directories.flush(dirname(target));
    return stored;
  }

  /** The stored bytes of `digest`, as written; the caller checks them against the digest when it matters. */
  read(digest: string, options: { signal: AbortSignal }): Promise<Buffer> {
    return readFile(this.pathFor(digest), { signal: options.signal });
  }

  readSync(digest: string): Buffer {
    return readFileSync(this.pathFor(digest));
  }

  /** Verify bytes on disk still match the digest. */
  verifySync(digest: string, expectedBytes?: number): ObjectIntegrity {
    const path = this.pathFor(digest);
    if (!existsSync(path)) return "missing";
    const bytes = readFileSync(path);
    if (expectedBytes !== undefined && bytes.byteLength !== expectedBytes) return "corrupt";
    return ObjectStore.digestOf(bytes) === digest ? "verified" : "corrupt";
  }
}
