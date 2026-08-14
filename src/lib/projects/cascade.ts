/**
 * cascade.ts — what deleting a project does to everything pointing at it.
 *
 * This is a pure function rather than route code for one reason: it is the
 * destructive path, and the destructive path should be the well-tested one. The
 * route executes the plan; it does not decide it. Same "decisions pure, storage
 * glue" split schedulerTools.ts established.
 *
 * The rule that shapes the whole file: CALENDAR EVENTS ARE NEVER TOUCHED. Losing
 * a week of scheduled work because you archived a course is unrecoverable on a
 * live volume with no staging and no undo. Clearing blocks is a separate, explicit
 * action the user takes on purpose.
 */

import { CalendarEvent, Project, Task } from '@/types'

export type DeletionMode = 'detach' | 'cascade'

export interface DeletionPlan {
  /** Tasks to remove outright (cascade mode only), parents and their children. */
  deleteTaskIds: string[]
  /** Tasks to keep, clearing project_id so they fall back into the plain task list. */
  detachTaskIds: string[]
  /** Events that reference this project and will be left exactly as they are. */
  untouchedEvents: number
}

/**
 * Works out what a deletion would do, without doing any of it.
 *
 * `detach` (the default) keeps every task: it only clears `project_id`, so the
 * work survives in TasksPanel where it came from. `cascade` deletes the project's
 * tasks, following `parent_task_id` one level down the same way
 * DELETE /api/tasks/[id] already does.
 */
export function planProjectDeletion(
  project: Project,
  tasks: Task[],
  events: CalendarEvent[],
  mode: DeletionMode,
): DeletionPlan {
  const owned = tasks.filter(t => t.project_id === project.id)
  const untouchedEvents = events.filter(e => e.project_id === project.id).length

  if (mode === 'detach') {
    return { deleteTaskIds: [], detachTaskIds: owned.map(t => t.id), untouchedEvents }
  }

  // Cascade: the project's tasks, plus any child pointing at one of them. Children
  // are collected from the FULL task list, not just `owned` — a subtask may never
  // have been stamped with project_id even though its parent was.
  const ownedIds = new Set(owned.map(t => t.id))
  const childIds = tasks
    .filter(t => t.parent_task_id && ownedIds.has(t.parent_task_id))
    .map(t => t.id)

  const deleteTaskIds = [...new Set([...ownedIds, ...childIds])]
  return { deleteTaskIds, detachTaskIds: [], untouchedEvents }
}
