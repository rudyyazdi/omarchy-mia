import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CatalogPaths } from "./catalog.ts";

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
    return createHash("sha256").update(bytes).digest("hex");
  }

  storageKey(digest: string): string {
    return join("objects", "sha256", digest.slice(0, 2), digest);
  }

  pathFor(digest: string): string {
    return join(this.paths.root, this.storageKey(digest));
  }

  put(bytes: Uint8Array): StoredObject {
    const digest = ObjectStore.digestOf(bytes);
    const target = this.pathFor(digest);
    if (existsSync(target)) return { digest, byteCount: bytes.byteLength, storageKey: this.storageKey(digest) };
    mkdirSync(this.paths.staging, { recursive: true, mode: 0o700 });
    const staged = join(this.paths.staging, `${randomUUID()}.tmp`);
    const fd = openSync(staged, "w", 0o600);
    try {
      let offset = 0;
      while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
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
    return { digest, byteCount: bytes.byteLength, storageKey: this.storageKey(digest) };
  }

  read(digest: string): Buffer {
    return readFileSync(this.pathFor(digest));
  }

  /** Verify bytes on disk still match the digest. */
  verify(digest: string, expectedBytes?: number): "verified" | "missing" | "corrupt" {
    const path = this.pathFor(digest);
    if (!existsSync(path)) return "missing";
    const bytes = readFileSync(path);
    if (expectedBytes !== undefined && bytes.byteLength !== expectedBytes) return "corrupt";
    return ObjectStore.digestOf(bytes) === digest ? "verified" : "corrupt";
  }
}
