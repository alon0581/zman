import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'
import { encryptApiKey, maskApiKey } from '@/lib/encryption'
import fs from 'fs'
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
  return path.join(process.cwd(), 'data', 'users', userId, 'profile.json')
}

function readProfile(userId: string): UserProfile {
  try {
    const file = profileFile(userId)
    if (!fs.existsSync(file)) return DEFAULT_PROFILE(userId)
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return DEFAULT_PROFILE(userId)
  }
}

function writeProfile(userId: string, profile: UserProfile) {
  const dir = path.dirname(profileFile(userId))
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(profileFile(userId), JSON.stringify(profile, null, 2))
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

  const existing = readProfile(userId)
  const updates = body as Partial<UserProfile>
  const profile: UserProfile = { ...existing, ...updates, user_id: userId }
  writeProfile(userId, profile)

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
      const memFile = path.join(process.cwd(), 'data', 'users', userId, 'memory.json')
      const existing2: AIMemory[] = fs.existsSync(memFile)
        ? JSON.parse(fs.readFileSync(memFile, 'utf-8'))
        : []
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
      const dir = path.join(process.cwd(), 'data', 'users', userId)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(memFile, JSON.stringify(existing2, null, 2))
    }
  }

  // Never return the encrypted key to the frontend
  const { ai_api_key_encrypted: _, ...safeProfile } = profile
  return NextResponse.json(safeProfile)
}
