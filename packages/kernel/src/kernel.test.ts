import { describe, expect, it, vi } from "vitest";
import { createKernel, type Decide, type KernelDeps } from "./kernel.ts";

interface Change {
  sequence: number;
  record: string;
}

type Effect = { kind: "deliver"; text: string } | { kind: "throw"; text: string };

/** A store that commits records in order and replays them lazily, so a replay sees commits made while it runs. */
const createStore = () => {
  const committed: Change[] = [];
  let failNext = false;
  return {
    committed,
    failNextCommit: () => {
      failNext = true;
    },
    commit: (records: readonly string[]): Change[] => {
      if (failNext) {
        failNext = false;
        throw new Error("disk full");
      }
      return records.map((record) => {
        const change = { sequence: committed.length + 1, record };
        committed.push(change);
        return change;
      });
    },
    replay: (after: number) => committed.values().filter((change) => change.sequence > after),
  };
};

type CounterEvent = { kind: "add"; amount: number; effects?: Effect[] } | { kind: "reset" };

/** A counter that refuses to go negative and records each addition. */
const counter: Decide<number, CounterEvent, "negative", string, Effect> = ({
  state,
  event,
  now,
}) => {
  if (event.kind === "reset")
    return { kind: "accepted", next: 0, records: [`reset at ${now.toISOString()}`], effects: [] };
  if (state + event.amount < 0) return { kind: "rejected", rejection: "negative" };
  return {
    kind: "accepted",
    next: state + event.amount,
    records: [`add ${event.amount}`],
    effects: event.effects ?? [],
  };
};

const setup = (overrides: Partial<KernelDeps<string, Change, Effect>> = {}) => {
  const store = createStore();
  const performed: string[] = [];
  const reported: unknown[] = [];
  const kernel = createKernel<string, Change, Effect>({
    commit: store.commit,
    replay: store.replay,
    perform: (effect) => {
      if (effect.kind === "throw") throw new Error(effect.text);
      performed.push(effect.text);
    },
    reportEffectFailure: (error) => reported.push(error),
    now: () => new Date("2026-01-02T03:04:05.000Z"),
    limits: { subscribers: 2, buffered: 4 },
    ...overrides,
  });
  return { store, performed, reported, kernel };
};

