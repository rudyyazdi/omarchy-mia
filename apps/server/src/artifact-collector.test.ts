import { chmodSync, mkdirSync, mkdtempDisposableSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectArtifact } from "./artifact-collector.ts";

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

  // The target is unreadable, so a collector that read before deciding would fail or throw instead.
  it.skipIf(process.getuid?.() === 0)(
    "never reads a symlink target outside the output directory",
    () => {
      using dirs = workspace();
      const secret = join(dirs.root, "secret.txt");
      writeFileSync(secret, "private");
      chmodSync(secret, 0o000);
      symlinkSync(secret, join(dirs.out, "escape.txt"));
      expect(collectArtifact({ path: join(dirs.out, "escape.txt") }, [dirs.out])).toEqual({
        status: "external_only",
        reason: "declared path resolves outside the configured output directories",
      });
    },
  );

  it("reports a dangling symlink as missing", () => {
    using dirs = workspace();
    symlinkSync(join(dirs.out, "gone.txt"), join(dirs.out, "dangling.txt"));
    expect(collectArtifact({ path: join(dirs.out, "dangling.txt") }, [dirs.out]).status).toBe(
      "missing",
    );
  });

  it("treats an output directory that does not exist as containing nothing", () => {
    using dirs = workspace();
    writeFileSync(join(dirs.out, "a.txt"), "D1");
    const capture = collectArtifact({ path: join(dirs.out, "a.txt") }, [join(dirs.root, "none")]);
    expect(capture.status).toBe("external_only");
  });

  it("fails, rather than throws, on a declared path that cannot be read", () => {
    using dirs = workspace();
    mkdirSync(join(dirs.out, "folder"));
    const capture = collectArtifact({ path: join(dirs.out, "folder") }, [dirs.out]);
    expect(capture).toEqual({
      status: "failed",
      reason: expect.stringMatching(/^declared file unreadable: /),
    });
  });
});
