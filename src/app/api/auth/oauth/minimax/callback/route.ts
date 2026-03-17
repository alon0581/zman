import { NextRequest, NextResponse } from 'next/server'
import { consumePending } from '@/lib/oauth'
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
  const state = searchParams.get('state')
  const error = searchParams.get('error')

  if (error || !code || !state) {
    return NextResponse.redirect(`${APP_URL}/settings?oauth_error=${encodeURIComponent(error ?? 'missing_code')}`)
  }

  const pendingData = consumePending(state)
  if (!pendingData) {
    return NextResponse.redirect(`${APP_URL}/settings?oauth_error=invalid_state`)
  }

  // Verify the userId from the session still matches
  let sessionUserId: string | null = null
  if (DEMO_MODE) {
    const cookieStore = await cookies()
    const token = cookieStore.get(COOKIE_NAME)?.value
    sessionUserId = getUserIdFromCookie(token)
  } else {
    const { createClient } = await import('@/lib/supabase/server')
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    sessionUserId = user?.id ?? null
  }
  if (!sessionUserId || sessionUserId !== pendingData.userId) {
    return NextResponse.redirect(`${APP_URL}/settings?oauth_error=session_mismatch`)
  }

  try {
    // Exchange code for access_token with MiniMax
    const tokenRes = await fetch('https://api.minimaxi.chat/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        code_verifier: pendingData.verifier,
        grant_type: 'authorization_code',
        client_id: process.env.MINIMAX_OAUTH_CLIENT_ID,
        client_secret: process.env.MINIMAX_OAUTH_CLIENT_SECRET,
        redirect_uri: `${APP_URL}/api/auth/oauth/minimax/callback`,
      }),
    })

    if (!tokenRes.ok) {
      const err = await tokenRes.text()
      console.error('MiniMax token exchange failed:', err)
      return NextResponse.redirect(`${APP_URL}/settings?oauth_error=token_exchange_failed`)
    }

    const { access_token } = await tokenRes.json() as { access_token: string }

    // Save the access_token as the API key (MiniMax token = API key for their API)
    if (DEMO_MODE) {
      const profile = readProfile(sessionUserId)
      const updated: UserProfile = {
        ...profile,
        ai_provider: 'minimax',
        ai_model: profile.ai_model ?? 'MiniMax-M1',
        ai_api_key_encrypted: encryptApiKey(access_token),
        ai_api_key_masked: maskApiKey(access_token),
      }
      writeProfile(sessionUserId, updated)
    } else {
      const { createClient } = await import('@/lib/supabase/server')
      const supabase = await createClient()
      await supabase.from('user_profiles').upsert({
        user_id: sessionUserId,
        ai_provider: 'minimax',
        ai_model: 'MiniMax-M1',
        ai_api_key_encrypted: encryptApiKey(access_token),
        ai_api_key_masked: maskApiKey(access_token),
      })
    }

    return NextResponse.redirect(`${APP_URL}/settings?oauth_success=minimax`)
  } catch (err) {
    console.error('MiniMax OAuth callback error:', err)
    return NextResponse.redirect(`${APP_URL}/settings?oauth_error=internal_error`)
  }
}

export const dynamic = 'force-dynamic'
