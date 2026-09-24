/** A committed change and its position in the store's total order. */
export interface Sequenced {
  readonly sequence: number;
}

export interface FeedLimits {
  /** Subscriptions open at once; one more is refused. */
  subscribers: number;
  /**
   * Changes buffered for one subscriber that has not read them yet. When a commit would exceed it the buffer is
   * dropped, and the subscriber reads the store again from the last change it received: memory stays bounded and
   * a slow reader misses nothing.
   */
  buffered: number;
}

export interface FeedDeps<Change extends Sequenced> {
  /**
   * The committed changes after `after`, in increasing sequence order, read from the store (never from memory).
   * It must return every change committed before it is called; a change committed while it is being iterated may
   * or may not appear, since the feed buffers those as well and drops the duplicates.
   */
  replay: (after: number) => Iterable<Change>;
  limits: FeedLimits;
}

export type Subscribed<Change> =
  { kind: "subscribed"; changes: AsyncIterable<Change> } | { kind: "full"; limit: number };

class Subscription<Change> {
  pending: Change[] = [];
  /** The buffer overflowed and was dropped: the reader must replay from the store. */
  overflowed = false;
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

  constructor(private readonly deps: FeedDeps<Change>) {}

  /** Hand a commit's changes to every subscriber. Called only after the commit, in commit order. */
  publish(changes: readonly Change[]): void {
    if (changes.length === 0) return;
    for (const subscription of this.subscriptions) subscription.push(changes);
  }

  /**
   * Subscribe now, so nothing committed from here on is missed even before the first read. The subscription ends,
   * and the iteration finishes without an error, when `signal` aborts or the reader stops iterating; a reader that
   * never iterates holds its slot until `signal` aborts.
   */
  subscribe(input: { after: number; signal: AbortSignal }): Subscribed<Change> {
    const { limits } = this.deps;
    if (this.subscriptions.size >= limits.subscribers)
      return { kind: "full", limit: limits.subscribers };
    const subscription = new Subscription<Change>(limits.buffered);
    const leave = (): void => {
      this.subscriptions.delete(subscription);
      subscription.wake();
    };
    if (!input.signal.aborted) {
      this.subscriptions.add(subscription);
      input.signal.addEventListener("abort", leave, { once: true });
    }
    const stream = this.stream({ subscription, after: input.after, signal: input.signal, leave });
    return {
      kind: "subscribed",
      changes: {
        [Symbol.asyncIterator]: () => stream,
      },
    };
  }

  private async *stream(input: {
    subscription: Subscription<Change>;
    after: number;
    signal: AbortSignal;
    leave: () => void;
  }): AsyncGenerator<Change, void, undefined> {
    const { subscription, signal } = input;
    let last = input.after;
    let replaying = true;
    try {
      while (!signal.aborted) {
        let batch: Iterable<Change>;
        if (replaying) {
          // Buffer from here on, so a commit landing during the replay is caught either way.
          subscription.restart();
          replaying = false;
          batch = this.deps.replay(last);
        } else {
          batch = subscription.take();
        }
        let received = false;
        for (const change of batch) {
          if (signal.aborted) return;
          received = true;
          if (change.sequence <= last) continue;
          last = change.sequence;
          yield change;
        }
        if (subscription.overflowed) replaying = true;
        else if (!received && subscription.pending.length === 0) await subscription.wait();
      }
    } finally {
      signal.removeEventListener("abort", input.leave);
      input.leave();
    }
  }
}
