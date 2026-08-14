import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'
import { assertSafeUserId } from '@/lib/util/safeUserId'
import { readJsonFile, writeJsonFileAtomic } from '@/lib/util/jsonStore'
import { withUserLock } from '@/lib/store/lock'
import { mirrorProfileToMemory } from '@/lib/store/profileMirror'
import { DATA_DIR } from '@/lib/util/dataDir'
import path from 'path'
import { UserProfile } from '@/types'

const DEFAULT_PROFILE = (userId: string): UserProfile => ({
  user_id: userId,
  autonomy_mode: 'hybrid',
  theme: 'dark',
  voice_response_enabled: false,
  language: 'en',
  onboarding_completed: true,
  productivity_peak: 'morning',
})

function profileFile(userId: string) {
  return path.join(DATA_DIR, 'users', assertSafeUserId(userId),'profile.json')
}

function readProfile(userId: string): UserProfile {
  return readJsonFile<UserProfile>(profileFile(userId), DEFAULT_PROFILE(userId))
}

function writeProfile(userId: string, profile: UserProfile) {
  writeJsonFileAtomic(profileFile(userId), profile)
}

async function getAuthUserId(req: NextRequest): Promise<string | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(COOKIE_NAME)?.value
  return getUserIdFromCookie(token) // null if not logged in
}

export async function GET(req: NextRequest) {
  const userId = await getAuthUserId(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const profile = readProfile(userId)
  // Never return the encrypted key to the frontend
  const { ai_api_key_encrypted: _, ...safeProfile } = profile
  return NextResponse.json(safeProfile)
}

export async function POST(req: NextRequest) {
  const userId = await getAuthUserId(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as Record<string, unknown>

  // Handle disconnect: clear all AI credentials (legacy fields — per-user API
  // keys were removed; Settings never shipped a UI to set one)
  if (body.ai_api_key_clear) {
    delete body.ai_api_key_clear
    body.ai_api_key_encrypted = undefined
    body.ai_api_key_masked = undefined
    body.ai_provider = undefined
    body.ai_model = undefined
  }

  // A mutex only works if every writer joins it. This read-modify-write is
  // synchronous and therefore safe on its own, but the cron takes the same lock
  // around its write — without joining here, this handler could still land in
  // the middle of that and lose one of the two updates.
  // Returns the pre-merge profile too — the onboarding block below detects the
  // *transition* to onboarding_completed, so it needs the value from before this
  // write, not after it.
  const updates = body as Partial<UserProfile>
  const { existing, profile } = await withUserLock(userId, () => {
    const previous = readProfile(userId)
    const merged: UserProfile = { ...previous, ...updates, user_id: userId }
    writeProfile(userId, merged)
    return { existing: previous, profile: merged }
  })

  // Mirror the profile fields that ALSO live in memory, so the two cannot
  // contradict each other.
  //
  // This used to fire only on the one-time transition to onboarding_completed,
  // which meant every later Settings save wrote profile.json alone — leaving a
  // stale memory row (e.g. productivity_peak: morning) injected into every prompt
  // forever, with no timestamp for the model to arbitrate against the new value.
  // Now every write mirrors what it actually changed.
  const isOnboardingTransition = !existing.onboarding_completed && updates.onboarding_completed === true
  mirrorProfileToMemory(
    userId,
    profile,
    // On the transition, mirror everything present; otherwise only what changed.
    isOnboardingTransition ? undefined : (Object.keys(updates) as (keyof UserProfile)[]),
    isOnboardingTransition ? 'onboarding' : 'explicit',
  )

  // Never return the encrypted key to the frontend
  const { ai_api_key_encrypted: _, ...safeProfile } = profile
  return NextResponse.json(safeProfile)
}
