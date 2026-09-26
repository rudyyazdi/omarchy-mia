import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { startWatch, type Watch, type WatchMessage, type WatchTimers } from "@mia/debug-cli";
import {
  Catalog,
  ObjectStore,
  RecordWriter,
  newId,
  snapshotConversation,
  watchEntriesAfter,
} from "@mia/records";
import type { MiaClient } from "@mia/text-client";
import {
  ackResult,
  must,
  mustString,
  startTestServer,
  useScriptedSession,
  type TestServer,
} from "./harness.ts";
import { ScriptedRuntime } from "./scripted-runtime.ts";

/** When the rows these tests write say they were recorded. */
const AT = "2026-01-01T00:00:00.000Z";

let runtime: ScriptedRuntime;
let ts: TestServer;
let client: MiaClient;
useScriptedSession((session) => {
  ({ runtime, server: ts, client } = session);
});

const ViewSchema = z.object({ summary: z.string(), body: z.string() });
const WatchMessageSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("conversation"), view: ViewSchema }),
  z.object({
    op: z.literal("node"),
    id: z.string(),
    parent: z.string(),
    kind: z.enum(["task", "tool_call", "mcp"]),
    view: ViewSchema,
  }),
  z.object({ op: z.literal("event"), parent: z.string(), view: ViewSchema }),
  z.object({ op: z.literal("stopped"), message: z.string() }),
]) satisfies z.ZodType<WatchMessage>;

/**
 * A timer the test fires by hand: `fire` waits until the watch waits on it, then ends that wait. A wait that
 * aborts leaves, so a fire never lands on a stream that is gone. One test caller at a time: `waiting` and
 * `fire` share one arrival, and with several waits `fire` ends the oldest.
 */
const manualTimer = () => {
  const waits = new Set<PromiseWithResolvers<undefined>>();
  let arrived = Promise.withResolvers<undefined>();
  const waiting = async (): Promise<void> => {
    while (waits.size === 0) {
      arrived = Promise.withResolvers<undefined>();
      await arrived.promise;
    }
  };
  return {
    wait: (signal: AbortSignal): Promise<unknown> => {
      const wait = Promise.withResolvers<undefined>();
      if (signal.aborted) wait.reject(signal.reason);
      else {
        signal.addEventListener(
          "abort",
          () => {
            waits.delete(wait);
            wait.reject(signal.reason);
          },
          { once: true },
        );
        waits.add(wait);
        arrived.resolve(undefined);
      }
      return wait.promise;
    },
    /** Resolves once something waits on the timer. */
    waiting,
    /** How many waits are pending. */
    pending: () => waits.size,
    fire: async (): Promise<void> => {
      await waiting();
      const [wait] = waits;
      if (!wait) throw new Error("nothing waits on the timer");
      waits.delete(wait);
      wait.resolve(undefined);
    },
  };
};

type NodeMessage = Extract<WatchMessage, { op: "node" }>;

/** A page's event stream, read as the browser's EventSource would, one record at a time. */
interface Page {
  next(): Promise<WatchMessage>;
  /** Reads until a message `matches`, and returns it. */
  until(matches: (message: WatchMessage) => boolean): Promise<WatchMessage>;
  /** Reads until a node message `matches`, and returns it. */
  untilNode(matches: (node: NodeMessage) => boolean): Promise<NodeMessage>;
  /** Reads `count` messages. */
  take(count: number): Promise<WatchMessage[]>;
  close(): void;
}

