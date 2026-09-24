import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout } from "node:timers/promises";
import { match } from "ts-pattern";
import { findConversation, snapshotConversation, type Catalog } from "@mia/records";
import { messagesAfter, NOTHING_SENT, sseRecord, type Sent } from "./watch-feed.ts";

/**
 * The live web view of one conversation (issue #6): a loopback HTTP server that serves a static page and streams
 * the conversation to it over Server-Sent Events. Each page polls the catalog on its own, so it only ever shows
 * committed rows, and it works the same on a finished conversation.
 */

/** When to poll again, and how long to wait on a page in two cases; each rejects once `signal` aborts. */
export interface WatchTimers {
  nextPoll: (signal: AbortSignal) => Promise<unknown>;
  /** A reload closes the page's stream before it opens a new one, so the watch waits this long before it stops. */
  reconnectGrace: (signal: AbortSignal) => Promise<unknown>;
  /**
   * How long stopping waits for each page to take its last records. A page that stopped reading (a frozen tab)
   * holds its stream at a full socket, so after this its connection is dropped instead.
   */
  stopDrain: (signal: AbortSignal) => Promise<unknown>;
}

const POLL_INTERVAL_MS = 500;
const RECONNECT_GRACE_MS = 3_000;
const STOP_DRAIN_MS = 2_000;

/** Neither timer holds the process open: the listening server does, until the watch stops. */
export const WATCH_TIMERS: WatchTimers = {
  nextPoll: (signal) => setTimeout(POLL_INTERVAL_MS, undefined, { ref: false, signal }),
  reconnectGrace: (signal) => setTimeout(RECONNECT_GRACE_MS, undefined, { ref: false, signal }),
  stopDrain: (signal) => setTimeout(STOP_DRAIN_MS, undefined, { ref: false, signal }),
};

/** Pages streaming at once. One more is refused with 503; it is a view for one person, not a service. */
const MAX_PAGES = 4;

export type WatchEnd =
  { kind: "interrupted" } | { kind: "page_closed" } | { kind: "failed"; error: unknown };

export interface Watch {
  url: string;
  /** Settles once the server is closed and no page reads the catalog any more, so the caller may close it. */
  ended: Promise<WatchEnd>;
}

export type WatchStart = { kind: "watching"; watch: Watch } | { kind: "unknown_conversation" };

export interface WatchOptions {
  /** Opened read-only by the caller, which closes it once `ended` settles. */
  catalog: Catalog;
  conversationId: string;
  /** Aborting it stops the watch (Ctrl-C): each page is told, and `ended` settles as interrupted. */
  signal: AbortSignal;
  timers: WatchTimers;
}

const PAGE_DIR = join(import.meta.dirname, "page");
/** The static page; read once before the server listens, so serving it never touches the disk. */
const PAGE_FILES = [
  { path: "/", file: "watch.html", type: "text/html; charset=utf-8" },
  { path: "/watch.js", file: "watch.js", type: "text/javascript; charset=utf-8" },
  { path: "/watch.css", file: "watch.css", type: "text/css; charset=utf-8" },
];

/**
 * The page runs only its own script, and every fragment it places is escaped by the server; this keeps an
 * escaping mistake from ever running script out of a recorded conversation.
 */
const HEADERS = {
  "content-security-policy":
    "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
};

/** What a page shows once the watch stopped; a closed page is never told, since it is gone. */
const stoppedMessage = (end: WatchEnd): string =>
  match(end)
    .with({ kind: "interrupted" }, () => "the watch was stopped")
    .with({ kind: "page_closed" }, () => "the watch stopped")
    .with({ kind: "failed" }, () => "the watch stopped after an error")
    .exhaustive();

