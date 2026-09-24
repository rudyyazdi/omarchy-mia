import { assertLimits } from "./limits.ts";

/**
 * A committed change and its position in the store's order. The sequence totally orders every change one feed
 * carries: a store whose sequences restart per scope (the catalog numbers events per conversation) needs one feed
 * per scope, because the feed drops any change at or below the last sequence a reader received.
 */
export interface Sequenced {
  readonly sequence: number;
}

export interface FeedLimits {
  /** Subscriptions open at once; one more is refused. */
  subscribers: number;
  /**
   * Changes buffered for one subscriber that has not read them yet, and the page size of a replay. When a commit
   * would exceed it the buffer is dropped, and the subscriber reads the store again from the last change it
   * received: memory stays bounded and a slow reader misses nothing.
   */
  buffered: number;
}

export interface FeedDeps<Change extends Sequenced> {
  /**
   * Up to `limit` committed changes after `after`, in increasing sequence order, read from the store (never from
   * memory); fewer than `limit` means none are left. It returns a finished array, so no statement stays open while
   * a reader is slow. The feed only sees changes committed through the kernel live: one committed around it
   * reaches a subscriber only through a later replay. A replay that throws ends the subscription and rejects the
   * reader's pending read with its error.
   */
  replay: (input: { after: number; limit: number }) => readonly Change[];
  limits: FeedLimits;
}

export type Subscribed<Change> =
  { kind: "subscribed"; changes: AsyncIterable<Change> } | { kind: "full"; limit: number };

class Subscription<Change> {
  pending: Change[] = [];
  /** The buffer overflowed and was dropped: the reader must replay from the store. */
  overflowed = false;
  /** The subscription ended (abort or the reader stopped); the stream finishes at its next step. */
  closed = false;
  private waiter: PromiseWithResolvers<undefined> | null = null;

  constructor(private readonly limit: number) {}

  push(changes: readonly Change[]): void {
    if (this.overflowed) return;
    if (this.pending.length + changes.length > this.limit) {
      this.pending = [];
      this.overflowed = true;
    } else {
      this.pending.push(...changes);
    }
    this.wake();
  }

  /** Drop what is buffered before a replay, which reads it from the store instead, and buffer again. */
  restart(): void {
    this.pending = [];
    this.overflowed = false;
  }

  /** Take what is buffered; the caller replays first when `overflowed` is set. */
  take(): Change[] {
    const taken = this.pending;
    this.pending = [];
    return taken;
  }

  wait(): Promise<undefined> {
    if (this.closed) return Promise.resolve(undefined);
    this.waiter = Promise.withResolvers<undefined>();
    return this.waiter.promise;
  }

  wake(): void {
    this.waiter?.resolve(undefined);
    this.waiter = null;
  }
}

/**
 * Streams committed changes to subscribers: first the store's history after a sequence, then each commit as it
 * lands. Every subscriber sees each change once, in sequence order, and only after it committed.
 */
export class ChangeFeed<Change extends Sequenced> {
  private readonly subscriptions = new Set<Subscription<Change>>();

  constructor(private readonly deps: FeedDeps<Change>) {
    assertLimits({ ...deps.limits });
  }

  /** Hand a commit's changes to every subscriber. Called only after the commit, in commit order. */
  publish(changes: readonly Change[]): void {
    if (changes.length === 0) return;
    for (const subscription of this.subscriptions) subscription.push(changes);
  }

  /**
   * Subscribe now, so nothing committed from here on is missed even before the first read. The subscription ends,
   * and the iteration finishes without an error, when `signal` aborts or the reader calls `return` (a `break`),
   * even before its first read or while a read is pending. A reader that neither iterates nor returns holds its
   * slot until `signal` aborts.
   */
  subscribe(input: { after: number; signal: AbortSignal }): Subscribed<Change> {
    const { limits } = this.deps;
    const { signal } = input;
    if (this.subscriptions.size >= limits.subscribers)
      return { kind: "full", limit: limits.subscribers };
    const subscription = new Subscription<Change>(limits.buffered);
    const leave = (): void => {
      subscription.closed = true;
      this.subscriptions.delete(subscription);
      signal.removeEventListener("abort", leave);
      subscription.wake();
    };
    if (signal.aborted) subscription.closed = true;
    else {
      this.subscriptions.add(subscription);
      signal.addEventListener("abort", leave, { once: true });
    }
    const stream = this.stream({ subscription, after: input.after, leave });
    // A generator that has not started skips its `finally` on `return`, and one waiting for a commit queues the
    // `return` behind that wait; leaving first frees the slot and wakes the wait in both cases.
    const iterator: AsyncIterator<Change, undefined, undefined> = {
      next: () => stream.next(),
      async return() {
        leave();
        return stream.return(undefined);
      },
    };
    return { kind: "subscribed", changes: { [Symbol.asyncIterator]: () => iterator } };
  }

  private async *stream(input: {
    subscription: Subscription<Change>;
    after: number;
    leave: () => void;
  }): AsyncGenerator<Change, undefined, undefined> {
    const { subscription } = input;
    const { limits, replay } = this.deps;
    let last = input.after;
    let replaying = true;
    try {
      while (!subscription.closed) {
        let batch: readonly Change[];
        if (replaying) {
          // Buffer from here on: a commit landing while this page is read is caught by the buffer or the next page.
          subscription.restart();
          batch = replay({ after: last, limit: limits.buffered });
          replaying = batch.length >= limits.buffered;
        } else {
          batch = subscription.take();
        }
        for (const change of batch) {
          if (subscription.closed) return undefined;
          if (change.sequence <= last) continue;
          last = change.sequence;
          yield change;
        }
        if (subscription.overflowed) replaying = true;
        else if (!replaying && subscription.pending.length === 0) await subscription.wait();
      }
      return undefined;
    } finally {
      input.leave();
    }
  }
}
