import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'
import { generateState, savePending } from '@/lib/oauth'

const DEMO_MODE = !process.env.NEXT_PUBLIC_SUPABASE_URL?.startsWith('http')

export async function GET(req: NextRequest) {
  // Auth check
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
  if (!userId) return new Response('Unauthorized', { status: 401 })

  const state = generateState()
  // OpenRouter doesn't use PKCE for key exchange — just state for CSRF protection
  savePending(state, { verifier: '', userId, provider: 'openrouter' })

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  const callbackUrl = `${appUrl}/api/auth/oauth/openrouter/callback`

  // OpenRouter's simple OAuth flow — just needs callback_url + optional state
  const params = new URLSearchParams({
    callback_url: callbackUrl,
  })

  return NextResponse.redirect(`https://openrouter.ai/auth?${params}`)
}

export const dynamic = 'force-dynamic'
