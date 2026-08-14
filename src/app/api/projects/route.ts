import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { userStore } from '@/lib/store/userStore'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'
import { Project, ProjectKind, Task } from '@/types'
import { KIND_RULES } from '@/lib/projects/types'

async function getAuthUserId(): Promise<string | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(COOKIE_NAME)?.value
  return getUserIdFromCookie(token)
}

const KINDS: ProjectKind[] = ['course', 'deliverable', 'build']

export async function GET() {
  const userId = await getAuthUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const projects = userStore.getProjects(userId)
  return NextResponse.json({ projects })
}

export async function POST(req: NextRequest) {
  const userId = await getAuthUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined)

  const title = str(body.title)
  if (!title) return NextResponse.json({ error: 'title is required' }, { status: 400 })

  // `build` is the default because it is the kind that expects NO deadline — the
  // safe default is the one that can never render a false "on track".
  const kind: ProjectKind = KINDS.includes(body.kind) ? body.kind : 'build'

  const project: Project = {
    id: crypto.randomUUID(),
    user_id: userId,
    title,
    kind,
    status: 'active',
    description: str(body.description),
    deadline: str(body.deadline),
    color: str(body.color),
    topic: str(body.topic) ?? title,
    created_at: new Date().toISOString(),
  }

  userStore.addProject(project, userId)

  // Optionally seed the kind's template so a new project is not an empty board.
  const seeded: Task[] = []
  if (body.seed_template === true) {
    for (const item of KIND_RULES[kind].template) {
      const task: Task = {
        id: crypto.randomUUID(),
        user_id: userId,
        title: item.title,
        priority: 'medium',
        status: 'pending',
        estimated_hours: item.hours,
        topic: project.topic,
        project_id: project.id,
        deadline: project.deadline,
        created_at: new Date().toISOString(),
      }
      userStore.addTask(task, userId)
      seeded.push(task)
    }
  }

  return NextResponse.json({ project, seeded_tasks: seeded.length })
}
