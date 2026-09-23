import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempDisposableSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_ARTIFACT_BYTES } from "./artifact-capture.ts";
import {
  collectArtifact,
  createArtifactCollector,
  type ArtifactCollector,
  type CaptureFs,
} from "./artifact-collector.ts";

/** A collector over the real filesystem that records every path it resolves or opens. */
const recordingCollector = (): {
  collect: ArtifactCollector;
  resolved: string[];
  opened: string[];
} => {
  const resolved: string[] = [];
  const opened: string[] = [];
  const fs: CaptureFs = {
    realpath: async (path) => {
      resolved.push(path);
      return realpath(path);
    },
    stat,
    open: async (path, flags) => {
      opened.push(path);
      return open(path, flags);
    },
  };
  return { collect: createArtifactCollector(fs), resolved, opened };
};

const workspace = (): { root: string; out: string; [Symbol.dispose]: () => void } => {
  const directory = mkdtempDisposableSync(join(tmpdir(), "mia-artifacts-"));
  const out = join(directory.path, "out");
  mkdirSync(out);
  return { root: directory.path, out, [Symbol.dispose]: () => directory.remove() };
};

describe("collectArtifact", () => {
  it("retains a file reached through a symlink that resolves inside the output directory", async () => {
    using dirs = workspace();
    writeFileSync(join(dirs.out, "real.txt"), "D1");
    symlinkSync(join(dirs.out, "real.txt"), join(dirs.out, "link.txt"));
    const { collect, opened } = recordingCollector();
    expect(await collect({ path: join(dirs.out, "link.txt") }, [dirs.out])).toEqual({
      status: "retained",
      bytes: Buffer.from("D1"),
    });
    // Only the resolved target is opened, never the symlink itself.
    expect(opened).toEqual([await realpath(join(dirs.out, "real.txt"))]);
  });

  it("resolves a symlinked output directory before checking containment", async () => {
    using dirs = workspace();
    writeFileSync(join(dirs.out, "a.txt"), "D1");
    const alias = join(dirs.root, "alias");
    symlinkSync(dirs.out, alias);
    expect((await collectArtifact({ path: join(dirs.out, "a.txt") }, [alias])).status).toBe(
      "retained",
    );
  });

  it("never opens a file outside the output directory, directly or through a symlink", async () => {
    using dirs = workspace();
    const secret = join(dirs.root, "secret.txt");
    writeFileSync(secret, "private");
    symlinkSync(secret, join(dirs.out, "escape.txt"));
    const { collect, opened } = recordingCollector();
    for (const path of [secret, join(dirs.out, "escape.txt")])
      expect((await collect({ path }, [dirs.out])).status).toBe("external_only");
    expect(opened).toEqual([]);
  });

  it("refuses a relative path without touching the filesystem", async () => {
    using dirs = workspace();
    const { collect, resolved, opened } = recordingCollector();
    expect((await collect({ path: "out/a.txt" }, [dirs.out])).status).toBe("failed");
    expect(resolved).toEqual([]);
    expect(opened).toEqual([]);
  });

  it("reports a dangling symlink as missing without reading", async () => {
    using dirs = workspace();
    symlinkSync(join(dirs.out, "gone.txt"), join(dirs.out, "dangling.txt"));
    const { collect, opened } = recordingCollector();
    expect((await collect({ path: join(dirs.out, "dangling.txt") }, [dirs.out])).status).toBe(
      "missing",
    );
    expect(opened).toEqual([]);
  });

  it("treats an output directory that does not exist as containing nothing", async () => {
    using dirs = workspace();
    writeFileSync(join(dirs.out, "a.txt"), "D1");
    const capture = await collectArtifact({ path: join(dirs.out, "a.txt") }, [
      join(dirs.root, "none"),
    ]);
    expect(capture.status).toBe("external_only");
  });

  it("fails a file over the size limit without reading it", async () => {
    using dirs = workspace();
    const large = join(dirs.out, "large.bin");
    writeFileSync(large, "");
    truncateSync(large, MAX_ARTIFACT_BYTES + 1); // sparse: no bytes written to disk
    const { collect, opened } = recordingCollector();
    expect(await collect({ path: large }, [dirs.out])).toEqual({
      status: "failed",
      reason: `declared file is ${MAX_ARTIFACT_BYTES + 1} bytes, over the ${MAX_ARTIFACT_BYTES}-byte limit`,
    });
    expect(opened).toEqual([]);
  });

  it("fails a file that grew after it was admitted instead of reading past its size", async () => {
    using dirs = workspace();
    const file = join(dirs.out, "growing.txt");
    writeFileSync(file, "grown");
    const collect = createArtifactCollector({
      realpath,
      stat,
      open: async (path, flags) => {
        const handle = await open(path, flags);
        return {
          // As admitted, before the tool appended to it.
          stat: async () => ({ isFile: () => true, size: 2 }),
          read: async (...args) => handle.read(...args),
          close: async () => handle.close(),
        };
      },
    });
    expect(await collect({ path: file }, [dirs.out])).toEqual({
      status: "failed",
      reason: "declared file changed during collection",
    });
  });

  // Covers a regular file swapped for a FIFO after admission. Without O_NONBLOCK the open waits for a
  // writer and this test hangs; the handle's own stat then refuses what the path stat admitted.
  it("re-refuses a file that became a FIFO after admission without blocking on it", async () => {
    using dirs = workspace();
    const fifo = join(dirs.out, "swapped");
    execFileSync("mkfifo", [fifo]);
    const collect = createArtifactCollector({
      realpath,
      stat: async () => ({ isFile: () => true, size: 0 }), // as admitted, before the swap
      open,
    });
    expect(await collect({ path: fifo }, [dirs.out])).toEqual({
      status: "failed",
      reason: "declared path is not a regular file",
    });
  });

  it("does not follow a symlink swapped in after the path was resolved", async () => {
    using dirs = workspace();
    writeFileSync(join(dirs.out, "real.txt"), "D1");
    const link = join(dirs.out, "link.txt");
    symlinkSync(join(dirs.out, "real.txt"), link);
    const collect = createArtifactCollector({
      // As if the declared path was a regular file when resolved, then replaced by a symlink.
      realpath: async (path) => (path === link ? path : realpath(path)),
      stat,
      open,
    });
    const capture = await collect({ path: link }, [dirs.out]);
    expect(capture).toEqual({ status: "failed", reason: expect.stringContaining("ELOOP") });
  });

  // Opening a FIFO blocks until a writer appears, so reading one would hang the server.
  it("fails a directory or FIFO inside the output directory without reading it", async () => {
    using dirs = workspace();
    mkdirSync(join(dirs.out, "folder"));
    execFileSync("mkfifo", [join(dirs.out, "fifo")]);
    const { collect, opened } = recordingCollector();
    for (const name of ["folder", "fifo"])
      expect(await collect({ path: join(dirs.out, name) }, [dirs.out])).toEqual({
        status: "failed",
        reason: "declared path is not a regular file",
      });
    expect(opened).toEqual([]);
  });
});
