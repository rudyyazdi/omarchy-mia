import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withinDeadline } from "./deadline.ts";

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
