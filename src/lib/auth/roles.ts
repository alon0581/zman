/**
 * Admin role check — reads the comma-separated ADMIN_USER_IDS env var.
 * Fails closed: if the env var is unset or empty, no one is an admin.
 */

export function isAdmin(userId: string): boolean {
  const raw = process.env.ADMIN_USER_IDS
  if (!raw) return false

  const ids = raw.split(',').map(id => id.trim()).filter(Boolean)
  if (ids.length === 0) return false

  return ids.includes(userId)
}
