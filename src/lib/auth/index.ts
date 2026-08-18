/**
 * File-based auth: scrypt password hashing + HMAC-signed session tokens.
 * No external dependencies — uses Node.js built-in `crypto` only.
 *
 * Data layout:
 *   data/auth/users.json                 — credential store
 *   data/users/{userId}/events.json      — per-user events
 *   data/users/{userId}/profile.json     — per-user profile
 */

import crypto from 'crypto'
import path from 'path'
import { readJsonFile, writeJsonFileAtomic } from '@/lib/util/jsonStore'
import { DATA_DIR } from '@/lib/util/dataDir'

/**
 * Constant-time string compare — avoids leaking match progress via timing.
 *
 * Exported so that any other credential check in the app uses this rather than
 * `!==`. `/api/cron/notifications` predates this and still compares its secret
 * with a plain `!==`; new machine-callable routes must not copy that.
 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

// Secret for signing tokens — set AUTH_SECRET in .env.local for production
const DEFAULT_SECRET = 'zman-dev-secret-please-change-me'
const SECRET = process.env.AUTH_SECRET ?? DEFAULT_SECRET

if (process.env.NODE_ENV === 'production' && SECRET === DEFAULT_SECRET) {
  throw new Error('[AUTH] FATAL: AUTH_SECRET is not set in production. Set AUTH_SECRET in Railway environment variables.')
}

// ─── Rate limiting ──────────────────────────────────────────────────────────
// Simple in-memory store: key → [timestamp, attempts]
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_WINDOW_MS = 15 * 60 * 1000  // 15 minutes
const RATE_MAX_LOGIN  = 10  // max login attempts per window
const RATE_MAX_REGISTER = 5  // max registrations per window

export function checkRateLimit(key: string, max: number): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now()
  const entry = rateLimitMap.get(key)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS })
    return { allowed: true, retryAfterMs: 0 }
  }
  entry.count++
  if (entry.count > max) {
    return { allowed: false, retryAfterMs: entry.resetAt - now }
  }
  return { allowed: true, retryAfterMs: 0 }
}

export { RATE_MAX_LOGIN, RATE_MAX_REGISTER }

const USERS_FILE = path.join(DATA_DIR, 'auth', 'users.json')

export const COOKIE_NAME    = 'zman_session'
export const COOKIE_MAX_AGE = 30 * 24 * 60 * 60 // 30 days in seconds

// ─── Internal types ────────────────────────────────────────────────────────

interface StoredUser {
  id: string
  email: string
  passwordHash: string
  salt: string
  createdAt: string
  /** Bumped on logout to revoke every token already issued. Absent on records
   *  written before revocation existed — read it as 0, never as undefined. */
  tokenVersion?: number
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function readUsers(): StoredUser[] {
  return readJsonFile<StoredUser[]>(USERS_FILE, [])
}

function writeUsers(users: StoredUser[]) {
  writeJsonFileAtomic(USERS_FILE, users)
}

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex')
}

/** Current revocation counter for a user. A record with no `tokenVersion` — and
 *  a user we can't find at all — reads as 0, so pre-revocation tokens keep working. */
function currentTokenVersion(userId: string): number {
  const user = readUsers().find(u => u.id === userId)
  return user?.tokenVersion ?? 0
}

// Marks a payload that carries a tokenVersion. Tokens minted before revocation
// existed have no prefix and are read as version 0 (see verifyToken).
const TOKEN_PREFIX = 'v2'

function makeToken(userId: string, tokenVersion: number): string {
  const expiry  = Date.now() + COOKIE_MAX_AGE * 1000
  const payload = `${TOKEN_PREFIX}:${userId}:${expiry}:${tokenVersion}`
  const sig     = crypto.createHmac('sha256', SECRET).update(payload).digest('hex')
  return Buffer.from(`${payload}:${sig}`).toString('base64url')
}

