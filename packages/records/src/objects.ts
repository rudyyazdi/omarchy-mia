import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { access, chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
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

export interface StoredObject {
  digest: string;
  byteCount: number;
  storageKey: string;
}

/**
 * Content-addressed immutable object store. Bytes are staged, hashed, fsynced and renamed into
 * place before any catalog row references them. A crash may leave an orphan in staging or an
 * unreferenced object; it can never produce a catalog row that points at unwritten bytes.
 */
export class ObjectStore {
  constructor(readonly paths: CatalogPaths) {}

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
   * they are. An abort or a failure removes the staged file and leaves no object.
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
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await rename(staged, target);
    } catch (error) {
      await rm(staged, { force: true });
      throw error;
    }
    await chmod(target, 0o400).catch(() => {
      /* best effort */
    });
    return stored;
  }

  /** `put`, blocking: only for a caller that cannot await yet (conversation start, until #53 makes engine commands async). */
  putSync(bytes: Uint8Array): StoredObject {
    const stored = this.describe(bytes);
    const target = this.pathFor(stored.digest);
    if (existsSync(target)) return stored;
    mkdirSync(this.paths.staging, { recursive: true, mode: 0o700 });
    const staged = join(this.paths.staging, `${randomUUID()}.tmp`);
    const fd = openSync(staged, "w", 0o600);
    try {
      let offset = 0;
      while (offset < bytes.byteLength)
        offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    renameSync(staged, target);
    try {
      chmodSync(target, 0o400);
    } catch {
      /* best effort */
    }
    return stored;
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
