import { sha256Hex } from "@mia/protocol";
import { describe, expect, it } from "vitest";
import { decideEligibility, extractDeclaredArtifact, verifyContent } from "./artifact-capture.ts";

const policy = { resolvedOutputDirectories: ["/work/out"] };

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

  it("maps the declared mime_type to camelCase once", () => {
    const declaration = JSON.stringify({ artifact: { path: "/p", mime_type: "text/plain" } });
    expect(extractDeclaredArtifact(declaration)).toEqual({ path: "/p", mimeType: "text/plain" });
  });

  it("ignores content that declares nothing", () => {
    expect(extractDeclaredArtifact("plain output")).toBeNull();
    expect(extractDeclaredArtifact(JSON.stringify({ artifact: { name: "no path" } }))).toBeNull();
    expect(
      extractDeclaredArtifact({ text: JSON.stringify({ artifact: { path: "/x" } }) }),
    ).toBeNull();
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
    expect(
      decideEligibility(
        { exists: true, resolvedPath: "/work/out/sub/a.txt", regularFile: true },
        policy,
      ),
    ).toEqual({
      status: "eligible",
      resolvedPath: "/work/out/sub/a.txt",
    });
  });

  it.each(["/etc/hostname", "/work/out-sibling/a.txt", "/work/out", "/work/a.txt"])(
    "excludes %s as external-only",
    (resolvedPath) => {
      expect(decideEligibility({ exists: true, resolvedPath, regularFile: true }, policy)).toEqual({
        status: "external_only",
        reason: "declared path resolves outside the configured output directories",
      });
    },
  );

  it("admits paths under an output directory of /", () => {
    expect(
      decideEligibility(
        { exists: true, resolvedPath: "/a.txt", regularFile: true },
        { resolvedOutputDirectories: ["/"] },
      ).status,
    ).toBe("eligible");
  });

  it("fails a path inside an output directory that is not a regular file", () => {
    expect(
      decideEligibility(
        { exists: true, resolvedPath: "/work/out/fifo", regularFile: false },
        policy,
      ),
    ).toEqual({ status: "failed", reason: "declared path is not a regular file" });
  });

  it("excludes everything when no output directory exists", () => {
    expect(
      decideEligibility(
        { exists: true, resolvedPath: "/work/out/a.txt", regularFile: true },
        { resolvedOutputDirectories: [] },
      ).status,
    ).toBe("external_only");
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