describe("kernel dispatch", () => {
  it("commits the records, then applies the next state, then performs the effects in order", () => {
    const { store, kernel } = setup({
      perform: (effect) =>
        seen.push({ effect: effect.text, state: machine.state, store: store.committed.length }),
    });
    const seen: { effect: string; state: number; store: number }[] = [];
    const machine = kernel.machine(counter, 0);

    const result = machine.dispatch({
      kind: "add",
      amount: 2,
      effects: [
        { kind: "deliver", text: "first" },
        { kind: "deliver", text: "second" },
      ],
    });

    expect(result).toEqual({ kind: "committed", changes: [{ sequence: 1, record: "add 2" }] });
    expect(machine.state).toBe(2);
    expect(seen).toEqual([
      { effect: "first", state: 2, store: 1 },
      { effect: "second", state: 2, store: 1 },
    ]);
  });

  it("hands decide the injected clock", () => {
    const { store, kernel } = setup();
    kernel.machine(counter, 5).dispatch({ kind: "reset" });
    expect(store.committed.map((change) => change.record)).toEqual([
      "reset at 2026-01-02T03:04:05.000Z",
    ]);
  });

  it("commits, applies and performs nothing for a rejected event", () => {
    const { store, performed, kernel } = setup();
    const machine = kernel.machine(counter, 1);

    const result = machine.dispatch({
      kind: "add",
      amount: -2,
      effects: [{ kind: "deliver", text: "never" }],
    });

    expect(result).toEqual({ kind: "rejected", rejection: "negative" });
    expect(machine.state).toBe(1);
    expect(store.committed).toEqual([]);
    expect(performed).toEqual([]);
  });

  it("leaves the state unchanged and performs no effect when the commit fails", () => {
    const { store, performed, kernel } = setup();
    const machine = kernel.machine(counter, 0);
    store.failNextCommit();

    const result = machine.dispatch({
      kind: "add",
      amount: 3,
      effects: [{ kind: "deliver", text: "never" }],
    });

    expect(result).toEqual({ kind: "failed", error: new Error("disk full") });
    expect(machine.state).toBe(0);
    expect(performed).toEqual([]);
  });

  it("reports a throwing effect and keeps the commit, the state and the later effects", () => {
    const { store, performed, reported, kernel } = setup();
    const machine = kernel.machine(counter, 0);

    const result = machine.dispatch({
      kind: "add",
      amount: 1,
      effects: [
        { kind: "throw", text: "socket closed" },
        { kind: "deliver", text: "after" },
      ],
    });

    expect(result.kind).toBe("committed");
    expect(machine.state).toBe(1);
    expect(store.committed).toHaveLength(1);
    expect(performed).toEqual(["after"]);
    expect(reported).toEqual([new Error("socket closed")]);
  });

  it("completes a dispatch made by an effect before the remaining effects run", () => {
    const order: string[] = [];
    const { kernel } = setup({
      perform: (effect) => {
        order.push(effect.text);
        if (effect.text === "nest")
          order.push(`nested ${machine.dispatch({ kind: "add", amount: 10 }).kind}`);
      },
    });
    const machine = kernel.machine(counter, 0);

    machine.dispatch({
      kind: "add",
      amount: 1,
      effects: [
        { kind: "deliver", text: "nest" },
        { kind: "deliver", text: "last" },
      ],
    });

    expect(order).toEqual(["nest", "nested committed", "last"]);
    expect(machine.state).toBe(11);
  });

  it("fails a dispatch made while a commit is in progress, without applying it", () => {
    const store = createStore();
    const nested: unknown[] = [];
    const { kernel } = setup({
      commit: (records) => {
        if (records.includes("add 1")) nested.push(inner.dispatch({ kind: "add", amount: 5 }));
        return store.commit(records);
      },
    });
    const inner = kernel.machine(counter, 0);
    const outer = kernel.machine(counter, 0);

    expect(outer.dispatch({ kind: "add", amount: 1 }).kind).toBe("committed");
    expect(nested).toEqual([
      { kind: "failed", error: new Error("dispatch while a commit is in progress") },
    ]);
    expect(inner.state).toBe(0);
    expect(outer.state).toBe(1);
  });

  it("keeps each machine's state apart", () => {
    const { kernel } = setup();
    const first = kernel.machine(counter, 0);
    const second = kernel.machine(counter, 100);
    first.dispatch({ kind: "add", amount: 1 });
    expect([first.state, second.state]).toEqual([1, 100]);
  });
});

