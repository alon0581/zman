import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'
import { generateState, generatePKCE, savePending } from '@/lib/oauth'

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

  const { verifier, challenge } = generatePKCE()
  const state = generateState()
  savePending(state, { verifier, userId, provider: 'minimax' })

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  const clientId = process.env.MINIMAX_OAUTH_CLIENT_ID

  if (!clientId) {
    // If no client_id configured, redirect to settings with an error
    return NextResponse.redirect(`${appUrl}/settings?oauth_error=MINIMAX_CLIENT_ID+not+configured`)
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${appUrl}/api/auth/oauth/minimax/callback`,
    response_type: 'code',
    scope: 'api',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })

  // MiniMax global OAuth authorization endpoint
  return NextResponse.redirect(`https://www.minimaxi.chat/oauth/authorize?${params}`)
}

// Also handle redirect from query param `_next`
export const dynamic = 'force-dynamic'
