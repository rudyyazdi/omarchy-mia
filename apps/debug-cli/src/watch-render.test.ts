import { describe, expect, it } from "vitest";
import type { WatchMcpMessage } from "@mia/records";
import {
  conversationView,
  eventView,
  mcpView,
  taskView,
  toolCallView,
  type Capture,
} from "./watch-render.ts";
import { conversationRow, eventRow, executionRow, taskRow, toolCallRow } from "./watch-fixture.ts";

const SECRET = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** A capture whose servers with a body log are `servers`; the fixture's calls go to d1. */
const capture = (debugMode: boolean, servers: string[] = ["d1"]): Capture => ({
  debugMode,
  bodyLogServers: { status: "known", servers: new Set(servers) },
});

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
      capture(false),
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
      capture(false),
    );
    expect(view.summary).toContain("denied");
    expect(view.summary).toContain("✗ Mia denied mcp__d1__forbidden by policy");
  });

  it("marks a fixture call's MCP bodies as not recorded when the conversation was captured with debug mode off", () => {
    const marker = "MCP request and response: not recorded (debug mode off)";
    const dispatched = toolCallRow({ status: "completed", dispatch_event_id: "e5" });
    expect(toolCallView(dispatched, [], capture(false)).body).toContain(marker);
    // Debug mode recorded its bodies, which the page shows as nodes under it.
    expect(toolCallView(dispatched, [], capture(true)).body).not.toContain("not recorded");
  });

  it("marks a real server's call as not recorded whatever the mode, since debug mode never records its bodies", () => {
    const dispatched = toolCallRow({ status: "completed", dispatch_event_id: "e5" });
    for (const debugMode of [false, true]) {
      const { body } = toolCallView(dispatched, [], capture(debugMode, ["fixture"]));
      expect(body).toContain('<p class="not-recorded">MCP request and response: not recorded</p>');
      expect(body).not.toContain("debug mode off");
    }
  });

  it("tells a server from another only by its whole name", () => {
    const call = toolCallRow({ tool_identity: "mcp__d1x__read", dispatch_event_id: "e5" });
    expect(toolCallView(call, [], capture(false)).body).toContain("not recorded</p>");
  });

  it("says why it cannot tell whether a call's bodies were recorded, escaped, when the tool contracts are unreadable", () => {
    const dispatched = toolCallRow({ status: "completed", dispatch_event_id: "e5" });
    const unknown: Capture = {
      debugMode: true,
      bodyLogServers: { status: "unknown", reason: "its <tool_contracts> object is missing" },
    };
    expect(toolCallView(dispatched, [], unknown).body).toContain(
      "not recorded unless shown below (whether its server records bodies is unknown: its &lt;tool_contracts&gt; object is missing)",
    );
  });

  it("marks nothing on a call that never reached an MCP server", () => {
    const denied = toolCallRow({ status: "denied", detail: "Mia denied it by policy" });
    for (const shown of [capture(false), capture(false, [])])
      expect(toolCallView(denied, [], shown).body).not.toContain("not recorded");
  });

  it("shows on the conversation's line whether it was captured in debug mode", () => {
    expect(conversationView(conversationRow(), false).summary).toContain("debug mode off");
    expect(conversationView(conversationRow(), true).summary).toContain("debug mode on");
  });

  it("shows an MCP message's body on its line, redacted and escaped, and the whole event when expanded", () => {
    const body = { method: "tools/call", params: { note: "<b>hi</b>", api_key: SECRET } };
    const message: WatchMcpMessage = {
      type: "mcp_request",
      event: eventRow({ sequence: 7, type: "mcp_request", payload: JSON.stringify({ body }) }),
      content: { status: "recorded", body },
    };
    const view = mcpView(message);
    expect(view.summary).toContain("<b>MCP request</b>");
    expect(view.summary).toContain("&lt;b&gt;hi&lt;/b&gt;");
    expect(view.body).toContain("tools/call");
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(JSON.stringify(view)).not.toContain("<b>hi</b>");
  });

  it("shows why an MCP message holds no body", () => {
    const reason = "the body log has no <response> for this call";
    const view = mcpView({
      type: "mcp_response",
      event: eventRow({ sequence: 8, type: "mcp_response" }),
      content: { status: "unrecorded", reason },
    });
    expect(view.summary).toContain("<b>MCP response</b>");
    expect(view.summary).toContain(
      "not recorded: the body log has no &lt;response&gt; for this call",
    );
  });
});
