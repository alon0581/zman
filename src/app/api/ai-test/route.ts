import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'
import OpenAI from 'openai'

const DEMO_MODE = !process.env.NEXT_PUBLIC_SUPABASE_URL?.startsWith('http')

export async function POST(req: NextRequest) {
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
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { provider, model, api_key } = await req.json() as {
    provider: string
    model: string
    api_key: string
  }

  if (!api_key?.trim()) {
    return NextResponse.json({ success: false, error: 'No API key provided' })
  }

  try {
    if (provider === 'anthropic') {
      const Anthropic = (await import('@anthropic-ai/sdk')).default
      const client = new Anthropic({ apiKey: api_key })
      await client.messages.create({
        model,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Hi' }],
      })
    } else {
      // OpenAI or MiniMax (OpenAI-compatible format)
      const client = new OpenAI({
        apiKey: api_key,
        baseURL: provider === 'minimax' ? 'https://api.minimaxi.chat/v1' : undefined,
      })
      await client.chat.completions.create({
        model,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Hi' }],
      })
    }
    return NextResponse.json({ success: true })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Connection failed'
    return NextResponse.json({ success: false, error: msg })
  }
}
