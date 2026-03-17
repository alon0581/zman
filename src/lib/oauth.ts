import crypto from 'crypto'

export function generateState(): string {
  return crypto.randomBytes(16).toString('hex')
}

export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

// ── In-memory pending store ───────────────────────────────────────────────────
// Stores state → { verifier, userId, provider } during the OAuth roundtrip.
// TTL: 10 minutes. Works for single-process dev; for multi-instance prod use Redis.

interface PendingEntry {
  verifier: string
  userId: string
  provider: string
}

const pending = new Map<string, PendingEntry>()

export function savePending(state: string, data: PendingEntry): void {
  pending.set(state, data)
  setTimeout(() => pending.delete(state), 10 * 60 * 1000)
}

export function consumePending(state: string): PendingEntry | undefined {
  const data = pending.get(state)
  pending.delete(state)
  return data
}
