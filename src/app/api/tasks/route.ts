import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { userStore } from '@/lib/store/userStore'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'
import { Task } from '@/types'

async function getAuthUserId(): Promise<string | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(COOKIE_NAME)?.value
  return getUserIdFromCookie(token)
}

export async function GET() {
  const userId = await getAuthUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const tasks = userStore.getTasks(userId)
  return NextResponse.json({ tasks })
}

export async function POST(req: NextRequest) {
  const userId = await getAuthUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined)

  const title = str(body.title)
  if (!title) return NextResponse.json({ error: 'title is required' }, { status: 400 })

  const task: Task = {
    id: crypto.randomUUID(),
    user_id: userId,
    title,
    description: str(body.description),
    deadline: str(body.deadline),
    estimated_hours: typeof body.estimated_hours === 'number' && body.estimated_hours > 0 ? body.estimated_hours : undefined,
    priority: (['low', 'medium', 'high'].includes(body.priority) ? body.priority : 'medium') as Task['priority'],
    status: 'pending',
    topic: str(body.topic),
    parent_task_id: str(body.parent_task_id),
    // Without these two a task created through the API could never join a project
    // or carry an ordering constraint — the board would be able to show work it
    // had no way to create.
    project_id: str(body.project_id),
    depends_on: Array.isArray(body.depends_on)
      ? body.depends_on.filter((d: unknown): d is string => typeof d === 'string' && !!d.trim())
      : undefined,
    created_at: new Date().toISOString(),
  }

  userStore.addTask(task, userId)
  return NextResponse.json({ task })
}
