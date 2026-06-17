/**
 * Path-safety guard for user IDs.
 *
 * Every place that turns a `userId` into a filesystem path must run it through
 * `assertSafeUserId` first, so a malicious/buggy id can never escape the data
 * directory (e.g. `../../etc/passwd`).
 *
 * Allowed: letters, digits and hyphens — covers UUIDs (`09dc9a99-...`) and the
 * legacy demo id (`demo`). Anything containing `/`, `\`, `.` or other separators
 * is rejected.
 */
const SAFE_ID_RE = /^[a-z0-9-]+$/i

export function isSafeUserId(userId: unknown): userId is string {
  return typeof userId === 'string' && userId.length > 0 && userId.length <= 128 && SAFE_ID_RE.test(userId)
}

export function assertSafeUserId(userId: unknown): string {
  if (!isSafeUserId(userId)) throw new Error(`Invalid userId: ${String(userId)}`)
  return userId
}
