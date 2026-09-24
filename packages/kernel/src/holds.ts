import { assertLimits } from "./limits.ts";

/** Why a hold was refused: the table is at its cap, or the id is already held. */
export type HoldRefusal = "full" | "duplicate";

export type HoldResult<Reply> =
  { kind: "held"; reply: Promise<Reply> } | { kind: "refused"; refusal: HoldRefusal };

/** A reply to an id that is not held: never held, already replied to, or abandoned by its signal. */
export type ReplyResult = { kind: "settled" } | { kind: "rejected" };

interface Held<Reply> {
  resolve: (reply: Reply) => void;
  signal: AbortSignal;
  abandon: () => void;
}

/**
 * Replies someone is waiting for, such as a held permission prompt waiting for the user's decision. Each hold
 * settles exactly once, by `reply` or by its signal aborting, whichever comes first; anything after that is
 * rejected, never thrown.
 */
export class Holds<Reply> {
  private readonly held = new Map<string, Held<Reply>>();

  /** `max`: holds open at once; one more is refused with `full`, and the caller answers without waiting. */
  constructor(private readonly max: number) {
    assertLimits({ max });
  }

  get size(): number {
    return this.held.size;
  }

  /**
   * Wait for the reply to `id`. When `signal` aborts first, `onAbort` supplies the reply instead (the waiter gave
   * up, so the caller records the abandonment there); if `onAbort` throws, the reply rejects with its error. A
   * signal that is already aborted settles the hold at once, inside this call.
   */
  hold(
    id: string,
    input: { signal: AbortSignal; onAbort: (reason: unknown) => Reply },
  ): HoldResult<Reply> {
    if (this.held.has(id)) return { kind: "refused", refusal: "duplicate" };
    if (this.held.size >= this.max) return { kind: "refused", refusal: "full" };
    const { promise, resolve, reject } = Promise.withResolvers<Reply>();
    const { signal, onAbort } = input;
    const abandon = (): void => {
      if (this.held.get(id)?.abandon !== abandon) return;
      this.held.delete(id);
      try {
        resolve(onAbort(signal.reason));
      } catch (error) {
        reject(error);
      }
    };
    this.held.set(id, { resolve, signal, abandon });
    if (signal.aborted) abandon();
    else signal.addEventListener("abort", abandon, { once: true });
    return { kind: "held", reply: promise };
  }

  /** Settle the hold on `id` with `reply`; rejected when nothing is held under `id`. */
  reply(id: string, reply: Reply): ReplyResult {
    const held = this.held.get(id);
    if (!held) return { kind: "rejected" };
    this.held.delete(id);
    held.signal.removeEventListener("abort", held.abandon);
    held.resolve(reply);
    return { kind: "settled" };
  }
}