/** Starts watching `conversationId`, or reports that the catalog has no such conversation. */
export const startWatch = async (options: WatchOptions): Promise<WatchStart> => {
  const { catalog, conversationId, timers } = options;
  if (!findConversation(catalog, conversationId)) return { kind: "unknown_conversation" };
  const assets = await Promise.all(
    PAGE_FILES.map(async (asset) => ({
      ...asset,
      body: await readFile(join(PAGE_DIR, asset.file), "utf8"),
    })),
  );

  let outcome: WatchEnd | null = null;
  const stop = new AbortController();
  /** The first reason to stop wins; stopping tells every page and then closes the server. */
  const halt = (end: WatchEnd): void => {
    if (outcome) return;
    outcome = end;
    stop.abort();
  };
  const streams = new Set<Promise<void>>();
  /** Aborted when a page connects, which cancels the wait that stops the watch after the last page closed. */
  let grace: AbortController | null = null;

  const source = {
    /** One page's stream: everything so far, then what each poll finds, until the page closes or the watch stops. */
    async *records(signal: AbortSignal): AsyncGenerator<string> {
      let sent: Sent = NOTHING_SENT;
      while (!signal.aborted) {
        let polled: ReturnType<typeof messagesAfter>;
        try {
          polled = messagesAfter(snapshotConversation(catalog, conversationId).tables, sent);
        } catch (error) {
          halt({ kind: "failed", error });
          break;
        }
        for (const message of polled.messages) yield sseRecord(message);
        sent = polled.sent;
        try {
          await timers.nextPoll(signal);
        } catch {
          break;
        }
      }
      if (outcome) yield sseRecord({ op: "stopped", message: stoppedMessage(outcome) });
    },
  };

  const pageClosed = () => {
    if (streams.size > 0 || stop.signal.aborted) return;
    const waiting = new AbortController();
    grace = waiting;
    timers.reconnectGrace(AbortSignal.any([waiting.signal, stop.signal])).then(
      () => {
        // A page may have connected after the wait ended but before this ran.
        if (streams.size === 0 && !waiting.signal.aborted) halt({ kind: "page_closed" });
      },
      () => undefined,
    );
  };

  const stream = (res: ServerResponse) => {
    if (streams.size >= MAX_PAGES || stop.signal.aborted) {
      res.writeHead(503, HEADERS).end("too many pages are watching\n");
      return;
    }
    grace?.abort();
    grace = null;
    const closed = new AbortController();
    // Registered before the pipeline's own listener, so a poll waiting on the timer ends before it reads again.
    res.once("close", () => closed.abort());
    res.writeHead(200, { ...HEADERS, "content-type": "text/event-stream" });
    // A page that goes away fails the pipeline; that is how every stream but a stopped one ends.
    const done = pipeline(source.records(AbortSignal.any([closed.signal, stop.signal])), res)
      .catch(() => undefined)
      .finally(() => {
        streams.delete(done);
        pageClosed();
      });
    streams.add(done);
  };

  /** Set once listening: only this machine's own names, so a site that rebinds its domain to 127.0.0.1 gets nothing. */
  let ownHosts: ReadonlySet<string> = new Set();
  /**
   * A request from this machine's own name, and not from another site open in the same browser: such a site
   * could not read the stream, but it would still take a page's slot and keep the watch alive.
   */
  const ownRequest = (req: IncomingMessage): boolean => {
    const { host, origin } = req.headers;
    const site = req.headers["sec-fetch-site"];
    if (!host || !ownHosts.has(host)) return false;
    if (site === "cross-site" || site === "same-site") return false;
    return origin === undefined || origin === `http://${host}`;
  };
  const server = createServer((req, res) => {
    if (!ownRequest(req)) {
      res.writeHead(403, HEADERS).end("forbidden\n");
      return;
    }
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const asset = assets.find((candidate) => candidate.path === path);
    if (req.method !== "GET") res.writeHead(405, HEADERS).end();
    else if (path === "/events") stream(res);
    else if (asset) res.writeHead(200, { ...HEADERS, "content-type": asset.type }).end(asset.body);
    else res.writeHead(404, HEADERS).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (typeof address !== "object" || !address) {
    server.close();
    throw new Error("the watch server is not listening on a TCP port");
  }
  ownHosts = new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`]);
  const interrupted = () => halt({ kind: "interrupted" });
  if (options.signal.aborted) interrupted();
  else options.signal.addEventListener("abort", interrupted, { once: true });

  const ended = (async (): Promise<WatchEnd> => {
    if (!stop.signal.aborted) await once(stop.signal, "abort");
    options.signal.removeEventListener("abort", interrupted);
    const closing = once(server, "close");
    server.close();
    // Each stream sends its last record and ends, or is dropped once the drain wait is over.
    const drained = new AbortController();
    await Promise.race([
      Promise.all(streams),
      timers.stopDrain(drained.signal).catch(() => undefined),
    ]);
    drained.abort();
    server.closeAllConnections();
    await Promise.all(streams);
    await closing;
    return outcome ?? { kind: "interrupted" };
  })();
  return { kind: "watching", watch: { url: `http://127.0.0.1:${address.port}/`, ended } };
};
