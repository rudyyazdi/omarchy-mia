import { sha256Hex } from "@mia/protocol";
import { describe, expect, it } from "vitest";
import {
  checkDeclaredPath,
  decideEligibility,
  extractDeclaredArtifact,
  verifyContent,
  type PathFacts,
} from "./artifact-capture.ts";

const fileAt = (resolvedPath: string, byteSize = 2): PathFacts => ({
  exists: true,
  resolvedPath,
  regularFile: true,
  byteSize,
});

const policy = { resolvedOutputDirectories: ["/work/out"], maxBytes: 10 };

describe("extractDeclaredArtifact", () => {
  it("finds a declaration in a bare string or in any text block", () => {
    const declaration = JSON.stringify({ artifact: { path: "/work/out/a.txt" } });
    expect(extractDeclaredArtifact(declaration)).toEqual({ path: "/work/out/a.txt" });
    expect(
      extractDeclaredArtifact([
        { type: "text", text: "not json" },
        { type: "text", text: declaration },
      ]),
    ).toEqual({ path: "/work/out/a.txt" });
  });

  it("ignores content that declares nothing", () => {
    expect(extractDeclaredArtifact("plain output")).toBeNull();
    expect(extractDeclaredArtifact(JSON.stringify({ artifact: { name: "no path" } }))).toBeNull();
    expect(
      extractDeclaredArtifact({ text: JSON.stringify({ artifact: { path: "/x" } }) }),
    ).toBeNull();
  });
});

describe("checkDeclaredPath", () => {
  it("accepts an absolute path and refuses a relative or empty one", () => {
    expect(checkDeclaredPath({ path: "/work/out/a.txt" })).toBeNull();
    for (const path of ["../a.txt", ""])
      expect(checkDeclaredPath({ path })).toEqual({
        status: "failed",
        reason: "declared path must be absolute",
      });
  });
});

describe("decideEligibility", () => {
  it("reports a path that does not exist as missing", () => {
    expect(decideEligibility({ exists: false }, policy)).toEqual({
      status: "missing",
      reason: "declared file not found at collection time",
    });
  });

  it("admits a resolved path inside an output directory", () => {
    expect(decideEligibility(fileAt("/work/out/sub/a.txt"), policy)).toEqual({
      status: "eligible",
      resolvedPath: "/work/out/sub/a.txt",
      byteSize: 2,
    });
  });

  it.each(["/work/out-sibling/a.txt", "/work/out"])(
    "excludes %s as external-only",
    (resolvedPath) => {
      expect(decideEligibility(fileAt(resolvedPath), policy)).toEqual({
        status: "external_only",
        reason: "declared path resolves outside the configured output directories",
      });
    },
  );

  it("admits paths under an output directory of /", () => {
    expect(
      decideEligibility(fileAt("/a.txt"), { resolvedOutputDirectories: ["/"], maxBytes: 10 })
        .status,
    ).toBe("eligible");
  });

  it("fails a path inside an output directory that is not a regular file", () => {
    expect(
      decideEligibility(
        { exists: true, resolvedPath: "/work/out/fifo", regularFile: false, byteSize: 0 },
        policy,
      ),
    ).toEqual({ status: "failed", reason: "declared path is not a regular file" });
  });

  it("admits a file at the size limit and fails one above it", () => {
    expect(decideEligibility(fileAt("/work/out/a.bin", 10), policy).status).toBe("eligible");
    expect(decideEligibility(fileAt("/work/out/a.bin", 11), policy)).toEqual({
      status: "failed",
      reason: "declared file is 11 bytes, over the 10-byte limit",
    });
  });
});

describe("verifyContent", () => {
  const bytes = Buffer.from("D1");

  it("retains bytes without a declared digest, with an empty one, or with a matching one", () => {
    expect(verifyContent(bytes, { path: "/work/out/a.txt" })).toEqual({
      status: "retained",
      bytes,
    });
    expect(verifyContent(bytes, { path: "/work/out/a.txt", sha256: "" }).status).toBe("retained");
    expect(verifyContent(bytes, { path: "/work/out/a.txt", sha256: sha256Hex(bytes) })).toEqual({
      status: "retained",
      bytes,
    });
  });

  it("fails a capture whose declared digest does not match", () => {
    expect(verifyContent(bytes, { path: "/work/out/a.txt", sha256: "abc" })).toEqual({
      status: "failed",
      reason: `declared sha256 abc does not match file ${sha256Hex(bytes)}`,
    });
  });
});
