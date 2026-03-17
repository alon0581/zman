import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import SettingsClient from './SettingsClient'
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
  onboarding_completed: true,
  productivity_peak: 'morning',
})

function loadUserProfile(userId: string): UserProfile {
  try {
    const file = path.join(process.cwd(), 'data', 'users', userId, 'profile.json')
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch { /* use default */ }
  return DEFAULT_PROFILE(userId)
}

export default async function SettingsPage() {
  if (DEMO_MODE) {
    const cookieStore = await cookies()
    const token = cookieStore.get(COOKIE_NAME)?.value
    const userId = getUserIdFromCookie(token)
    if (!userId) redirect('/login')

    const rawProfile = loadUserProfile(userId)
    // Never pass the encrypted key to the client component
    const { ai_api_key_encrypted: _demo, ...profile } = rawProfile
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const user = { id: userId, email: '', user_metadata: {}, app_metadata: {}, aud: 'authenticated', created_at: '', updated_at: '', role: '' } as any
    return <SettingsClient user={user} profile={profile} />
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: rawProfileSupabase } = await supabase
    .from('user_profiles').select('*').eq('user_id', user.id).single()

  // Never pass the encrypted key to the client component
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { ai_api_key_encrypted: _sb, ...profileSb } = (rawProfileSupabase ?? {}) as import('@/types').UserProfile

  return <SettingsClient user={user} profile={profileSb as import('@/types').UserProfile} />
}
