/**
 * projectTools.ts — the decision half of `plan_project`, mirroring schedulerTools.ts.
 *
 * Pure: no fs, no fetch, no `new Date()`. It turns a project's task list into a
 * batch of PlacementRequests and hands them to the EXISTING `proposePlan` /
 * `apply_plan` machinery. There is no second approval flow and no second store —
 * a project plan is just a bigger proposal.
 */

import { Project, Task, UserProfile } from '@/types'
import { LocalISO } from '@/lib/scheduling/clock'
import { PlacementRequest } from '@/lib/scheduling/types'
import { normalizeToLocalISO } from '@/lib/scheduling/adapter'
import { KIND_RULES } from '@/lib/projects/types'
import { methodMobility, methodTitleFormatter, PlanSpec, SchedulerCtx } from './schedulerTools'

/** Below this a "session" is noise rather than work. */
const MIN_TASK_MINUTES = 15

export interface ProjectPlanBuild {
  spec?: PlanSpec
  /** Tasks deliberately left out, each with a reason the model must report. */
  skipped: { task_id: string; title: string; reason: string }[]
  /** Set when the task graph contains a cycle. Planning is refused, by name. */
  cycle?: { a: string; b: string }
  error?: string
}

/** A task nobody else claims as a parent — planning both double-counts the work. */
function leavesOf(tasks: Task[]): Task[] {
  const parentIds = new Set(tasks.map(t => t.parent_task_id).filter(Boolean))
  return tasks.filter(t => !parentIds.has(t.id))
}

/**
 * Finds a dependency cycle among the given tasks, if there is one.
 *
 * The ENGINE tolerates cycles — it breaks them and carries on, because it must
 * stay a total function. The project layer refuses them, because here there is a
 * user who can fix the data, and quietly linearising someone's task graph is a
 * worse answer than naming the two tasks that point at each other.
 */
export function findCycle(tasks: Task[]): { a: string; b: string } | null {
  const byId = new Map(tasks.map(t => [t.id, t]))
  const state = new Map<string, 'visiting' | 'done'>()

  const walk = (id: string, stack: string[]): { a: string; b: string } | null => {
    if (state.get(id) === 'done') return null
    if (state.get(id) === 'visiting') {
      const prev = stack[stack.length - 1]
      return { a: byId.get(prev)?.title ?? prev, b: byId.get(id)?.title ?? id }
    }
    state.set(id, 'visiting')
    for (const dep of byId.get(id)?.depends_on ?? []) {
      if (!byId.has(dep)) continue // out of batch: already done, or another project
      const found = walk(dep, [...stack, id])
      if (found) return found
    }
    state.set(id, 'done')
    return null
  }

  for (const t of tasks) {
    const found = walk(t.id, [])
    if (found) return found
  }
  return null
}

/**
 * Builds the engine batch for one project.
 *
 * Every exclusion is reported rather than silently dropped — the same rule the
 * engine follows for unplaced blocks. A task with no estimate is the common case
 * and the model is expected to offer to estimate it, not to guess a number and
 * schedule against the guess.
 */
export function buildProjectPlanSpec(
  project: Project,
  allTasks: Task[],
  profile: UserProfile | null | undefined,
  sched: SchedulerCtx,
  onlyTaskIds?: string[],
): ProjectPlanBuild {
  const mine = allTasks.filter(t => t.project_id === project.id)
  const scoped = onlyTaskIds?.length ? mine.filter(t => onlyTaskIds.includes(t.id)) : mine

  const cycle = findCycle(scoped)
  if (cycle) return { skipped: [], cycle }

  const projectDeadline = normalizeToLocalISO(project.deadline)
  const kind = KIND_RULES[project.kind]
  const mobility = methodMobility(profile?.scheduling_method)

  const skipped: ProjectPlanBuild['skipped'] = []
  const requests: PlacementRequest[] = []

  // Future blocks already booked per task, so re-planning does not double-book the
  // work the user has already agreed to.
  for (const task of leavesOf(scoped)) {
    if (task.status === 'done') continue

    if (!task.estimated_hours || task.estimated_hours <= 0) {
      skipped.push({
        task_id: task.id,
        title: task.title,
        reason: sched.isHe
          ? 'אין הערכת זמן — אי אפשר לשבץ בלי לדעת כמה זמן זה לוקח'
          : 'no time estimate — cannot schedule without knowing how long it takes',
      })
      continue
    }

    const deadline: LocalISO | undefined =
      normalizeToLocalISO(task.deadline) ?? projectDeadline ?? undefined

    requests.push({
      ref: { kind: 'task', id: task.id },
      title: task.title,
      totalMinutes: Math.max(MIN_TASK_MINUTES, Math.round(task.estimated_hours * 60)),
      category: kind.category,
      energy: task.priority === 'high' ? 'high' : 'medium',
      mobility,
      ...(deadline ? { deadline } : {}),
      // Only dependencies that resolve inside this batch mean anything; the engine
      // ignores the rest, and a finished prerequisite imposes no ordering.
      ...(task.depends_on?.length ? { dependsOn: task.depends_on } : {}),
      // sessionMinutes is deliberately omitted — the METHOD decides session length.
      // That is the engine's job, and the promise METHOD_LABELS made on screen.
    })
  }

  if (requests.length === 0) {
    return {
      skipped,
      error: sched.isHe
        ? 'אין מה לתכנן: לאף משימה פתוחה בפרויקט אין הערכת זמן.'
        : 'Nothing to plan: no open task in this project has a time estimate.',
    }
  }

  // The furthest deadline drives the horizon, so a task due in six weeks is not
  // judged against a two-week window.
  const latest = requests
    .map(r => r.deadline)
    .filter((d): d is LocalISO => !!d)
    .sort()
    .pop()

  return {
    skipped,
    spec: {
      requests,
      color: project.color || '#6366F1',
      mobility,
      titleFor: methodTitleFormatter(profile?.scheduling_method),
      deadline: latest,
      projectId: project.id,
    },
  }
}