const pages: Page[] = [];
const openPage = async (url: string): Promise<Page> => {
  const closed = new AbortController();
  const response = await fetch(new URL("events", url), { signal: closed.signal });
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const reader = must(response.body, "event stream")
    .pipeThrough(new TextDecoderStream())
    .getReader();
  let buffered = "";
  const next = async (): Promise<WatchMessage> => {
    let end = buffered.indexOf("\n\n");
    while (end < 0) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("the event stream ended");
      buffered += chunk.value;
      end = buffered.indexOf("\n\n");
    }
    const record = buffered.slice(0, end);
    buffered = buffered.slice(end + 2);
    const data = must(/^data: (.*)$/.exec(record)?.[1], "a data line");
    return WatchMessageSchema.parse(JSON.parse(data));
  };
  const until = async (matches: (message: WatchMessage) => boolean) => {
    let message = await next();
    while (!matches(message)) message = await next();
    return message;
  };
  const page: Page = {
    next,
    until,
    untilNode: async (matches) => {
      const message = await until((candidate) => candidate.op === "node" && matches(candidate));
      if (message.op !== "node") throw new Error("expected a node message");
      return message;
    },
    take: async (count) => {
      const messages: WatchMessage[] = [];
      while (messages.length < count) messages.push(await next());
      return messages;
    },
    close: () => closed.abort(),
  };
  pages.push(page);
  return page;
};

/**
 * Every message a page is sent on connecting: the conversation's header, then one per entry. It reads its own
 * snapshot, so it holds only while the conversation is idle between the watch's first poll and this read.
 */
const initialCount = (catalog: Catalog, conversationId: string): number =>
  1 + watchEntriesAfter(snapshotConversation(catalog, conversationId).tables, -1).length;

interface Watching {
  watch: Watch;
  catalog: Catalog;
  poll: ReturnType<typeof manualTimer>;
  grace: ReturnType<typeof manualTimer>;
  drain: ReturnType<typeof manualTimer>;
  interrupt: AbortController;
}

let watching: Watching | null = null;
const watchConversation = async (
  conversationId: string,
  catalog: Catalog = ts.catalog(),
): Promise<Watching> => {
  const poll = manualTimer();
  const grace = manualTimer();
  const drain = manualTimer();
  const interrupt = new AbortController();
  const timers: WatchTimers = {
    nextPoll: poll.wait,
    reconnectGrace: grace.wait,
    stopDrain: drain.wait,
  };
  try {
    const started = await startWatch({
      catalog,
      conversationId,
      signal: interrupt.signal,
      timers,
    });
    if (started.kind !== "watching") throw new Error(`could not watch ${conversationId}`);
    watching = { watch: started.watch, catalog, poll, grace, drain, interrupt };
    return watching;
  } catch (error) {
    catalog.close();
    throw error;
  }
};

afterEach(async () => {
  for (const page of pages.splice(0)) page.close();
  if (!watching) return;
  const { watch, catalog, interrupt, drain } = watching;
  watching = null;
  interrupt.abort();
  try {
    // A test that failed may leave a page that never reads; the drain wait ends its stream.
    await Promise.race([watch.ended, drain.fire()]);
    await watch.ended;
  } finally {
    catalog.close();
  }
});

const conversationId = () => must(client.conversationId, "conversation id");

/** Watches the session's conversation with one page open that has read everything sent on connecting. */
const watchWithPage = async (): Promise<Watching & { page: Page }> => {
  const watched = await watchConversation(conversationId());
  const page = await openPage(watched.watch.url);
  await page.take(initialCount(watched.catalog, conversationId()));
  return { ...watched, page };
};

/** The status a node message's line shows first: the node's own, before any approval's. */
const statusOf = (message: NodeMessage): string | undefined =>
  /class="status status-([a-z_]+)"/.exec(message.view.summary)?.[1];

/** A request with headers the test chooses (Host, Origin, Sec-Fetch-Site), which fetch does not allow. */
const get = (url: string, headers: Record<string, string>) => {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const target = new URL(url);
  const sent = request(
    { hostname: target.hostname, port: target.port, path: "/events", headers },
    (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    },
  );
  sent.once("error", reject);
  sent.end();
  return promise;
};

/**
 * What a page is sent on connecting to a finished conversation of a server started with `debugMode`: one task whose
 * allowed read call runs. With `bodyLog`, the d1 server names that log, as the controlled MCP fixture does, and
 * `beforeResult` writes it as the fixture would, before the call's result arrives. `beforeWatch` runs on the
 * server's state directory before the watch starts.
 */
