import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import AppShell from '@/components/AppShell'
import { UserProfile, AIMemory, CalendarEvent } from '@/types'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'
import { DATA_DIR } from '@/lib/util/dataDir'
import { readJsonFile, writeJsonFileAtomic } from '@/lib/util/jsonStore'
import { withUserLock } from '@/lib/store/lock'
import { mapToMethod, SchedulingMethod } from '@/lib/scheduling/methodMapper'
import path from 'path'

const DEMO_MODE = !process.env.NEXT_PUBLIC_SUPABASE_URL?.startsWith('http')

const DEFAULT_PROFILE = (userId: string): UserProfile => ({
  user_id: userId,
  autonomy_mode: 'hybrid',
  theme: 'dark',
  voice_response_enabled: false,
  language: 'en',
  onboarding_completed: false,
  productivity_peak: 'morning',
})

function loadUserProfile(userId: string): UserProfile {
  // readJsonFile, not a bare try/catch: a corrupt profile.json must be backed up
  // rather than silently become the default — the auto-heal below writes the
  // profile straight back, which would otherwise clobber the damaged original.
  return readJsonFile<UserProfile>(path.join(DATA_DIR, 'users', userId, 'profile.json'), DEFAULT_PROFILE(userId))
}

function loadMemory(userId: string): AIMemory[] {
  const mem = readJsonFile<AIMemory[]>(path.join(DATA_DIR, 'users', userId, 'memory.json'), [])
  return Array.isArray(mem) ? mem : []
}

/** True if the user already has events or memory — proof they've used the app before */
function userHasData(userId: string): boolean {
  const dir = path.join(DATA_DIR, 'users', userId)
  const evts = readJsonFile<CalendarEvent[]>(path.join(dir, 'events.json'), [])
  if (Array.isArray(evts) && evts.length > 0) return true
  const mem = readJsonFile<AIMemory[]>(path.join(dir, 'memory.json'), [])
  return Array.isArray(mem) && mem.length > 0
}

export default async function AppPage() {
  if (DEMO_MODE) {
    // Custom file-based auth — check session cookie
    const cookieStore = await cookies()
    const token = cookieStore.get(COOKIE_NAME)?.value
    const userId = getUserIdFromCookie(token)

    if (!userId) redirect('/login')

    const uid = userId

    // One critical section for load → auto-heal → backfill. Both fixes below read
    // profile.json and write it straight back, so an interleaved writer (OAuth
    // callback, cron) must not land in between and lose its update.
    const profile = await withUserLock(uid, () => {
      let prof = loadUserProfile(uid)

      // Auto-heal: if the flag is still false but the user clearly has data (events/memory),
      // they already completed onboarding — fix the flag and persist it so it never recurs.
      if (!prof.onboarding_completed && userHasData(uid)) {
        prof = { ...prof, onboarding_completed: true }
        try {
          const profFile = path.join(DATA_DIR, 'users', uid, 'profile.json')
          writeJsonFileAtomic(profFile, prof)
        } catch { /* ignore write errors */ }
      }

      // Backfill a scheduling method so the method-selection modal stops appearing on
      // EVERY login. The modal only clears when the AI reliably calls complete_onboarding;
      // if that ever fails, scheduling_method stays empty and the user gets nagged forever.
      // Derive a method from what we already learned (persona/challenge/day in memory),
      // else fall back to a sensible default. The user can still change it in Settings.
      if (prof.onboarding_completed && !prof.scheduling_method) {
        const mem = loadMemory(uid)
        const val = (k: string) => mem.find(m => m.key === k)?.value
        const persona = val('persona_type')
        const challenge = val('main_challenge')
        const day = val('day_structure')
        let primary: SchedulingMethod = 'time_blocking'
        let secondary: SchedulingMethod[] = []
        if (persona && challenge && day) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const r = mapToMethod(persona as any, challenge as any, day as any)
            primary = r.primary
            secondary = r.secondary
          } catch { /* keep default */ }
        }
        prof = { ...prof, scheduling_method: primary, secondary_methods: secondary }
        try {
          const profFile = path.join(DATA_DIR, 'users', uid, 'profile.json')
          writeJsonFileAtomic(profFile, prof)
        } catch { /* ignore write errors */ }
      }

      return prof
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const user = { id: userId, email: '', user_metadata: {}, app_metadata: {}, aud: 'authenticated', created_at: '', updated_at: '', role: '' } as any
    return <AppShell user={user} profile={profile} needsOnboarding={!profile.onboarding_completed} />
  }

  // Production: Supabase auth
  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('user_profiles').select('*').eq('user_id', user.id).single()

  if (!profile) {
    await supabase.from('user_profiles').insert({
      user_id: user.id,
      autonomy_mode: 'hybrid',
      theme: 'dark',
      voice_response_enabled: false,
      language: 'en',
      onboarding_completed: false,
    })
  }

  return <AppShell user={user} profile={profile} needsOnboarding={!profile?.onboarding_completed} />
}
