import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { demoStorage } from '@/lib/demo/storage'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'
import { Task } from '@/types'

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

export async function GET() {
  const userId = await getAuthUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (DEMO_MODE) {
    const tasks = demoStorage.getTasks(userId)
    return NextResponse.json({ tasks })
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('tasks').select('*').eq('user_id', userId)
    .order('created_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ tasks: data })
}

export async function POST(req: NextRequest) {
  const userId = await getAuthUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const task: Task = {
    id: crypto.randomUUID(),
    user_id: userId,
    title: body.title,
    description: body.description,
    deadline: body.deadline,
    estimated_hours: body.estimated_hours,
    priority: body.priority ?? 'medium',
    status: 'pending',
    topic: body.topic,
    parent_task_id: body.parent_task_id,
    created_at: new Date().toISOString(),
  }

  if (DEMO_MODE) {
    demoStorage.addTask(task, userId)
    return NextResponse.json({ task })
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  const { data, error } = await supabase.from('tasks').insert(task).select().single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ task: data })
}
