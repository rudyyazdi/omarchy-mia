import { existsSync, mkdirSync, mkdtempDisposableSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveExecutable } from "./resolve-executable.ts";

const script = (path: string, mode = 0o755) => writeFileSync(path, "#!/bin/sh\n", { mode });

describe("resolveExecutable", () => {
  it("looks a bare name up in each PATH entry and takes the first executable file", () => {
    using first = mkdtempDisposableSync(join(tmpdir(), "mia-bin-"));
    using second = mkdtempDisposableSync(join(tmpdir(), "mia-bin-"));
    using third = mkdtempDisposableSync(join(tmpdir(), "mia-bin-"));
    script(join(first.path, "runtime"), 0o644);
    mkdirSync(join(second.path, "runtime"));
    script(join(third.path, "runtime"));
    expect(
      resolveExecutable("runtime", {
        path: [first.path, second.path, third.path].join(delimiter),
        cwd: "/",
      }),
    ).toBe(join(third.path, "runtime"));
  });

  it("resolves an absolute path as itself, without consulting PATH", () => {
    using bin = mkdtempDisposableSync(join(tmpdir(), "mia-bin-"));
    const runtime = join(bin.path, "runtime");
    script(runtime);
    expect(resolveExecutable(runtime, { path: undefined, cwd: "/" })).toBe(runtime);
  });

  it("resolves a name containing a slash, and a relative PATH entry, against the working directory", () => {
    using work = mkdtempDisposableSync(join(tmpdir(), "mia-work-"));
    mkdirSync(join(work.path, "bin"));
    script(join(work.path, "bin", "runtime"));
    const expected = join(work.path, "bin", "runtime");
    expect(resolveExecutable("./bin/runtime", { path: undefined, cwd: work.path })).toBe(expected);
    expect(resolveExecutable("runtime", { path: "bin", cwd: work.path })).toBe(expected);
  });

  it("finds nothing for a missing name", () => {
    using empty = mkdtempDisposableSync(join(tmpdir(), "mia-bin-"));
    expect(resolveExecutable("runtime", { path: empty.path, cwd: "/" })).toBeNull();
    expect(resolveExecutable("runtime", { path: undefined, cwd: "/" })).toBeNull();
    expect(
      resolveExecutable(join(empty.path, "runtime"), { path: undefined, cwd: "/" }),
    ).toBeNull();
  });

  it("treats shell syntax in the name as a literal file name and runs nothing", () => {
    using bin = mkdtempDisposableSync(join(tmpdir(), "mia-bin-"));
    const marker = join(bin.path, "ran");
    for (const name of [`$(touch ${marker})`, `\`touch ${marker}\``, "runtime; touch ran"])
      expect(
        resolveExecutable(name, { path: `${bin.path}${delimiter}/bin`, cwd: bin.path }),
      ).toBeNull();
    expect(existsSync(marker)).toBe(false);
    const literal = "$(runtime)";
    script(join(bin.path, literal));
    expect(resolveExecutable(literal, { path: bin.path, cwd: "/" })).toBe(join(bin.path, literal));
  });
});
