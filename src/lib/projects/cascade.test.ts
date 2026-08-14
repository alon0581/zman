/**
 * cascade.test.ts
 *
 * This is the destructive path, on a live volume with no staging and no undo, so
 * it is a pure function specifically so it can be pinned by tests rather than
 * discovered in production.
 *
 * The load-bearing assertion is the one that appears in every block below: NO
 * MODE EVER NAMES AN EVENT. Deleting a project must not be able to take a week of
 * scheduled work with it.
 */

import { describe, expect, it } from 'vitest'
import { CalendarEvent, Project, Task } from '@/types'
import { planProjectDeletion } from './cascade'

const PROJECT_ID = 'p1'

const project: Project = {
  id: PROJECT_ID, user_id: 'u1', title: 'פרויקט', kind: 'build',
  status: 'active', created_at: '2026-08-01T00:00:00.000Z',
}

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id, user_id: 'u1', title: id, priority: 'medium', status: 'pending',
    project_id: PROJECT_ID, created_at: '2026-08-01T00:00:00.000Z', ...over,
  } as Task
}

function event(id: string, over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id, user_id: 'u1', title: id, start_time: '2026-08-14T09:00:00', end_time: '2026-08-14T10:00:00',
    is_all_day: false, source: 'zman', created_by: 'ai', status: 'confirmed',
    created_at: '2026-08-01T00:00:00.000Z', project_id: PROJECT_ID, ...over,
  } as CalendarEvent
}

describe('detach — the default, and the least destructive', () => {
  it('keeps every task and only unlinks it from the project', () => {
    const tasks = [task('a'), task('b'), task('other', { project_id: 'p2' })]
    const plan = planProjectDeletion(project, tasks, [], 'detach')

    expect(plan.deleteTaskIds).toEqual([])
    expect(plan.detachTaskIds.sort()).toEqual(['a', 'b'])
  })

  it('does not touch a task belonging to another project', () => {
    const tasks = [task('mine'), task('theirs', { project_id: 'p2' })]
    const plan = planProjectDeletion(project, tasks, [], 'detach')
    expect(plan.detachTaskIds).not.toContain('theirs')
  })
})

describe('cascade — opt-in, and still never touches the calendar', () => {
  it('deletes the project\'s own tasks', () => {
    const tasks = [task('a'), task('b'), task('other', { project_id: 'p2' })]
    const plan = planProjectDeletion(project, tasks, [], 'cascade')

    expect(plan.deleteTaskIds.sort()).toEqual(['a', 'b'])
    expect(plan.detachTaskIds).toEqual([])
  })

  it('follows parent_task_id one level down, the same way the tasks route does', () => {
    const tasks = [task('parent'), task('child', { parent_task_id: 'parent' })]
    const plan = planProjectDeletion(project, tasks, [], 'cascade')
    expect(plan.deleteTaskIds.sort()).toEqual(['child', 'parent'])
  })

  it('collects a child even when the child was never stamped with project_id', () => {
    const tasks = [task('parent'), task('orphanChild', { parent_task_id: 'parent', project_id: undefined })]
    const plan = planProjectDeletion(project, tasks, [], 'cascade')
    expect(plan.deleteTaskIds).toContain('orphanChild')
  })

  it('never lists the same task twice', () => {
    const tasks = [task('parent'), task('child', { parent_task_id: 'parent' })]
    const ids = planProjectDeletion(project, tasks, [], 'cascade').deleteTaskIds
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('calendar events are reported, never removed', () => {
  it('counts the project\'s events without ever naming one for deletion', () => {
    const events = [event('e1'), event('e2'), event('e3', { project_id: 'p2' })]

    for (const mode of ['detach', 'cascade'] as const) {
      const plan = planProjectDeletion(project, [task('a')], events, mode)
      expect(plan.untouchedEvents).toBe(2)
      // The plan's shape makes deleting an event impossible: there is no field for it.
      expect(Object.keys(plan)).toEqual(['deleteTaskIds', 'detachTaskIds', 'untouchedEvents'])
    }
  })

  it('reports zero for a project with no blocks rather than undefined', () => {
    expect(planProjectDeletion(project, [], [], 'detach').untouchedEvents).toBe(0)
  })
})
