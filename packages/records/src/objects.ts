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
import { dirname, join } from "node:path";
import { sha256Hex } from "@mia/protocol";
import type { CatalogPaths } from "./catalog.ts";
import type { ObjectIntegrity } from "./schema.ts";

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

  put(bytes: Uint8Array): StoredObject {
    const digest = ObjectStore.digestOf(bytes);
    const target = this.pathFor(digest);
    // eslint-disable-next-line no-restricted-syntax -- on the serving path until #53 moves it before the transaction
    if (existsSync(target))
      return { digest, byteCount: bytes.byteLength, storageKey: this.storageKey(digest) };
    // eslint-disable-next-line no-restricted-syntax -- on the serving path until #53 moves it before the transaction
    mkdirSync(this.paths.staging, { recursive: true, mode: 0o700 });
    const staged = join(this.paths.staging, `${randomUUID()}.tmp`);
    // eslint-disable-next-line no-restricted-syntax -- on the serving path until #53 moves it before the transaction
    const fd = openSync(staged, "w", 0o600);
    try {
      let offset = 0;
      while (offset < bytes.byteLength)
        // eslint-disable-next-line no-restricted-syntax -- on the serving path until #53 moves it before the transaction
        offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
      // eslint-disable-next-line no-restricted-syntax -- on the serving path until #53 moves it before the transaction
      fsyncSync(fd);
    } finally {
      // eslint-disable-next-line no-restricted-syntax -- on the serving path until #53 moves it before the transaction
      closeSync(fd);
    }
    // eslint-disable-next-line no-restricted-syntax -- on the serving path until #53 moves it before the transaction
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    // eslint-disable-next-line no-restricted-syntax -- on the serving path until #53 moves it before the transaction
    renameSync(staged, target);
    try {
      // eslint-disable-next-line no-restricted-syntax -- on the serving path until #53 moves it before the transaction
      chmodSync(target, 0o400);
    } catch {
      /* best effort */
    }
    return { digest, byteCount: bytes.byteLength, storageKey: this.storageKey(digest) };
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
