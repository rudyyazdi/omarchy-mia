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
