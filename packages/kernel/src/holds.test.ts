import { describe, expect, it, vi } from "vitest";
import { Holds } from "./holds.ts";

const held = (result: ReturnType<Holds<string>["hold"]>): Promise<string> => {
  if (result.kind !== "held") throw new Error(`refused: ${result.refusal}`);
  return result.reply;
};

describe("holds", () => {
  it("settles once on reply and rejects a duplicate reply", async () => {
    const holds = new Holds<string>(4);
    const onAbort = vi.fn(() => "abandoned");
    const aborting = new AbortController();
    const reply = held(holds.hold("approval-1", { signal: aborting.signal, onAbort }));

    expect(holds.reply("approval-1", "allow")).toEqual({ kind: "settled" });
    expect(holds.reply("approval-1", "deny")).toEqual({ kind: "rejected" });
    aborting.abort();

    expect(await reply).toBe("allow");
    expect(onAbort).not.toHaveBeenCalled();
    expect(holds.size).toBe(0);
  });

  it("settles once on abort with the reply onAbort supplies, and rejects a late reply", async () => {
    const holds = new Holds<string>(4);
    const onAbort = vi.fn((reason: unknown) => `abandoned: ${String(reason)}`);
    const aborting = new AbortController();
    const reply = held(holds.hold("approval-1", { signal: aborting.signal, onAbort }));

    aborting.abort("runtime gone");

    expect(await reply).toBe("abandoned: runtime gone");
    expect(holds.reply("approval-1", "allow")).toEqual({ kind: "rejected" });
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(holds.size).toBe(0);
  });

  it("settles at once for a signal that is already aborted", async () => {
    const holds = new Holds<string>(4);
    const reply = held(
      holds.hold("approval-1", { signal: AbortSignal.abort(), onAbort: () => "abandoned" }),
    );

    expect(holds.size).toBe(0);
    expect(await reply).toBe("abandoned");
  });

  it("rejects the reply with the error onAbort throws", async () => {
    const holds = new Holds<string>(4);
    const aborting = new AbortController();
    const reply = held(
      holds.hold("approval-1", {
        signal: aborting.signal,
        onAbort: () => {
          throw new Error("could not record the abandonment");
        },
      }),
    );

    aborting.abort();

    await expect(reply).rejects.toThrow("could not record the abandonment");
    expect(holds.size).toBe(0);
  });

  it("rejects a reply to an id that was never held", () => {
    expect(new Holds<string>(4).reply("approval-1", "allow")).toEqual({ kind: "rejected" });
  });

  it("refuses a second hold on an id that is held", () => {
    const holds = new Holds<string>(4);
    const signal = new AbortController().signal;
    holds.hold("approval-1", { signal, onAbort: () => "abandoned" });

    expect(holds.hold("approval-1", { signal, onAbort: () => "abandoned" })).toEqual({
      kind: "refused",
      refusal: "duplicate",
    });
  });

  it("refuses a hold beyond the cap until one settles", () => {
    const holds = new Holds<string>(2);
    const signal = new AbortController().signal;
    const onAbort = (): string => "abandoned";
    holds.hold("approval-1", { signal, onAbort });
    holds.hold("approval-2", { signal, onAbort });

    expect(holds.full).toBe(true);
    expect(holds.hold("approval-3", { signal, onAbort })).toEqual({
      kind: "refused",
      refusal: "full",
    });
    holds.reply("approval-1", "allow");
    expect(holds.full).toBe(false);
    expect(holds.hold("approval-3", { signal, onAbort }).kind).toBe("held");
  });

  it("refuses a cap that is not a positive integer", () => {
    expect(() => new Holds<string>(Number.NaN)).toThrow(RangeError);
    expect(() => new Holds<string>(0)).toThrow(RangeError);
  });

  it("does not answer a new hold on an id with the abort of an earlier, settled one", async () => {
    const holds = new Holds<string>(4);
    const first = new AbortController();
    holds.hold("approval-1", { signal: first.signal, onAbort: () => "first abandoned" });
    holds.reply("approval-1", "allow");
    const reply = held(
      holds.hold("approval-1", {
        signal: new AbortController().signal,
        onAbort: () => "second abandoned",
      }),
    );

    first.abort();
    holds.reply("approval-1", "deny");

    expect(await reply).toBe("deny");
  });
});
