import { NextRequest, NextResponse } from 'next/server'
import { encryptApiKey, maskApiKey } from '@/lib/encryption'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'
import { cookies } from 'next/headers'
import { UserProfile } from '@/types'
import fs from 'fs'
import path from 'path'

const DEMO_MODE = !process.env.NEXT_PUBLIC_SUPABASE_URL?.startsWith('http')
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

function profileFile(userId: string) {
  return path.join(process.cwd(), 'data', 'users', userId, 'profile.json')
}

function readProfile(userId: string): UserProfile {
  try {
    const file = profileFile(userId)
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8')) as UserProfile
  } catch { /* ignore */ }
  return { user_id: userId, autonomy_mode: 'hybrid', theme: 'dark', voice_response_enabled: false, language: 'en', onboarding_completed: true }
}

function writeProfile(userId: string, profile: UserProfile) {
  const dir = path.dirname(profileFile(userId))
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(profileFile(userId), JSON.stringify(profile, null, 2))
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const code = searchParams.get('code')
  const error = searchParams.get('error')

  if (error || !code) {
    return NextResponse.redirect(`${APP_URL}/settings?oauth_error=${encodeURIComponent(error ?? 'missing_code')}`)
  }

  // Get current user from session
  let userId: string | null = null
  if (DEMO_MODE) {
    const cookieStore = await cookies()
    const token = cookieStore.get(COOKIE_NAME)?.value
    userId = getUserIdFromCookie(token)
  } else {
    const { createClient } = await import('@/lib/supabase/server')
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    userId = user?.id ?? null
  }
  if (!userId) {
    return NextResponse.redirect(`${APP_URL}/login`)
  }

  try {
    // Exchange the code for an OpenRouter API key
    // OpenRouter's key exchange endpoint: POST /api/v1/auth/keys with { code }
    const keyRes = await fetch('https://openrouter.ai/api/v1/auth/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })

    if (!keyRes.ok) {
      const err = await keyRes.text()
      console.error('OpenRouter key exchange failed:', err)
      return NextResponse.redirect(`${APP_URL}/settings?oauth_error=key_exchange_failed`)
    }

    let key: string
    try {
      const body = await keyRes.json() as { key?: string }
      key = body.key ?? ''
    } catch {
      return NextResponse.redirect(`${APP_URL}/settings?oauth_error=invalid_response`)
    }

    if (!key) {
      return NextResponse.redirect(`${APP_URL}/settings?oauth_error=no_key_returned`)
    }

    // Save encrypted key to profile with openrouter provider
    if (DEMO_MODE) {
      const profile = readProfile(userId)
      const updated: UserProfile = {
        ...profile,
        ai_provider: 'openrouter',
        // Default to GPT-4o via OpenRouter; user can change in settings
        ai_model: profile.ai_provider === 'openrouter' ? (profile.ai_model ?? 'openai/gpt-4o-mini') : 'openai/gpt-4o-mini',
        ai_api_key_encrypted: encryptApiKey(key),
        ai_api_key_masked: maskApiKey(key),
      }
      writeProfile(userId, updated)
    } else {
      const { createClient } = await import('@/lib/supabase/server')
      const supabase = await createClient()
      const { data: existingProfile } = await supabase
        .from('user_profiles').select('ai_model, ai_provider').eq('user_id', userId).single()
      const currentModel = existingProfile?.ai_provider === 'openrouter'
        ? (existingProfile?.ai_model ?? 'openai/gpt-4o-mini')
        : 'openai/gpt-4o-mini'
      await supabase.from('user_profiles').upsert({
        user_id: userId,
        ai_provider: 'openrouter',
        ai_model: currentModel,
        ai_api_key_encrypted: encryptApiKey(key),
        ai_api_key_masked: maskApiKey(key),
      })
    }

    return NextResponse.redirect(`${APP_URL}/settings?oauth_success=openrouter`)
  } catch (err) {
    console.error('OpenRouter OAuth callback error:', err)
    return NextResponse.redirect(`${APP_URL}/settings?oauth_error=internal_error`)
  }
}

export const dynamic = 'force-dynamic'
