import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempDisposableSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectArtifact } from "./artifact-collector.ts";

vi.mock("node:fs", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs")>();
  return {
    ...filesystem,
    readFileSync: vi.fn(filesystem.readFileSync),
    realpathSync: vi.fn(filesystem.realpathSync),
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
  it("retains a file reached through a symlink that resolves inside the output directory", () => {
    using dirs = workspace();
    writeFileSync(join(dirs.out, "real.txt"), "D1");
    symlinkSync(join(dirs.out, "real.txt"), join(dirs.out, "link.txt"));
    expect(collectArtifact({ path: join(dirs.out, "link.txt") }, [dirs.out])).toEqual({
      status: "retained",
      bytes: Buffer.from("D1"),
    });
  });

  it("resolves a symlinked output directory before checking containment", () => {
    using dirs = workspace();
    writeFileSync(join(dirs.out, "a.txt"), "D1");
    const alias = join(dirs.root, "alias");
    symlinkSync(dirs.out, alias);
    expect(collectArtifact({ path: join(dirs.out, "a.txt") }, [alias]).status).toBe("retained");
  });

  it("never reads a file outside the output directory, directly or through a symlink", () => {
    using dirs = workspace();
    const secret = join(dirs.root, "secret.txt");
    writeFileSync(secret, "private");
    symlinkSync(secret, join(dirs.out, "escape.txt"));
    for (const path of [secret, join(dirs.out, "escape.txt")])
      expect(collectArtifact({ path }, [dirs.out]).status).toBe("external_only");
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("refuses a relative path without touching the filesystem", () => {
    using dirs = workspace();
    expect(collectArtifact({ path: "out/a.txt" }, [dirs.out])).toEqual({
      status: "failed",
      reason: "declared path must be absolute",
    });
    expect(realpathSync).not.toHaveBeenCalled();
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("reports a dangling symlink as missing without reading", () => {
    using dirs = workspace();
    symlinkSync(join(dirs.out, "gone.txt"), join(dirs.out, "dangling.txt"));
    expect(collectArtifact({ path: join(dirs.out, "dangling.txt") }, [dirs.out]).status).toBe(
      "missing",
    );
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("treats an output directory that does not exist as containing nothing", () => {
    using dirs = workspace();
    writeFileSync(join(dirs.out, "a.txt"), "D1");
    const capture = collectArtifact({ path: join(dirs.out, "a.txt") }, [join(dirs.root, "none")]);
    expect(capture.status).toBe("external_only");
  });

  // Opening a FIFO blocks until a writer appears, so reading one would hang the server.
  it("fails a directory or FIFO inside the output directory without reading it", () => {
    using dirs = workspace();
    mkdirSync(join(dirs.out, "folder"));
    execFileSync("mkfifo", [join(dirs.out, "fifo")]);
    for (const name of ["folder", "fifo"])
      expect(collectArtifact({ path: join(dirs.out, name) }, [dirs.out])).toEqual({
        status: "failed",
        reason: "declared path is not a regular file",
      });
    expect(readFileSync).not.toHaveBeenCalled();
  });
});
