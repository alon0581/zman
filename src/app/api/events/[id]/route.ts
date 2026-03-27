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

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getAuthUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const body = await req.json()
  const { title, color, start_time, end_time, mobility_type } = body as Record<string, string>

  const changes: Record<string, string> = {}
  if (title)         changes.title         = title
  if (color)         changes.color         = color
  if (start_time)    changes.start_time    = start_time
  if (end_time)      changes.end_time      = end_time
  if (mobility_type) changes.mobility_type = mobility_type

  if (DEMO_MODE) {
    demoStorage.updateEvent(id, changes, userId)
    return NextResponse.json({ success: true })
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  const { error } = await supabase
    .from('events')
    .update(changes)
    .eq('id', id)
    .eq('user_id', userId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getAuthUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  if (DEMO_MODE) {
    demoStorage.deleteEvent(id, userId)
    return NextResponse.json({ success: true })
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  const { error } = await supabase
    .from('events')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
