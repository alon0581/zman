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
