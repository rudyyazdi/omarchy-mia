import { describe, expect, it } from "vitest";
import { renderReport } from "./report.ts";
import { snapshotFixture } from "./snapshot-fixture.ts";

describe("report HTML safety", () => {
  it("escapes every free-text cell, nested JSON value and text outside tables", () => {
    const labels = new Set<string>();
    const hostile = (label: string) => {
      labels.add(label);
      return `<&"'>${label}`;
    };
    const snapshot = snapshotFixture(hostile);
    const report = renderReport(snapshot, {
      objectStatus: { [hostile("object-digest")]: "corrupt" },
    });
    // All row families are populated, so bypassing escaping in any of their cells leaks the marker.
    expect(report).not.toContain("<&");
    for (const label of labels) {
      // JSON display escapes the quote once before HTML encoding it.
      const plain = `&lt;&amp;&quot;&#39;&gt;${label}`;
      const json = `&lt;&amp;\\&quot;&#39;&gt;${label}`;
      expect(report.includes(plain) || report.includes(json), `missing escaped ${label}`).toBe(
        true,
      );
    }
  });

  it("sends a Content-Security-Policy", () => {
    expect(renderReport(snapshotFixture(() => "text"))).toContain("Content-Security-Policy");
  });
});
