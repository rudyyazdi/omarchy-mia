import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { untilAborted, withinDeadline } from "./deadline.ts";

describe("withinDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles with the promise and cancels its deadline when the promise wins", async () => {
    const outcome = withinDeadline(Promise.resolve("exited"), 5_000, "timeout");
    await expect(outcome).resolves.toBe("exited");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles with the fallback once the deadline passes", async () => {
    const outcome = withinDeadline(new Promise<string>(() => undefined), 5_000, "timeout");
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(outcome).resolves.toBe("timeout");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("untilAborted", () => {
  const abandoned = (reason: unknown) => `abandoned: ${String(reason)}`;

  it("settles with the work when no signal aborts", async () => {
    const signal = new AbortController().signal;
    await expect(untilAborted(() => Promise.resolve("read"), signal, abandoned)).resolves.toBe(
      "read",
    );
  });

  it("gives up on work that never settles once the signal aborts", async () => {
    const controller = new AbortController();
    const outcome = untilAborted(
      () => new Promise<string>(() => undefined),
      controller.signal,
      abandoned,
    );
    controller.abort("deadline");
    await expect(outcome).resolves.toBe("abandoned: deadline");
  });

  it("never starts work under a signal that has already aborted", async () => {
    let started = false;
    const start = () => {
      started = true;
      return Promise.resolve("read");
    };
    await expect(untilAborted(start, AbortSignal.abort("shutdown"), abandoned)).resolves.toBe(
      "abandoned: shutdown",
    );
    expect(started).toBe(false);
  });
});
