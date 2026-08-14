import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { userStore } from '@/lib/store/userStore'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'
import { Project } from '@/types'
import { planProjectDeletion } from '@/lib/projects/cascade'

async function getAuthUserId(): Promise<string | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(COOKIE_NAME)?.value
  return getUserIdFromCookie(token)
}

const STATUSES: Project['status'][] = ['active', 'paused', 'done', 'archived']

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getAuthUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const body = await req.json()
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined)

  // Whitelisted, deliberately breaking from the tasks/[id] template — that one
  // spreads the raw body into the store, so a client can rewrite id or user_id.
  // `kind` is absent on purpose: it decides what the risk badge MEANS, and
  // changing it would retroactively rewrite data the user has already read.
  const updates: Partial<Project> = {}
  if (str(body.title) !== undefined) updates.title = str(body.title)
  if (str(body.description) !== undefined) updates.description = str(body.description)
  if (str(body.color) !== undefined) updates.color = str(body.color)
  if (str(body.topic) !== undefined) updates.topic = str(body.topic)
  if (STATUSES.includes(body.status)) {
    updates.status = body.status
    if (body.status === 'done') updates.completed_at = new Date().toISOString()
    if (body.status === 'archived') updates.archived_at = new Date().toISOString()
  }
  // Deadline is the one field that must be clearable: `null` removes it, which is
  // meaningful (a project with no date reads as 'na', never as "on track").
  if (body.deadline === null) updates.deadline = undefined
  else if (str(body.deadline) !== undefined) updates.deadline = str(body.deadline)

  const project = userStore.updateProject(id, updates, userId)
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json({ project })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getAuthUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const projects = userStore.getProjects(userId)
  const project = projects.find(p => p.id === id)
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Default is `detach` — the least destructive option. Calendar blocks are never
  // touched in either mode; see cascade.ts.
  const mode = req.nextUrl.searchParams.get('cascade') === 'tasks' ? 'cascade' : 'detach'
  const plan = planProjectDeletion(
    project,
    userStore.getTasks(userId),
    userStore.getEvents(userId),
    mode,
  )

  for (const taskId of plan.deleteTaskIds) userStore.deleteTask(taskId, userId)
  for (const taskId of plan.detachTaskIds) {
    userStore.updateTask(taskId, { project_id: undefined }, userId)
  }
  userStore.deleteProject(id, userId)

  return NextResponse.json({
    success: true,
    deleted_tasks: plan.deleteTaskIds.length,
    detached_tasks: plan.detachTaskIds.length,
    untouched_events: plan.untouchedEvents,
  })
}
