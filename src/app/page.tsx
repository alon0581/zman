import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import AppShell from '@/components/AppShell'
import { UserProfile } from '@/types'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'
import fs from 'fs'
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
  try {
    const file = path.join(process.cwd(), 'data', 'users', userId, 'profile.json')
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch { /* use default */ }
  return DEFAULT_PROFILE(userId)
}

/** True if the user already has events or memory — proof they've used the app before */
function userHasData(userId: string): boolean {
  try {
    const dir = path.join(process.cwd(), 'data', 'users', userId)
    const evFile  = path.join(dir, 'events.json')
    const memFile = path.join(dir, 'memory.json')
    if (fs.existsSync(evFile)) {
      const evts = JSON.parse(fs.readFileSync(evFile, 'utf-8'))
      if (Array.isArray(evts) && evts.length > 0) return true
    }
    if (fs.existsSync(memFile)) {
      const mem = JSON.parse(fs.readFileSync(memFile, 'utf-8'))
      if (Array.isArray(mem) && mem.length > 0) return true
    }
  } catch { /* ignore */ }
  return false
}

export default async function HomePage() {
  if (DEMO_MODE) {
    // Custom file-based auth — check session cookie
    const cookieStore = await cookies()
    const token = cookieStore.get(COOKIE_NAME)?.value
    const userId = getUserIdFromCookie(token)

    if (!userId) redirect('/login')

    let profile = loadUserProfile(userId)

    // Auto-heal: if the flag is still false but the user clearly has data (events/memory),
    // they already completed onboarding — fix the flag and persist it so it never recurs.
    if (!profile.onboarding_completed && userHasData(userId)) {
      profile = { ...profile, onboarding_completed: true }
      try {
        const profFile = path.join(process.cwd(), 'data', 'users', userId, 'profile.json')
        fs.writeFileSync(profFile, JSON.stringify(profile, null, 2))
      } catch { /* ignore write errors */ }
    }

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
