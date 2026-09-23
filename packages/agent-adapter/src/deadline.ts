/**
 * `promise`'s value, or `fallback` once `ms` pass. The deadline is cleared as soon as the race settles and
 * never holds the process open, so a server shutting down after a kill is not kept alive by it.
 */
export const withinDeadline = async <T, F>(
  promise: Promise<T>,
  ms: number,
  fallback: F,
): Promise<T | F> => {
  const deadline = Promise.withResolvers<F>();
  const timer = setTimeout(() => deadline.resolve(fallback), ms);
  timer.unref();
  try {
    return await Promise.race([promise, deadline.promise]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * `start()`'s value, or `abandoned(reason)` as soon as `signal` aborts, whether or not the work has settled.
 * Work is never started under a signal that has already aborted. Abandoning does not stop work already started:
 * it runs on unobserved, so a rejection it settles with later is swallowed rather than left unhandled.
 */
export const untilAborted = async <T>(
  start: () => Promise<T>,
  signal: AbortSignal | undefined,
  abandoned: (reason: unknown) => T,
): Promise<T> => {
  if (!signal) return start();
  if (signal.aborted) return abandoned(signal.reason);
  const aborted = Promise.withResolvers<T>();
  const onAbort = () => aborted.resolve(abandoned(signal.reason));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([start(), aborted.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};
