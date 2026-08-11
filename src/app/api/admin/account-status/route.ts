import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import path from 'path'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'
import { isAdmin } from '@/lib/auth/roles'
import { readJsonFile } from '@/lib/util/jsonStore'
import { DATA_DIR } from '@/lib/util/dataDir'

/**
 * READ-ONLY diagnostic: reports the real (non-test) accounts and what data each
 * one actually has on the live server — so we can verify with certainty whether
 * an account + its data survived, and whether the method/onboarding screen would
 * trigger (onboarding_completed + scheduling_method). Emails are masked. Auth
 * required. No writes, no deletes.
 */
const TEST_EMAIL_RE = /@(verify|test)\.local$/i

function mask(email: string): string {
  const [name, domain] = email.split('@')
  if (!domain) return email
  return `${name.slice(0, 3)}***@${domain}`
}

type AuthUser = { id: string; email: string; createdAt?: string }

export async function GET() {
  const cookieStore = await cookies()
  const userId = getUserIdFromCookie(cookieStore.get(COOKIE_NAME)?.value)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isAdmin(userId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const users = readJsonFile<AuthUser[]>(path.join(DATA_DIR, 'auth', 'users.json'), [])
  const real = users.filter(u => !TEST_EMAIL_RE.test(u.email ?? ''))

  const accounts = real.map(u => {
    const dir = path.join(DATA_DIR, 'users', u.id)
    const events = readJsonFile<unknown[]>(path.join(dir, 'events.json'), [])
    const tasks = readJsonFile<unknown[]>(path.join(dir, 'tasks.json'), [])
    const memory = readJsonFile<{ key: string }[]>(path.join(dir, 'memory.json'), [])
    const profile = readJsonFile<Record<string, unknown> | null>(path.join(dir, 'profile.json'), null)
    return {
      email: mask(u.email),
      createdAt: u.createdAt ?? null,
      events: Array.isArray(events) ? events.length : 0,
      tasks: Array.isArray(tasks) ? tasks.length : 0,
      memoryKeys: Array.isArray(memory) ? memory.map(m => m.key) : [],
      onboarding_completed: profile?.onboarding_completed ?? null,
      scheduling_method: profile?.scheduling_method ?? null,
      ai_provider: profile?.ai_provider ?? null,
      hasProfile: !!profile,
    }
  })

  return NextResponse.json({ totalRealAccounts: real.length, accounts })
}
