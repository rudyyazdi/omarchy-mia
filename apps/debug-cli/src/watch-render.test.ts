import { describe, expect, it } from "vitest";
import { conversationView, eventView, taskView, toolCallView } from "./watch-render.ts";
import { conversationRow, eventRow, executionRow, taskRow, toolCallRow } from "./watch-fixture.ts";

const SECRET = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

describe("watch views", () => {
  it("escapes markup from the catalog, so recorded text never becomes page structure", () => {
    const view = taskView(taskRow({ text: '<script>alert("x")</script>' }), []);
    expect(view.summary).not.toContain("<script>");
    expect(view.summary).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(view.body).not.toContain("<script>");
  });

  it("redacts secret-shaped text and sensitive keys in every column it shows", () => {
    const task = taskView(taskRow({ text: `use ${SECRET}` }), [
      executionRow({ effort_evidence: JSON.stringify({ api_key: "k-1234567890" }) }),
    ]);
    const call = toolCallView(
      toolCallRow({ redacted_arguments: JSON.stringify({ token: "super-secret-value-123456" }) }),
      [],
      false,
    );
    const event = eventView(eventRow({ sequence: 1, payload: `{"password": "hunter2hunter2` }));
    const shown = JSON.stringify([task, call, event]);
    for (const secret of [SECRET, "k-1234567890", "super-secret-value", "hunter2"])
      expect(shown).not.toContain(secret);
    expect(shown).toContain("[REDACTED]");
  });

  it("clips a long line only after redacting it, so a cut never exposes part of a secret", () => {
    const view = taskView(taskRow({ text: `${"x".repeat(75)}${SECRET}` }), []);
    expect(view.summary).not.toContain("sk-ant");
    expect(view.summary).toContain("…");
  });

  it("keeps token counts readable", () => {
    const view = taskView(taskRow(), [executionRow({ usage: '{"input_tokens":1200}' })]);
    expect(view.body).toContain("1200");
  });

  it("marks a call that did not run, with the engine's reason, on its collapsed line", () => {
    const view = toolCallView(
      toolCallRow({ status: "denied", detail: "Mia denied mcp__d1__forbidden by policy" }),
      [],
      false,
    );
    expect(view.summary).toContain("denied");
    expect(view.summary).toContain("✗ Mia denied mcp__d1__forbidden by policy");
  });

  it("marks a dispatched call's MCP bodies as not recorded when the conversation was captured with debug mode off", () => {
    const marker = "not recorded (debug mode off)";
    const dispatched = toolCallRow({ status: "completed", dispatch_event_id: "e5" });
    expect(toolCallView(dispatched, [], false).body).toContain(marker);
    expect(toolCallView(dispatched, [], true).body).not.toContain(marker);
  });

  it("marks nothing on a call that never reached an MCP server", () => {
    const denied = toolCallRow({ status: "denied", detail: "Mia denied it by policy" });
    expect(toolCallView(denied, [], false).body).not.toContain("not recorded");
  });

  it("shows on the conversation's line whether it was captured in debug mode", () => {
    expect(conversationView(conversationRow(), false).summary).toContain("debug mode off");
    expect(conversationView(conversationRow(), true).summary).toContain("debug mode on");
  });
});
