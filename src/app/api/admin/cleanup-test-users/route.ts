import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import fs from 'fs'
import path from 'path'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'
import { isAdmin } from '@/lib/auth/roles'
import { readJsonFile, writeJsonFileAtomic } from '@/lib/util/jsonStore'
import { DATA_DIR } from '@/lib/util/dataDir'

/**
 * One-shot tidy-up for throwaway accounts created by live verification
 * (`ztest_*@verify.local`, `*@test.local`). SAFE BY CONSTRUCTION: it can only
 * ever remove emails matching the test pattern below — a real account can never
 * be deleted by this route, regardless of who calls it. Requires a valid admin
 * session and an explicit confirmation token in the body.
 */
const TEST_EMAIL_RE = /@(verify|test)\.local$/i
const CONFIRM_TOKEN = 'DELETE_TEST_USERS'

type AuthUser = { id: string; email: string }

export async function POST(req: NextRequest) {
  const cookieStore = await cookies()
  const userId = getUserIdFromCookie(cookieStore.get(COOKIE_NAME)?.value)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isAdmin(userId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  if (body?.confirm !== CONFIRM_TOKEN) {
    return NextResponse.json({ error: `Missing confirmation — send { confirm: "${CONFIRM_TOKEN}" }` }, { status: 400 })
  }

  const usersFile = path.join(DATA_DIR, 'auth', 'users.json')
  const users = readJsonFile<AuthUser[]>(usersFile, [])

  const toRemove = users.filter(u => TEST_EMAIL_RE.test(u.email ?? ''))
  const keep = users.filter(u => !TEST_EMAIL_RE.test(u.email ?? ''))

  const removed: string[] = []
  for (const u of toRemove) {
    try {
      const dir = path.join(DATA_DIR, 'users', u.id)
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
      removed.push(u.email)
    } catch (err) {
      console.warn('[cleanup] failed to remove', u.email, (err as Error)?.message)
    }
  }

  if (removed.length > 0) writeJsonFileAtomic(usersFile, keep)

  return NextResponse.json({ removed, count: removed.length, kept: keep.length })
}
