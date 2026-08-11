import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import crypto from 'crypto'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'
import { encryptApiKey, maskApiKey } from '@/lib/encryption'
import { assertSafeUserId } from '@/lib/util/safeUserId'
import { readJsonFile, writeJsonFileAtomic } from '@/lib/util/jsonStore'
import { withUserLock } from '@/lib/store/lock'
import { DATA_DIR } from '@/lib/util/dataDir'
import path from 'path'
import { UserProfile, AIMemory } from '@/types'

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
  if (DEMO_MODE) {
    const cookieStore = await cookies()
    const token = cookieStore.get(COOKIE_NAME)?.value
    return getUserIdFromCookie(token) // null if not logged in
  }
  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user?.id ?? null
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

  // Handle raw API key: encrypt and mask it, never store plaintext
  if (body.ai_api_key && typeof body.ai_api_key === 'string') {
    const raw = body.ai_api_key
    body.ai_api_key_encrypted = encryptApiKey(raw)
    body.ai_api_key_masked = maskApiKey(raw)
    delete body.ai_api_key
  }

  // Handle disconnect: clear all AI credentials
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

  // When UI onboarding completes for the first time, also save key facts to memory
  if (!existing.onboarding_completed && updates.onboarding_completed === true) {
    const memoryEntries: Array<{ key: string; value: string }> = []
    if (profile.persona)           memoryEntries.push({ key: 'persona_type',       value: profile.persona })
    if (profile.challenge)         memoryEntries.push({ key: 'main_challenge',      value: profile.challenge })
    if (profile.day_structure)     memoryEntries.push({ key: 'day_structure',       value: profile.day_structure })
    if (profile.scheduling_method) memoryEntries.push({ key: 'scheduling_method',   value: profile.scheduling_method })
    if (profile.secondary_methods?.length)
                                   memoryEntries.push({ key: 'secondary_methods',   value: profile.secondary_methods.join(', ') })
    if (profile.productivity_peak) memoryEntries.push({ key: 'productivity_peak',   value: profile.productivity_peak })
    if (profile.occupation)        memoryEntries.push({ key: 'occupation',          value: profile.occupation })

    if (memoryEntries.length > 0) {
      const memFile = path.join(DATA_DIR, 'users', assertSafeUserId(userId),'memory.json')
      const existing2 = readJsonFile<AIMemory[]>(memFile, [])
      for (const entry of memoryEntries) {
        const idx = existing2.findIndex(m => m.key === entry.key)
        const item: AIMemory = {
          id: idx >= 0 ? existing2[idx].id : crypto.randomUUID(),
          user_id: userId, key: entry.key, value: entry.value,
          learned_from: 'onboarding',
          created_at: idx >= 0 ? existing2[idx].created_at : new Date().toISOString(),
        }
        if (idx >= 0) existing2[idx] = item
        else existing2.push(item)
      }
      writeJsonFileAtomic(memFile, existing2)
    }
  }

  // Never return the encrypted key to the frontend
  const { ai_api_key_encrypted: _, ...safeProfile } = profile
  return NextResponse.json(safeProfile)
}
