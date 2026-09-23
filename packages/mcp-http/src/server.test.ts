import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpServer, startMcpHttpServer, type McpHttpServerHandle } from "./server.ts";

let dir: string;
let handle: McpHttpServerHandle | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mia-mcp-http-"));
});
afterEach(async () => {
  await handle?.close();
  handle = undefined;
  await rm(dir, { recursive: true, force: true });
});

const initialize = (url: string) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcp-http-test", version: "0" },
      },
    }),
  });

describe("MCP HTTP server", () => {
  it("keeps serving when its request log cannot be written", async () => {
    // A directory cannot be appended to, so every log write fails with EISDIR.
    handle = await startMcpHttpServer({
      logFile: dir,
      createServer: () => new McpServer({ name: "mcp-http-test", version: "0" }),
    });

    const initialized = await initialize(handle.url);
    expect(initialized.status).toBe(200);
    expect(await initialized.text()).toContain('"serverInfo"');

    const refused = await fetch(handle.url);
    expect(refused.status).toBe(405);
    await refused.body?.cancel();
  });
});
