import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { access, chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { isNotFound, sha256Hex } from "@mia/protocol";
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
/** What `readVerified` found: the bytes, or which integrity problem kept it from returning them. */
export type VerifiedRead =
  | { status: "verified"; bytes: Buffer }
  | { status: Exclude<ObjectIntegrity, "verified"> }
  | { status: "over_limit" };

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

  /**
   * The stored bytes of `digest`, once they match it, or why they cannot be trusted. The size on disk is checked
   * before anything is read, so a replaced object over `maxBytes` never enters memory; `expectedBytes` is the size
   * the catalog recorded, when it did. A failure to open or read other than a missing file rejects, as does an abort.
   */
  async readVerified(
    digest: string,
    options: { expectedBytes: number | null; maxBytes: number; signal: AbortSignal },
  ): Promise<VerifiedRead> {
    const { expectedBytes, maxBytes, signal } = options;
    const handle = await open(this.pathFor(digest), "r").catch((error: unknown) => {
      if (isNotFound(error)) return null;
      throw error;
    });
    if (!handle) return { status: "missing" };
    try {
      const { size } = await handle.stat();
      if (size > maxBytes) return { status: "over_limit" };
      if (expectedBytes !== null && size !== expectedBytes) return { status: "corrupt" };
      // Stored objects are read-only and never rewritten, so the file keeps the size just checked.
      const bytes = await handle.readFile({ signal });
      return ObjectStore.digestOf(bytes) === digest
        ? { status: "verified", bytes }
        : { status: "corrupt" };
    } finally {
      await handle.close();
    }
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