const watchedFinished = async (options: {
  debugMode: boolean;
  body?: { bodyLog: string; beforeResult: () => void };
  beforeWatch?: (catalog: Catalog, conversationId: string) => void;
}): Promise<WatchMessage[]> => {
  const { debugMode, body } = options;
  const finishedRuntime = new ScriptedRuntime();
  const finishedServer = await startTestServer(
    finishedRuntime,
    body
      ? {
          mcpServers: {
            d1: { type: "http", url: "http://127.0.0.1:1/mcp", bodyLog: body.bodyLog },
          },
        }
      : {},
    { debugMode },
  );
  // After every afterEach hook, so after the watch's teardown has closed its catalog.
  onTestFinished(() => finishedServer.close());
  const finishedClient = await finishedServer.connect("client-A");
  await finishedClient.startConversation();
  const next = finishedRuntime.nextTurn();
  await finishedClient.submitText("read it");
  const turn = await next;
  turn.init();
  expect((await turn.request("mcp__d1__read", {}, "toolu_read")).behavior).toBe("allow");
  body?.beforeResult();
  await turn.toolResult("toolu_read", JSON.stringify({ unread: 3 }));
  turn.end();
  await finishedClient.waitFor("task_finished");

  const finishedId = must(finishedClient.conversationId, "conversation id");
  const catalog = finishedServer.catalog();
  options.beforeWatch?.(catalog, finishedId);
  const { watch } = await watchConversation(finishedId, catalog);
  const page = await openPage(watch.url);
  return page.take(initialCount(catalog, finishedId));
};

/** A body log path in a fresh directory the test removes. */
const bodyLogPath = (): string => {
  const logDirectory = mkdtempSync(join(tmpdir(), "mia-watch-body-log-"));
  onTestFinished(() => rmSync(logDirectory, { recursive: true, force: true }));
  return join(logDirectory, "mcp-bodies.jsonl");
};

/** Writes the body log as the fixture does for the call `toolu_read`: one line per message, in order. */
const writeBodyLog = (bodyLog: string, messages: { direction: string; body: unknown }[]) =>
  writeFileSync(
    bodyLog,
    messages
      .map((message) => `${JSON.stringify({ tool_use_id: "toolu_read", ...message })}\n`)
      .join(""),
  );

/** A body log whose `beforeResult` writes only the call's request. */
const requestOnlyBodyLog = (request: unknown) => {
  const bodyLog = bodyLogPath();
  return {
    bodyLog,
    beforeResult: () => writeBodyLog(bodyLog, [{ direction: "request", body: request }]),
  };
};

const toolCallNode = (messages: WatchMessage[]): NodeMessage =>
  must(
    messages.find(
      (message): message is NodeMessage => message.op === "node" && message.kind === "tool_call",
    ),
    "the tool call's node",
  );

