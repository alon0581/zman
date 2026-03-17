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
import fs from 'fs'
import path from 'path'

// Secret for signing tokens — set AUTH_SECRET in .env.local for production
const SECRET = process.env.AUTH_SECRET ?? 'zman-dev-secret-please-change-me'

const DATA_DIR   = path.join(process.cwd(), 'data')
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
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function readUsers(): StoredUser[] {
  try {
    ensureDir(path.dirname(USERS_FILE))
    if (!fs.existsSync(USERS_FILE)) return []
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'))
  } catch {
    return []
  }
}

function writeUsers(users: StoredUser[]) {
  ensureDir(path.dirname(USERS_FILE))
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2))
}

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex')
}

function makeToken(userId: string): string {
  const expiry  = Date.now() + COOKIE_MAX_AGE * 1000
  const payload = `${userId}:${expiry}`
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
    if (sig !== expected) return null
    const parts  = payload.split(':')
    const expiry = parseInt(parts[parts.length - 1])
    if (isNaN(expiry) || Date.now() > expiry) return null
    return parts.slice(0, -1).join(':') // userId (may contain colons for UUID)
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

  users.push({ id, email: email.toLowerCase().trim(), passwordHash, salt, createdAt: new Date().toISOString() })
  writeUsers(users)

  return { success: true, userId: id, token: makeToken(id) }
}

export function loginUser(
  email: string,
  password: string
): { success: true; userId: string; token: string } | { success: false; error: string } {
  const users = readUsers()
  const user  = users.find(u => u.email === email.toLowerCase().trim())
  if (!user) return { success: false, error: 'אימייל או סיסמה שגויים' }

  const hash = hashPassword(password, user.salt)
  if (hash !== user.passwordHash) return { success: false, error: 'אימייל או סיסמה שגויים' }

  return { success: true, userId: user.id, token: makeToken(user.id) }
}

/** Reset password — no old password required (for "forgot password" flow) */
export function resetPassword(
  email: string,
  newPassword: string
): { success: true } | { success: false; error: string } {
  const users = readUsers()
  const idx   = users.findIndex(u => u.email === email.toLowerCase().trim())
  if (idx === -1) return { success: false, error: 'אימייל לא נמצא במערכת' }
  if (newPassword.length < 6) return { success: false, error: 'הסיסמה חייבת להכיל לפחות 6 תווים' }

  const salt         = crypto.randomBytes(16).toString('hex')
  const passwordHash = hashPassword(newPassword, salt)
  users[idx] = { ...users[idx], salt, passwordHash }
  writeUsers(users)
  return { success: true }
}

/** Extract userId from cookie value — returns null if invalid/expired */
export function getUserIdFromCookie(cookieValue: string | undefined): string | null {
  if (!cookieValue) return null
  return verifyToken(cookieValue)
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