function verifyToken(token: string): string | null {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf-8')
    const lastColon = decoded.lastIndexOf(':')
    if (lastColon === -1) return null
    const payload = decoded.slice(0, lastColon)
    const sig     = decoded.slice(lastColon + 1)
    const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('hex')
    if (!safeEqual(sig, expected)) return null
    // v2 payload: `v2:{userId}:{expiry}:{tokenVersion}`. Legacy: `{userId}:{expiry}`.
    // The prefix is inside the signed payload, so it can't be added or stripped.
    const isVersioned = payload.startsWith(`${TOKEN_PREFIX}:`)
    const parts = (isVersioned ? payload.slice(TOKEN_PREFIX.length + 1) : payload).split(':')
    const tokenVersion = isVersioned ? parseInt(parts.pop() ?? '') : 0
    if (isNaN(tokenVersion)) return null
    const expiry = parseInt(parts[parts.length - 1])
    if (isNaN(expiry) || Date.now() > expiry) return null
    const userId = parts.slice(0, -1).join(':') // userId (may contain colons for UUID)
    if (userId === '') return null
    // Stale version = the user logged out after this token was minted → revoked.
    // Checked last so a junk token never costs a users.json read.
    if (tokenVersion !== currentTokenVersion(userId)) return null
    return userId
  } catch {
    return null
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function registerUser(
  email: string,
  password: string
): { success: true; userId: string; token: string } | { success: false; error: string } {
  const users    = readUsers()
  const existing = users.find(u => u.email === email.toLowerCase().trim())
  if (existing) return { success: false, error: 'כתובת המייל כבר רשומה במערכת' }

  const salt         = crypto.randomBytes(16).toString('hex')
  const passwordHash = hashPassword(password, salt)
  const id           = crypto.randomUUID()

  users.push({ id, email: email.toLowerCase().trim(), passwordHash, salt, createdAt: new Date().toISOString(), tokenVersion: 0 })
  writeUsers(users)

  return { success: true, userId: id, token: makeToken(id, 0) }
}

export function loginUser(
  email: string,
  password: string
): { success: true; userId: string; token: string } | { success: false; error: string } {
  const users = readUsers()
  const user  = users.find(u => u.email === email.toLowerCase().trim())
  if (!user) return { success: false, error: 'אימייל או סיסמה שגויים' }

  const hash = hashPassword(password, user.salt)
  if (!safeEqual(hash, user.passwordHash)) return { success: false, error: 'אימייל או סיסמה שגויים' }

  return { success: true, userId: user.id, token: makeToken(user.id, user.tokenVersion ?? 0) }
}

/**
 * Revoke every token already issued to a user by bumping their `tokenVersion`.
 * Called on logout: clearing the cookie only drops this browser's copy, while the
 * signed token itself stays valid until its 30-day expiry unless the version moves.
 * Never throws — logout must succeed even when the store is unwritable.
 */
export function revokeUserSessions(userId: string): { success: true } | { success: false; error: string } {
  try {
    const users = readUsers()
    const idx   = users.findIndex(u => u.id === userId)
    if (idx === -1) return { success: false, error: 'משתמש לא נמצא' }

    users[idx] = { ...users[idx], tokenVersion: (users[idx].tokenVersion ?? 0) + 1 }
    writeUsers(users)
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error)?.message ?? 'שגיאה בכתיבת קובץ המשתמשים' }
  }
}

/** Change password — requires an authenticated userId (session must already be valid) */
export function resetPassword(
  userId: string,
  newPassword: string
): { success: true } | { success: false; error: string } {
  const users = readUsers()
  const idx   = users.findIndex(u => u.id === userId)
  if (idx === -1) return { success: false, error: 'משתמש לא נמצא' }
  if (newPassword.length < 12) return { success: false, error: 'הסיסמה חייבת להכיל לפחות 12 תווים' }

  const salt         = crypto.randomBytes(16).toString('hex')
  const passwordHash = hashPassword(newPassword, salt)
  users[idx] = { ...users[idx], salt, passwordHash }
  writeUsers(users)
  return { success: true }
}

/** Extract userId from cookie value — returns null if invalid/expired/revoked */
export function getUserIdFromCookie(cookieValue: string | undefined): string | null {
  if (!cookieValue) return null
  return verifyToken(cookieValue)
}

/**
 * Email for a signed-in user, for display only (the Account card in Settings).
 * Never returns `passwordHash` or `salt` — callers get exactly this string.
 * Null when the user record is missing (e.g. a still-valid session for a
 * since-deleted account).
 */
export function getUserEmail(userId: string): string | null {
  return readUsers().find(u => u.id === userId)?.email ?? null
}

/**
 * The inverse, for callers that are configured with an email rather than a id.
 *
 * A machine caller (the iPhone Shortcut endpoint) has to name its user in an env
 * var, and a uuid there is both unreadable and unverifiable against the live
 * volume — the local copy of `users.json` carries a DIFFERENT id for the same
 * person, plus three test accounts. An email is stable, self-documenting, and
 * checkable by eye. Comparison is case-insensitive because `registerUser` does
 * not normalise case on write.
 */
export function getUserIdByEmail(email: string): string | null {
  const wanted = email.trim().toLowerCase()
  if (!wanted) return null
  return readUsers().find(u => u.email.trim().toLowerCase() === wanted)?.id ?? null
}

/** Path helpers for per-user data */
export function userDataPath(userId: string) {
  const dir = path.join(DATA_DIR, 'users', userId)
  return {
    dir,
    events:  path.join(dir, 'events.json'),
    profile: path.join(dir, 'profile.json'),
  }
}
