import { describe, expect, it } from "vitest";
import { createKernel, type Decide, type KernelDeps } from "./kernel.ts";

interface Change {
  sequence: number;
  record: string;
}

type Effect = { kind: "deliver"; text: string } | { kind: "throw"; text: string };

/** A store that commits records in order and replays them a page at a time. */
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
    replay: ({ after, limit }: { after: number; limit: number }) =>
      committed.filter((change) => change.sequence > after).slice(0, limit),
  };
};

interface CounterEvent {
  kind: "add";
  amount: number;
  effects?: Effect[];
}

/** A counter that refuses to go negative and records each addition. */
const counter: Decide<number, CounterEvent, "negative", string, Effect> = ({ state, event }) => {
  if (state + event.amount < 0) return { kind: "rejected", rejection: "negative" };
  return {
    kind: "accepted",
    next: state + event.amount,
    records: [`add ${event.amount}`],
    effects: event.effects ?? [],
  };
};

/** An effect that throws, then one that must still run. */
const THROW_THEN_DELIVER: Effect[] = [
  { kind: "throw", text: "socket closed" },
  { kind: "deliver", text: "after" },
];

const openSignal = (): AbortSignal => new AbortController().signal;

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

  /** Dispatch an effect that throws followed by one that must still run, and observe the outcome. */
  const dispatchPastThrowingEffect = (overrides: Partial<KernelDeps<string, Change, Effect>>) => {
    const { store, performed, reported, kernel } = setup(overrides);
    const machine = kernel.machine(counter, 0);
    const result = machine.dispatch({ kind: "add", amount: 1, effects: THROW_THEN_DELIVER });
    return {
      result: result.kind,
      state: machine.state,
      committed: store.committed.length,
      performed,
      reported,
    };
  };

  it("reports a throwing effect and keeps the commit, the state and the later effects", () => {
    expect(dispatchPastThrowingEffect({})).toEqual({
      result: "committed",
      state: 1,
      committed: 1,
      performed: ["after"],
      reported: [new Error("socket closed")],
    });
  });

  it("fails a dispatch made by an effect, and still performs the remaining effects", () => {
    const order: string[] = [];
    const { kernel } = setup({
      perform: (effect) => {
        order.push(effect.text);
        if (effect.text === "nest") {
          const nested = machine.dispatch({ kind: "add", amount: 10 });
          order.push(nested.kind === "failed" ? String(nested.error) : nested.kind);
        }
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

    expect(order).toEqual([
      "nest",
      "Error: dispatch while another dispatch is in progress",
      "last",
    ]);
    expect(machine.state).toBe(1);
    expect(machine.dispatch({ kind: "add", amount: 10 }).kind).toBe("committed");
  });

  it("keeps the commit and the later effects when the failure reporter throws", () => {
    const outcome = dispatchPastThrowingEffect({
      reportEffectFailure: () => {
        throw new Error("reporter failed");
      },
    });
    expect(outcome).toMatchObject({
      result: "committed",
      state: 1,
      committed: 1,
      performed: ["after"],
    });
  });

  it("refuses limits that are not positive integers", () => {
    expect(() => setup({ limits: { subscribers: Number.NaN, buffered: 4 } })).toThrow(RangeError);
    expect(() => setup({ limits: { subscribers: 1, buffered: 0 } })).toThrow(RangeError);
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
      { kind: "failed", error: new Error("dispatch while another dispatch is in progress") },
    ]);
    expect(inner.state).toBe(0);
    expect(outer.state).toBe(1);
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

  /** Hold one of the two slots for the rest of the test. */
  const takeSlot = (kernel: ReturnType<typeof setup>["kernel"]): void => {
    subscribe(kernel, { after: 0, signal: openSignal() });
  };

  const expectFreeSlot = (kernel: ReturnType<typeof setup>["kernel"]): void => {
    expect(kernel.changes({ after: 0, signal: openSignal() }).kind).toBe("subscribed");
  };

  it("yields the history after the sequence, then each commit as it lands, in order", async () => {
    const { kernel } = setup();
    const machine = kernel.machine(counter, 0);
    machine.dispatch({ kind: "add", amount: 1 });
    machine.dispatch({ kind: "add", amount: 2 });
    const changes = subscribe(kernel, { after: 1, signal: openSignal() });

    expect(await changes.next()).toEqual({ done: false, value: { sequence: 2, record: "add 2" } });
    const live = changes.next();
    machine.dispatch({ kind: "add", amount: 3 });
    expect(await live).toEqual({ done: false, value: { sequence: 3, record: "add 3" } });
  });

  it("yields nothing for a failed commit or a rejected event", async () => {
    const { store, kernel } = setup();
    const machine = kernel.machine(counter, 0);
    const changes = subscribe(kernel, { after: 0, signal: openSignal() });
    const next = changes.next();

    store.failNextCommit();
    machine.dispatch({ kind: "add", amount: 1 });
    machine.dispatch({ kind: "add", amount: -1 });
    machine.dispatch({ kind: "add", amount: 2 });

    expect(await next).toEqual({ done: false, value: { sequence: 1, record: "add 2" } });
  });

  it("buffers commits made before the first read", async () => {
    const { kernel } = setup();
    const machine = kernel.machine(counter, 0);
    const changes = subscribe(kernel, { after: 0, signal: openSignal() });
    machine.dispatch({ kind: "add", amount: 1 });

    expect(await changes.next()).toEqual({ done: false, value: { sequence: 1, record: "add 1" } });
  });

  it("pages through a history longer than the buffer, with a commit made mid-page once", async () => {
    const { kernel } = setup();
    const machine = kernel.machine(counter, 0);
    for (const amount of [1, 2, 3, 4, 5]) machine.dispatch({ kind: "add", amount });
    const changes = subscribe(kernel, { after: 0, signal: openSignal() });

    expect((await changes.next()).value).toEqual({ sequence: 1, record: "add 1" });
    machine.dispatch({ kind: "add", amount: 6 });
    const read: number[] = [];
    for (let index = 0; index < 5; index++) {
      const next = await changes.next();
      if (!next.done) read.push(next.value.sequence);
    }
    const live = changes.next();
    machine.dispatch({ kind: "add", amount: 7 });

    expect(read).toEqual([2, 3, 4, 5, 6]);
    expect((await live).value).toEqual({ sequence: 7, record: "add 7" });
  });

  it("gives a reader that falls behind the buffer every change, in order, from the store", async () => {
    const { kernel } = setup();
    const machine = kernel.machine(counter, 0);
    const changes = subscribe(kernel, { after: 0, signal: openSignal() });
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
  });

  it("ends the iteration without an error when the signal aborts, and frees the slot", async () => {
    const { kernel } = setup();
    const aborting = new AbortController();
    const changes = subscribe(kernel, { after: 0, signal: aborting.signal });
    takeSlot(kernel);
    const next = changes.next();

    aborting.abort();

    expect(await next).toEqual({ done: true, value: undefined });
    expectFreeSlot(kernel);
  });

  it("frees the slot when the reader stops iterating", async () => {
    const { kernel } = setup();
    const machine = kernel.machine(counter, 0);
    machine.dispatch({ kind: "add", amount: 1 });
    const subscribed = kernel.changes({ after: 0, signal: openSignal() });
    takeSlot(kernel);
    if (subscribed.kind !== "subscribed") throw new Error("refused");

    for await (const _ of subscribed.changes) break;

    expectFreeSlot(kernel);
  });

  it("frees the slot when the reader returns before its first read", async () => {
    const { kernel } = setup();
    const changes = subscribe(kernel, { after: 0, signal: openSignal() });
    takeSlot(kernel);

    expect(await changes.return?.()).toEqual({ done: true, value: undefined });
    expectFreeSlot(kernel);
  });

  it("ends a pending read and frees the slot when the reader returns while it waits", async () => {
    const { kernel } = setup();
    const changes = subscribe(kernel, { after: 0, signal: openSignal() });
    takeSlot(kernel);
    const pending = changes.next();

    const returned = changes.return?.();

    expect(await pending).toEqual({ done: true, value: undefined });
    expect(await returned).toEqual({ done: true, value: undefined });
    expectFreeSlot(kernel);
  });

  it("ends the iteration when the signal aborts while the reader holds a change", async () => {
    const { kernel } = setup();
    const machine = kernel.machine(counter, 0);
    for (const amount of [1, 2, 3]) machine.dispatch({ kind: "add", amount });
    const aborting = new AbortController();
    const changes = subscribe(kernel, { after: 0, signal: aborting.signal });
    expect((await changes.next()).value).toEqual({ sequence: 1, record: "add 1" });

    aborting.abort();

    expect(await changes.next()).toEqual({ done: true, value: undefined });
  });

  it("rejects the read and frees the slot when the replay throws", async () => {
    const { kernel } = setup({
      replay: () => {
        throw new Error("catalog closed");
      },
    });
    const changes = subscribe(kernel, { after: 0, signal: openSignal() });
    takeSlot(kernel);

    await expect(changes.next()).rejects.toThrow("catalog closed");
    expectFreeSlot(kernel);
  });

  it("refuses a subscription beyond the cap", () => {
    const { kernel } = setup();
    const signal = openSignal();
    kernel.changes({ after: 0, signal });
    kernel.changes({ after: 0, signal });
    expect(kernel.changes({ after: 0, signal })).toEqual({ kind: "full", limit: 2 });
  });

  it("yields nothing and holds no slot for an already aborted signal", async () => {
    const { kernel } = setup();
    const signal = AbortSignal.abort();
    const changes = subscribe(kernel, { after: 0, signal });
    subscribe(kernel, { after: 0, signal });
    subscribe(kernel, { after: 0, signal });

    expect(await changes.next()).toEqual({ done: true, value: undefined });
  });
});
