import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { userStore } from '@/lib/store/userStore'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'

async function getAuthUserId(): Promise<string | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(COOKIE_NAME)?.value
  return getUserIdFromCookie(token)
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getAuthUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const updates = await req.json()

  userStore.updateTask(id, updates, userId)
  return NextResponse.json({ success: true })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getAuthUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  // Cascade: delete child tasks first
  const allTasks = userStore.getTasks(userId)
  for (const t of allTasks) {
    if (t.parent_task_id === id) userStore.deleteTask(t.id, userId)
  }
  userStore.deleteTask(id, userId)
  return NextResponse.json({ success: true })
}
