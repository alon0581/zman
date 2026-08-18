/**
 * index.test.ts — getUserEmail
 *
 * The Account card in Settings used to hardcode `email: ''` at both entry
 * points, so it rendered blank for every user. This is the one function that
 * reads the real email back out of `data/auth/users.json` — and it must never
 * surface `passwordHash` or `salt` alongside it.
 *
 * Filesystem-backed for the same reason as profileMirror.test.ts: DATA_DIR is
 * redirected to a temp dir before the module under test is imported, since it
 * reads the env at load.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP = path.join(os.tmpdir(), `zman-auth-test-${process.pid}`)

process.env.DATA_DIR = TMP
process.env.AUTH_SECRET = 'test-secret-not-for-production'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getUserEmail: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getUserIdByEmail: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let safeEqual: any

const USER_ID = 'user-1'
const EMAIL = 'alon@example.com'

beforeAll(async () => {
  const usersFile = path.join(TMP, 'auth', 'users.json')
  fs.mkdirSync(path.dirname(usersFile), { recursive: true })
  fs.writeFileSync(usersFile, JSON.stringify([
    { id: USER_ID, email: EMAIL, passwordHash: 'deadbeef', salt: 'saltsalt', createdAt: '2026-01-01T00:00:00.000Z', tokenVersion: 0 },
  ], null, 2))
  const mod = await import('./index')
  getUserEmail = mod.getUserEmail
  getUserIdByEmail = mod.getUserIdByEmail
  safeEqual = mod.safeEqual
})

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('getUserEmail', () => {
  it('returns the email for a known user id', () => {
    expect(getUserEmail(USER_ID)).toBe(EMAIL)
  })

  it('returns null for an id with no matching record', () => {
    expect(getUserEmail('no-such-user')).toBeNull()
  })

  it('never leaks passwordHash or salt', () => {
    const result = getUserEmail(USER_ID)
    expect(result).toBe(EMAIL)
    expect(String(result)).not.toMatch(/deadbeef|saltsalt/)
  })
})

describe('getUserIdByEmail', () => {
  it('resolves the id for a known email', () => {
    expect(getUserIdByEmail(EMAIL)).toBe(USER_ID)
  })

  // registerUser does not normalise case on write, so a config value typed by
  // hand must still match a record stored with different capitalisation.
  it('matches case-insensitively and ignores surrounding whitespace', () => {
    expect(getUserIdByEmail('  ALON@Example.COM  ')).toBe(USER_ID)
  })

  it('returns null rather than guessing when nothing matches', () => {
    expect(getUserIdByEmail('someone@else.com')).toBeNull()
    expect(getUserIdByEmail('')).toBeNull()
    expect(getUserIdByEmail('   ')).toBeNull()
  })

  // A partial match must never resolve: a machine caller configured with the
  // wrong email should fail closed, not write into a neighbouring account.
  it('does not match on a substring', () => {
    expect(getUserIdByEmail('alon@example.co')).toBeNull()
    expect(getUserIdByEmail('alon')).toBeNull()
  })
})

describe('safeEqual', () => {
  it('is true only for an exact match', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
  })

  // The length check has to come first: timingSafeEqual throws on a length
  // mismatch, so a wrong-length token would 500 instead of returning 401.
  it('returns false instead of throwing on differing lengths', () => {
    expect(safeEqual('short', 'muchlongervalue')).toBe(false)
    expect(safeEqual('', 'x')).toBe(false)
    expect(safeEqual('', '')).toBe(true)
  })
})
