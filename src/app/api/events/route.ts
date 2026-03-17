import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { demoStorage } from '@/lib/demo/storage'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'

const DEMO_MODE = !process.env.NEXT_PUBLIC_SUPABASE_URL?.startsWith('http')

async function getAuthUserId(): Promise<string | null> {
  if (DEMO_MODE) {
    const cookieStore = await cookies()
    const token = cookieStore.get(COOKIE_NAME)?.value
    return getUserIdFromCookie(token)
  }
  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user?.id ?? null
}

export async function GET(req: NextRequest) {
  const userId = await getAuthUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (DEMO_MODE) {
    const events = demoStorage.getEvents(userId)
    return NextResponse.json({ events })
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()

  const { searchParams } = new URL(req.url)
  const from = searchParams.get('from') ?? new Date(Date.now() - 30 * 86400000).toISOString()
  const to = searchParams.get('to') ?? new Date(Date.now() + 90 * 86400000).toISOString()

  const { data, error } = await supabase
    .from('events').select('*').eq('user_id', userId)
    .gte('start_time', from).lte('start_time', to)
    .order('start_time', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ events: data })
}

export async function DELETE(req: NextRequest) {
  const userId = await getAuthUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await req.json()

  if (DEMO_MODE) {
    demoStorage.deleteEvent(id, userId)
    return NextResponse.json({ success: true })
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  const { error } = await supabase.from('events').delete().eq('id', id).eq('user_id', userId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
