import {
  ChangeFeed,
  type FeedDeps,
  type FeedLimits,
  type Sequenced,
  type Subscribed,
} from "./feed.ts";

/** What a machine decides for one event: refuse it, or the next state with the records and effects it takes. */
export type Decision<State, Rejection, Rec, Effect> =
  | { kind: "rejected"; rejection: Rejection }
  | { kind: "accepted"; next: State; records: readonly Rec[]; effects: readonly Effect[] };

/**
 * One entity kind's rules, and one transaction boundary: whatever must commit together belongs to one machine.
 * Pure and synchronous: it reads only its input and never mutates `state` (a failed commit keeps it as the next
 * state of nothing), and an answer that arrives later (a runtime callback, a user's decision) comes back as a new
 * event. A `decide` that throws is a bug: the dispatch throws, and nothing is committed, applied or performed.
 */
export type Decide<State, Event, Rejection, Rec, Effect> = (input: {
  state: State;
  event: Event;
  now: Date;
}) => Decision<State, Rejection, Rec, Effect>;

/**
 * How a dispatch ended. `failed`: the commit threw, so the state is unchanged and no effect ran. `committed`:
 * the records stand, the state moved on, and every effect ran, whether or not one of them threw.
 */
export type Dispatched<Rejection, Change> =
  | { kind: "rejected"; rejection: Rejection }
  | { kind: "failed"; error: unknown }
  | { kind: "committed"; changes: readonly Change[] };

/** An entity kind's state, which only its dispatches change. */
export interface Machine<State, Event, Rejection, Change> {
  readonly state: State;
  dispatch(event: Event): Dispatched<Rejection, Change>;
}

export interface KernelDeps<Rec, Change extends Sequenced, Effect> {
  /**
   * Write `records` in one transaction and return the changes it committed, in increasing sequence order; a
   * record may commit no change. An empty `records` commits nothing and returns no changes without throwing; it
   * throws only when the transaction failed, and then nothing committed. Every commit a subscriber should see live
   * goes through here: the feed publishes only what this returns.
   */
  commit: (records: readonly Rec[]) => readonly Change[];
  /** Perform one effect (deliver to a client, answer the runtime) once its commit landed and the state moved on. */
  perform: (effect: Effect, changes: readonly Change[]) => void;
  /** An effect threw. The commit, the state and the other effects stand; a throw from here is dropped. */
  reportEffectFailure: (error: unknown) => void;
  /** The committed changes after a sequence, read from the store; see FeedDeps.replay. */
  replay: FeedDeps<Change>["replay"];
  now: () => Date;
  limits: FeedLimits;
}

export interface Kernel<Rec, Change extends Sequenced, Effect> {
  /** A machine that starts at `initial` and moves only through `decide`. */
  machine<State, Event, Rejection>(
    decide: Decide<State, Event, Rejection, Rec, Effect>,
    initial: State,
  ): Machine<State, Event, Rejection, Change>;
  /** Every change committed after `after`, in sequence order, until `signal` aborts; see ChangeFeed.subscribe. */
  changes(input: { after: number; signal: AbortSignal }): Subscribed<Change>;
}

/** The kernel's side of a dispatch, which a machine calls once `decide` accepted an event. */
interface Pipeline<Rec, Change, Effect> {
  now: () => Date;
  /** Commit the records, or say why nothing committed. */
  commit: (
    records: readonly Rec[],
  ) => { kind: "failed"; error: unknown } | { kind: "committed"; changes: readonly Change[] };
  /** Publish a commit's changes and perform its effects, once the state moved on. */
  follow: (changes: readonly Change[], effects: readonly Effect[]) => void;
}

class KernelMachine<State, Event, Rejection, Rec, Change, Effect> implements Machine<
  State,
  Event,
  Rejection,
  Change
> {
  private current: State;

  constructor(
    private readonly decide: Decide<State, Event, Rejection, Rec, Effect>,
    initial: State,
    private readonly pipeline: Pipeline<Rec, Change, Effect>,
  ) {
    this.current = initial;
  }

  get state(): State {
    return this.current;
  }

  dispatch(event: Event): Dispatched<Rejection, Change> {
    const decision = this.decide({ state: this.current, event, now: this.pipeline.now() });
    if (decision.kind === "rejected") return { kind: "rejected", rejection: decision.rejection };
    const committed = this.pipeline.commit(decision.records);
    if (committed.kind === "failed") return committed;
    this.current = decision.next;
    this.pipeline.follow(committed.changes, decision.effects);
    return committed;
  }
}

/**
 * Orders every state change the same way: decide, commit the records, apply the next state, publish the changes,
 * then perform the effects. Memory and clients follow the store, never the other way round, so nothing is
 * applied, released or delivered for a record that did not commit. A dispatch runs to completion without
 * yielding, because the commit is synchronous. Neither a commit nor an effect may dispatch: a nested dispatch
 * fails without committing, since it would apply state inside another transaction, or deliver its effects ahead
 * of the rest of an earlier commit's. A follow-up is a new event, dispatched once the dispatch returned.
 */
export const createKernel = <Rec, Change extends Sequenced, Effect>(
  deps: KernelDeps<Rec, Change, Effect>,
): Kernel<Rec, Change, Effect> => {
  const feed = new ChangeFeed<Change>({ replay: deps.replay, limits: deps.limits });
  let dispatching = false;

  const report = (error: unknown): void => {
    try {
      deps.reportEffectFailure(error);
    } catch {
      // Dropped: a reporter that throws must not skip the remaining effects or unwind a committed dispatch.
    }
  };

  const pipeline: Pipeline<Rec, Change, Effect> = {
    now: deps.now,
    commit: (records) => {
      if (dispatching)
        return {
          kind: "failed",
          error: new Error("dispatch while another dispatch is in progress"),
        };
      dispatching = true;
      try {
        return { kind: "committed", changes: deps.commit(records) };
      } catch (error) {
        dispatching = false;
        return { kind: "failed", error };
      }
    },
    follow: (changes, effects) => {
      try {
        feed.publish(changes);
        for (const effect of effects) {
          try {
            deps.perform(effect, changes);
          } catch (error) {
            report(error);
          }
        }
      } finally {
        dispatching = false;
      }
    },
  };

  return {
    machine: <State, Event, Rejection>(
      decide: Decide<State, Event, Rejection, Rec, Effect>,
      initial: State,
    ) => new KernelMachine(decide, initial, pipeline),
    changes: (input) => feed.subscribe(input),
  };
};
