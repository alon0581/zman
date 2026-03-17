import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'
import { encryptApiKey, maskApiKey } from '@/lib/encryption'
import fs from 'fs'
import path from 'path'
import { UserProfile } from '@/types'

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
  const profile: UserProfile = { ...existing, ...(body as Partial<UserProfile>), user_id: userId }
  writeProfile(userId, profile)

  // Never return the encrypted key to the frontend
  const { ai_api_key_encrypted: _, ...safeProfile } = profile
  return NextResponse.json(safeProfile)
}
