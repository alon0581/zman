/**
 * Per-user in-process async mutex.
 *
 * The synchronous read-modify-write callers (see `jsonStore.ts`) are already
 * atomic under Node's single thread — they need no lock. This exists for the one
 * shape that is genuinely racy: **read a JSON file → await something → write that
 * same file back**. Between the read and the write another request can interleave,
 * and the later write silently clobbers the earlier one (classic lost update).
 *
 * Calls for the same `userId` are serialised onto one promise chain; different
 * users stay fully parallel.
 *
 * Single-process scope ONLY. This does NOT protect against multiple Railway
 * replicas (or a second Node process) writing the same file — for that we'd need
 * a real on-disk lock. Today Zman runs one replica, so this is enough.
 *
 * Usage rule that keeps it deadlock-free: `fn` must never take another user lock,
 * so there is only ever one lock held at a time and no lock-ordering cycle. The
 * chain also always drains — the queue advances on rejection just like on success.
 */

/** userId → tail of that user's queue. Never rejects (see `next` below). */
const chains = new Map<string, Promise<void>>()

export function withUserLock<T>(userId: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = chains.get(userId) ?? Promise.resolve()

  // Run once the previous holder has settled. `prev` can't reject, so a failed
  // predecessor never poisons the queue — every waiter still gets its turn.
  const result = prev.then(() => fn())

  // Release on throw as well as on success (this `.then` is the `finally`), and
  // drop the key once the queue drains so the map can't grow without bound.
  const next: Promise<void> = result.then(() => {}, () => {})
  chains.set(userId, next)
  next.then(() => { if (chains.get(userId) === next) chains.delete(userId) })

  return result
}
