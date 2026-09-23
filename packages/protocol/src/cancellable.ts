/**
 * Options of a long-running operation whose deadline the caller owns: the operation never creates a deadline of its
 * own, it only listens for `signal`, and an abort ends it. Without a signal it has no deadline. Each operation
 * documents how an abort ends it.
 */
export interface Cancellable {
  signal?: AbortSignal;
}
