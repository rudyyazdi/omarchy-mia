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
      objectStatus: { [hostile("object-digest")]: hostile("object-status") },
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

  it("renders supplied markup as text instead of creating executable elements", () => {
    const payload = '<script>alert("unsafe")</script><img src=x onerror=alert(1)>';
    const report = renderReport(snapshotFixture(() => payload));
    expect(report).not.toMatch(/<(?:script|img)\b/i);
    expect(report).toContain("&lt;script&gt;alert(&quot;unsafe&quot;)&lt;/script&gt;");
    expect(report).toContain("Content-Security-Policy");
  });
});