describe("kernel changes", () => {
  const subscribe = (
    kernel: ReturnType<typeof setup>["kernel"],
    input: { after: number; signal: AbortSignal },
  ) => {
    const subscribed = kernel.changes(input);
    if (subscribed.kind !== "subscribed") throw new Error(`refused: ${subscribed.kind}`);
    return subscribed.changes[Symbol.asyncIterator]();
  };

  it("yields the history after the sequence, then each commit as it lands, in order", async () => {
    const { kernel } = setup();
    const machine = kernel.machine(counter, 0);
    machine.dispatch({ kind: "add", amount: 1 });
    machine.dispatch({ kind: "add", amount: 2 });
    const changes = subscribe(kernel, { after: 1, signal: new AbortController().signal });

    expect(await changes.next()).toEqual({ done: false, value: { sequence: 2, record: "add 2" } });
    const live = changes.next();
    machine.dispatch({ kind: "add", amount: 3 });
    expect(await live).toEqual({ done: false, value: { sequence: 3, record: "add 3" } });
  });

  it("yields nothing for a failed commit", async () => {
    const { store, kernel } = setup();
    const machine = kernel.machine(counter, 0);
    const changes = subscribe(kernel, { after: 0, signal: new AbortController().signal });
    const next = changes.next();

    store.failNextCommit();
    machine.dispatch({ kind: "add", amount: 1 });
    machine.dispatch({ kind: "add", amount: 2 });

    expect(await next).toEqual({ done: false, value: { sequence: 1, record: "add 2" } });
  });

  it("buffers commits made before the first read", async () => {
    const { kernel } = setup();
    const machine = kernel.machine(counter, 0);
    const changes = subscribe(kernel, { after: 0, signal: new AbortController().signal });
    machine.dispatch({ kind: "add", amount: 1 });

    expect(await changes.next()).toEqual({ done: false, value: { sequence: 1, record: "add 1" } });
  });

  it("yields a commit made during the replay once", async () => {
    const { kernel } = setup();
    const machine = kernel.machine(counter, 0);
    machine.dispatch({ kind: "add", amount: 1 });
    const changes = subscribe(kernel, { after: 0, signal: new AbortController().signal });

    expect((await changes.next()).value).toEqual({ sequence: 1, record: "add 1" });
    // The replay is still open: this commit reaches the reader through both the replay and the buffer.
    machine.dispatch({ kind: "add", amount: 2 });
    expect((await changes.next()).value).toEqual({ sequence: 2, record: "add 2" });
    const next = changes.next();
    machine.dispatch({ kind: "add", amount: 3 });
    expect((await next).value).toEqual({ sequence: 3, record: "add 3" });
  });

  it("gives a reader that falls behind the buffer every change, in order, from the store", async () => {
    const store = createStore();
    const replay = vi.fn(store.replay);
    const { kernel } = setup({ commit: store.commit, replay });
    const machine = kernel.machine(counter, 0);
    const changes = subscribe(kernel, { after: 0, signal: new AbortController().signal });
    const first = changes.next();
    machine.dispatch({ kind: "add", amount: 1 });
    expect((await first).value).toEqual({ sequence: 1, record: "add 1" });

    // Six commits unread overflow the buffer of four.
    for (const amount of [2, 3, 4, 5, 6, 7]) machine.dispatch({ kind: "add", amount });
    const read: number[] = [];
    for (let index = 0; index < 6; index++) {
      const next = await changes.next();
      if (!next.done) read.push(next.value.sequence);
    }

    expect(read).toEqual([2, 3, 4, 5, 6, 7]);
    expect(replay.mock.calls).toEqual([[0], [1]]);
  });

  it("ends the iteration without an error when the signal aborts, and frees the slot", async () => {
    const { kernel } = setup();
    const aborting = new AbortController();
    const changes = subscribe(kernel, { after: 0, signal: aborting.signal });
    subscribe(kernel, { after: 0, signal: new AbortController().signal });
    const next = changes.next();

    aborting.abort();

    expect(await next).toEqual({ done: true, value: undefined });
    expect(kernel.changes({ after: 0, signal: new AbortController().signal }).kind).toBe(
      "subscribed",
    );
  });

  it("frees the slot when the reader stops iterating", async () => {
    const { kernel } = setup();
    const machine = kernel.machine(counter, 0);
    machine.dispatch({ kind: "add", amount: 1 });
    const subscribed = kernel.changes({ after: 0, signal: new AbortController().signal });
    subscribe(kernel, { after: 0, signal: new AbortController().signal });
    if (subscribed.kind !== "subscribed") throw new Error("refused");

    for await (const _ of subscribed.changes) break;

    expect(kernel.changes({ after: 0, signal: new AbortController().signal }).kind).toBe(
      "subscribed",
    );
  });

  it("refuses a subscription beyond the cap", () => {
    const { kernel } = setup();
    const signal = new AbortController().signal;
    kernel.changes({ after: 0, signal });
    kernel.changes({ after: 0, signal });
    expect(kernel.changes({ after: 0, signal })).toEqual({ kind: "full", limit: 2 });
  });

  it("yields nothing and holds no slot for an already aborted signal", async () => {
    const replay = vi.fn(() => []);
    const { kernel } = setup({ replay });
    const signal = AbortSignal.abort();
    const changes = subscribe(kernel, { after: 0, signal });
    subscribe(kernel, { after: 0, signal });
    subscribe(kernel, { after: 0, signal });

    expect(await changes.next()).toEqual({ done: true, value: undefined });
    expect(replay).not.toHaveBeenCalled();
  });
});
