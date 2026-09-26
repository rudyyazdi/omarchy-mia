import { describe, expect, it } from "vitest";
import { canonicalDigest, canonicalJson, sha256Hex } from "./canonical.ts";

describe("canonical encoding", () => {
  it("sorts nested keys, omits undefined properties and preserves array order", () => {
    expect(
      canonicalJson({ zebra: undefined, beta: [{ zebra: 2, alpha: 1 }, 0], alpha: true }),
    ).toBe('{"alpha":true,"beta":[{"alpha":1,"zebra":2},0]}');
  });

  it("encodes non-finite numbers and undefined array entries as null", () => {
    expect(canonicalJson({ numbers: [NaN, Infinity, -Infinity, undefined, 1] })).toBe(
      '{"numbers":[null,null,null,null,1]}',
    );
  });

  it("keeps the persisted digest stable across object insertion order", () => {
    const digest = "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777";
    expect(canonicalDigest({ b: 2, a: 1 })).toBe(digest);
    expect(sha256Hex('{"a":1,"b":2}')).toBe(digest);
  });

  it("keeps a __proto__ key parsed from JSON, so it cannot collide with its absence", () => {
    const parsed: unknown = JSON.parse('{"b":1,"__proto__":{"path":"/etc/passwd"}}');
    expect(canonicalJson(parsed)).toBe('{"__proto__":{"path":"/etc/passwd"},"b":1}');
    expect(canonicalDigest(parsed)).not.toBe(canonicalDigest({ b: 1 }));
    expect(canonicalJson(JSON.parse('{"a":{"__proto__":1}}'))).toBe('{"a":{"__proto__":1}}');
  });
});