describe("mia debug watch", () => {
  // The token is also redacted before it is stored, so the view's own redaction is covered by watch-render.test.ts.
  it("shows a finished conversation's whole tree, each node under its parent, without the token", async () => {
    const next = runtime.nextTurn();
    const taskId = mustString(ackResult(await client.submitText("change it")).task_id, "task id");
    const turn = await next;
    turn.init();
    const decided = turn.request(
      "mcp__d1__change",
      { delta: 1, token: "super-secret-value-123456" },
      "toolu_1",
    );
    const requested = await client.waitFor("approval_requested");
    await client.decide({ taskId, approvalId: requested.payload.approval_id, decision: "approve" });
    await decided;
    await turn.toolResult("toolu_1", JSON.stringify({ counter: 1 }));
    turn.end();
    await client.waitFor("task_finished");

    const { watch, catalog } = await watchConversation(conversationId());
    const page = await openPage(watch.url);
    const messages = await page.take(initialCount(catalog, conversationId()));
    const ids = new Set(["conversation"]);
    for (const message of messages) {
      if (message.op === "node" || message.op === "event") expect(ids).toContain(message.parent);
      if (message.op === "node") ids.add(message.id);
    }
    const nodes = messages.filter((message): message is NodeMessage => message.op === "node");
    expect(nodes.map((node) => node.kind)).toEqual(["task", "tool_call"]);
    expect(nodes[0]?.view.summary).toContain("change it");
    expect(nodes.map(statusOf)).toEqual(["completed", "completed"]);
    expect(
      messages.filter((message) => message.op === "event" && message.parent === nodes[1]?.id)
        .length,
    ).toBeGreaterThan(0);
    expect(JSON.stringify(messages)).not.toContain("super-secret-value");
    // The session's d1 server writes no body log, as a real MCP server does not, so its bodies are marked as not
    // recorded, and not as something debug mode would add.
    expect(messages[0]).toMatchObject({
      op: "conversation",
      view: { summary: expect.stringContaining("debug mode off") },
    });
    expect(nodes[1]?.view.body).toContain("MCP request and response: not recorded</p>");
    expect(nodes[1]?.view.body).not.toContain("(debug mode off)");
  });

  it("marks a call to the fixture as not recorded because debug mode was off", async () => {
    const messages = await watchedFinished({
      debugMode: false,
      body: requestOnlyBodyLog({ jsonrpc: "2.0", id: 3, method: "tools/call" }),
    });
    expect(toolCallNode(messages).view.body).toContain(
      "MCP request and response: not recorded (debug mode off)",
    );
  });

  it("says a call's server is unknown when the conversation's tool contracts cannot be read", async () => {
    const messages = await watchedFinished({
      debugMode: false,
      beforeWatch: (catalog, id) => {
        const { digest } = must(
          catalog.get<{ digest: string }>(
            `SELECT a.object_digest AS digest FROM conversations c
              JOIN provenance_entries p ON p.provenance_set_id = c.provenance_set_id AND p.role = 'tool_contracts'
              JOIN artifacts a ON a.id = p.artifact_id WHERE c.id = ?`,
            id,
          ),
          "the tool contracts' object",
        );
        rmSync(new ObjectStore(catalog.paths).pathFor(digest));
      },
    });
    expect(toolCallNode(messages).view.body).toContain(
      "MCP request and response: not recorded (debug mode off, and whether its server records bodies is unknown: its tool_contracts object is missing)",
    );
  });

  it("shows the MCP request and response debug mode recorded for a call as nodes under it, redacted", async () => {
    // As the fixture writes it: the request only, so the response is recorded as missing, with why.
    const request = {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "read", arguments: { token: "super-secret-value-123456" } },
    };
    const messages = await watchedFinished({ debugMode: true, body: requestOnlyBodyLog(request) });
    expect(messages[0]).toMatchObject({
      op: "conversation",
      view: { summary: expect.stringContaining("debug mode on") },
    });
    const nodes = messages.filter((message): message is NodeMessage => message.op === "node");
    expect(nodes.map((node) => node.kind)).toEqual(["task", "tool_call", "mcp", "mcp"]);
    const [, call, sentRequest, response] = nodes;
    expect([sentRequest?.parent, response?.parent]).toEqual([call?.id, call?.id]);
    expect(sentRequest?.view.summary).toContain("MCP request");
    expect(sentRequest?.view.summary).toContain("tools/call");
    expect(response?.view.summary).toContain(
      'MCP response</b> <span class="not-recorded">not recorded: the body log has no response for this call',
    );
    // Nodes, not raw events: the call's raw events hold none of them.
    expect(
      messages.filter(
        (message) =>
          message.op === "event" &&
          message.parent === call?.id &&
          /mcp_(request|response)/.test(message.view.summary),
      ),
    ).toEqual([]);
    expect(JSON.stringify(messages)).not.toContain("super-secret-value");
  });

  it("appends a fixture call's MCP request and response under it without a reload, in debug mode", async () => {
    const bodyLog = bodyLogPath();
    const liveRuntime = new ScriptedRuntime();
    const liveServer = await startTestServer(
      liveRuntime,
      { mcpServers: { d1: { type: "http", url: "http://127.0.0.1:1/mcp", bodyLog } } },
      { debugMode: true },
    );
    // After every afterEach hook, so after the watch's teardown has closed its catalog.
    onTestFinished(() => liveServer.close());
    const liveClient = await liveServer.connect("client-A");
    await liveClient.startConversation();
    const liveId = must(liveClient.conversationId, "conversation id");
    const catalog = liveServer.catalog();
    const { watch, poll } = await watchConversation(liveId, catalog);
    const page = await openPage(watch.url);
    await page.take(initialCount(catalog, liveId));

    const next = liveRuntime.nextTurn();
    await liveClient.submitText("read it");
    const turn = await next;
    turn.init();
    expect((await turn.request("mcp__d1__read", {}, "toolu_read")).behavior).toBe("allow");
    writeBodyLog(bodyLog, [
      { direction: "request", body: { jsonrpc: "2.0", id: 3, method: "tools/call" } },
      { direction: "response", body: { jsonrpc: "2.0", id: 3, result: { unread: 3 } } },
    ]);
    await turn.toolResult("toolu_read", JSON.stringify({ unread: 3 }));
    await poll.fire();
    const call = await page.untilNode((node) => node.kind === "tool_call");
    const request = await page.untilNode((node) => node.kind === "mcp");
    const response = await page.untilNode((node) => node.kind === "mcp");
    expect([request.parent, response.parent]).toEqual([call.id, call.id]);
    expect(request.view.summary).toContain("MCP request");
    expect(response.view.summary).toContain("MCP response");
    expect(response.view.summary).toContain("unread");
    turn.end();
    await liveClient.waitFor("task_finished");
  });

  it("appends a new command, a tool call, its result and an auto-rejection without a reload, and re-sends a status that changed", async () => {
    const { page, poll } = await watchWithPage();
    const next = runtime.nextTurn();
    const taskId = mustString(
      ackResult(await client.submitText("summarise my inbox")).task_id,
      "task id",
    );
    const turn = await next;
    await poll.fire();
    const task = await page.untilNode((node) => node.id === `task:${taskId}`);
    expect(task.view.summary).toContain("summarise my inbox");
    expect(statusOf(task)).toBe("running");

    // An allowed call runs, and its result lands under it.
    expect((await turn.request("mcp__d1__read", {}, "toolu_read")).behavior).toBe("allow");
    await turn.toolResult("toolu_read", JSON.stringify({ unread: 3 }));
    await poll.fire();
    const read = await page.untilNode((node) => node.view.summary.includes("mcp__d1__read"));
    await page.until(
      (message) =>
        message.op === "event" &&
        message.parent === read.id &&
        message.view.summary.includes("tool_result"),
    );

    // A call the stream proposes shows as proposed; the policy then denies it with no event of its own for the
    // row, so only the re-sent header can show the rejection.
    await turn.emit({
      type: "tool_proposed",
      runtimeCallId: "toolu_forbidden",
      toolIdentity: "mcp__d1__forbidden",
      arguments: {},
      complete: true,
      at: new Date().toISOString(),
    });
    await poll.fire();
    const proposed = await page.untilNode((node) =>
      node.view.summary.includes("mcp__d1__forbidden"),
    );
    expect(statusOf(proposed)).toBe("proposed");
    expect((await turn.request("mcp__d1__forbidden", {}, "toolu_forbidden")).behavior).toBe("deny");
    await poll.fire();
    const denied = await page.untilNode((node) => node.id === proposed.id);
    expect(statusOf(denied)).toBe("denied");

    turn.end();
    await client.waitFor("task_finished");
    await poll.fire();
    expect(statusOf(await page.untilNode((node) => node.id === task.id))).toBe("completed");
  });

  it("sends nothing again on a poll that finds nothing new", async () => {
    const { page, poll } = await watchWithPage();
    await poll.fire();
    await poll.waiting();
    const next = runtime.nextTurn();
    await client.submitText("after an empty poll");
    await next;
    await poll.fire();
    const message = await page.next();
    expect(message).toMatchObject({ op: "node", kind: "task" });
  });

  /** Starts a watch of `id` whose signal has already aborted, as a Ctrl-C before it listens. */
  const startStopped = async (id: string) => {
    const catalog = ts.catalog();
    try {
      return await startWatch({
        catalog,
        conversationId: id,
        signal: AbortSignal.abort(),
        timers: {
          nextPoll: manualTimer().wait,
          reconnectGrace: manualTimer().wait,
          stopDrain: manualTimer().wait,
        },
      });
    } finally {
      catalog.close();
    }
  };

  it("refuses an unknown conversation, and serves nothing when stopped before it listens", async () => {
    expect(await startStopped("conv_unknown")).toEqual({ kind: "unknown_conversation" });
    expect(await startStopped(conversationId())).toEqual({ kind: "interrupted" });
  });

  it("tells the page and closes the server on Ctrl-C", async () => {
    const { watch, page, interrupt } = await watchWithPage();
    interrupt.abort();
    expect(await page.next()).toEqual({ op: "stopped", message: "the watch was stopped" });
    expect(await watch.ended).toEqual({ kind: "interrupted" });
    await expect(fetch(watch.url)).rejects.toThrow();
  });

  it("stops once the page closes and does not come back", async () => {
    const { watch, grace } = await watchConversation(conversationId());
    const page = await openPage(watch.url);
    await page.next();
    page.close();
    await grace.fire();
    expect(await watch.ended).toEqual({ kind: "page_closed" });
  });

  it("keeps watching when the page reloads, replaying the whole tree to the new page", async () => {
    const { watch, grace, interrupt } = await watchConversation(conversationId());
    const first = await openPage(watch.url);
    await first.next();
    first.close();
    await grace.waiting();
    const reloaded = await openPage(watch.url);
    expect(grace.pending()).toBe(0);
    expect((await reloaded.next()).op).toBe("conversation");
    interrupt.abort();
    expect(await watch.ended).toEqual({ kind: "interrupted" });
  });

  it("serves the page only under its own loopback address", async () => {
    const { watch } = await watchConversation(conversationId());
    const page = await fetch(watch.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await page.text()).toContain('<script type="module" src="watch.js">');
    expect((await fetch(new URL("missing", watch.url))).status).toBe(404);
    const host = new URL(watch.url).host;
    expect(await get(watch.url, { host: "rebound.example" })).toBe(403);
    expect(await get(watch.url, { host, "sec-fetch-site": "cross-site" })).toBe(403);
    expect(await get(watch.url, { host, origin: "http://elsewhere.example" })).toBe(403);
  });

  it("refuses a page beyond its limit", async () => {
    const { watch } = await watchConversation(conversationId());
    for (let open = 0; open < 4; open += 1) await (await openPage(watch.url)).next();
    const refused = await fetch(new URL("events", watch.url));
    expect(refused.status).toBe(503);
    await refused.body?.cancel();
  });

  it("tells the page and stops when the catalog can no longer be read", async () => {
    const { watch, page, poll, catalog } = await watchWithPage();
    catalog.close();
    await poll.fire();
    expect(await page.next()).toEqual({
      op: "stopped",
      message: "the watch stopped after an error",
    });
    expect(await watch.ended).toMatchObject({ kind: "failed" });
  });

  it("stops on Ctrl-C even when a page stopped reading", async () => {
    // Enough history that the page's stream stalls at a full socket before it is all sent.
    const dir = mkdtempSync(join(tmpdir(), "mia-watch-"));
    try {
      const writable = Catalog.openSync(dir);
      const stalled = writable.transaction(() => {
        const writer = new RecordWriter(writable);
        const provenanceSetId = newId("prov");
        writer.createProvenanceSet({
          id: provenanceSetId,
          createdAt: AT,
          description: "watch backpressure",
        });
        const id = newId("conv");
        writer.createConversation({
          id,
          startedAt: AT,
          provenanceSetId,
          runtimeConversationId: "rt",
        });
        for (let index = 0; index < 200; index += 1)
          writer.appendEvent({
            id: newId("evt"),
            receivedAt: AT,
            conversationId: id,
            type: "text_delta",
            payload: { text: "x".repeat(64 * 1024) },
          });
        return id;
      });
      writable.close();
      const { watch, drain, interrupt } = await watchConversation(
        stalled,
        Catalog.openSync(dir, { readonly: true }),
      );
      const unread = new AbortController();
      const response = await fetch(new URL("events", watch.url), { signal: unread.signal });
      expect(response.status).toBe(200);
      interrupt.abort();
      await drain.fire();
      expect(await watch.ended).toEqual({ kind: "interrupted" });
      unread.abort();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
