import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import SettingsClient from './SettingsClient'
import { UserProfile, AppUser } from '@/types'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'
import { DATA_DIR } from '@/lib/util/dataDir'
import fs from 'fs'
import path from 'path'

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
    const file = path.join(DATA_DIR, 'users', userId, 'profile.json')
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch { /* use default */ }
  return DEFAULT_PROFILE(userId)
}

export default async function SettingsPage() {
  const cookieStore = await cookies()
  const token = cookieStore.get(COOKIE_NAME)?.value
  const userId = getUserIdFromCookie(token)
  if (!userId) redirect('/login')

  const rawProfile = loadUserProfile(userId)
  // Never pass the encrypted key to the client component
  const { ai_api_key_encrypted: _demo, ...profile } = rawProfile
  const user: AppUser = { id: userId, email: '', user_metadata: {} }
  return <SettingsClient user={user} profile={profile} />
}
