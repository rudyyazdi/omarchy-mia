import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempDisposableSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_ARTIFACT_BYTES } from "./artifact-capture.ts";
import { collectArtifact } from "./artifact-collector.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...filesystem,
    open: vi.fn(filesystem.open),
    realpath: vi.fn(filesystem.realpath),
  };
});

afterEach(() => vi.clearAllMocks());

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
    expect(await collectArtifact({ path: join(dirs.out, "link.txt") }, [dirs.out])).toEqual({
      status: "retained",
      bytes: Buffer.from("D1"),
    });
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
    for (const path of [secret, join(dirs.out, "escape.txt")])
      expect((await collectArtifact({ path }, [dirs.out])).status).toBe("external_only");
    expect(open).not.toHaveBeenCalled();
  });

  it("refuses a relative path without touching the filesystem", async () => {
    using dirs = workspace();
    expect((await collectArtifact({ path: "out/a.txt" }, [dirs.out])).status).toBe("failed");
    expect(realpath).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("reports a dangling symlink as missing without reading", async () => {
    using dirs = workspace();
    symlinkSync(join(dirs.out, "gone.txt"), join(dirs.out, "dangling.txt"));
    expect(
      (await collectArtifact({ path: join(dirs.out, "dangling.txt") }, [dirs.out])).status,
    ).toBe("missing");
    expect(open).not.toHaveBeenCalled();
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
    expect(await collectArtifact({ path: large }, [dirs.out])).toEqual({
      status: "failed",
      reason: `declared file is ${MAX_ARTIFACT_BYTES + 1} bytes, over the ${MAX_ARTIFACT_BYTES}-byte limit`,
    });
    expect(open).not.toHaveBeenCalled();
  });

  it("fails a file that grew after it was admitted instead of reading past its size", async () => {
    using dirs = workspace();
    const file = join(dirs.out, "growing.txt");
    writeFileSync(file, "grown");
    const filesystem = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await filesystem.open(...args);
      vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
        const stats = statSync(file);
        stats.size = 2; // as admitted, before the tool appended to it
        return stats;
      });
      return handle;
    });
    expect(await collectArtifact({ path: file }, [dirs.out])).toEqual({
      status: "failed",
      reason: "declared file changed during collection",
    });
  });

  // Opening a FIFO blocks until a writer appears, so reading one would hang the server.
  it("fails a directory or FIFO inside the output directory without reading it", async () => {
    using dirs = workspace();
    mkdirSync(join(dirs.out, "folder"));
    execFileSync("mkfifo", [join(dirs.out, "fifo")]);
    for (const name of ["folder", "fifo"])
      expect(await collectArtifact({ path: join(dirs.out, name) }, [dirs.out])).toEqual({
        status: "failed",
        reason: "declared path is not a regular file",
      });
    expect(open).not.toHaveBeenCalled();
  });
});
