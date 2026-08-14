/**
 * projectTools.test.ts
 *
 * `plan_project` is the one place where a project turns into calendar time, so the
 * failure modes worth pinning are the dishonest ones: planning work twice
 * (a parent AND its children), inventing hours for a task that has none, and
 * quietly linearising a task graph the user got wrong.
 *
 * Note the deliberate asymmetry with the engine: `plan.ts` TOLERATES a dependency
 * cycle because it must stay a total function, while this layer REFUSES one —
 * here there is a user who can fix the data, and naming the two tasks is a better
 * answer than silently picking an order for them.
 */

import { describe, expect, it } from 'vitest'
import { Project, Task, UserProfile } from '@/types'
import { buildProjectPlanSpec, findCycle } from './projectTools'
import { SchedulerCtx } from './schedulerTools'

const PROJECT_ID = 'p1'

const sched: SchedulerCtx = { enabled: true, memory: [], feedback: [], isHe: true }
const profile = { scheduling_method: 'time_blocking' } as UserProfile

function project(over: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID, user_id: 'u1', title: 'פרויקט', kind: 'course',
    status: 'active', created_at: '2026-08-01T00:00:00.000Z',
    deadline: '2026-08-27T09:00:00', ...over,
  }
}

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id, user_id: 'u1', title: id, priority: 'medium', status: 'pending',
    project_id: PROJECT_ID, created_at: '2026-08-01T00:00:00.000Z',
    estimated_hours: 2, ...over,
  } as Task
}

describe('which tasks become requests', () => {
  it('skips done tasks', () => {
    const build = buildProjectPlanSpec(project(), [task('a'), task('b', { status: 'done' })], profile, sched)
    expect(build.spec!.requests).toHaveLength(1)
    expect(build.spec!.requests[0].ref.id).toBe('a')
  })

  it('plans the children, never the parent as well, so the work is not counted twice', () => {
    const tasks = [
      task('parent', { estimated_hours: 10 }),
      task('child-a', { parent_task_id: 'parent', estimated_hours: 4 }),
      task('child-b', { parent_task_id: 'parent', estimated_hours: 6 }),
    ]
    const ids = buildProjectPlanSpec(project(), tasks, profile, sched).spec!.requests.map(r => r.ref.id)
    expect(ids.sort()).toEqual(['child-a', 'child-b'])
  })

  it('ignores tasks from another project', () => {
    const tasks = [task('mine'), task('theirs', { project_id: 'other' })]
    expect(buildProjectPlanSpec(project(), tasks, profile, sched).spec!.requests).toHaveLength(1)
  })

  it('honours only_task_ids when the caller narrows the scope', () => {
    const tasks = [task('a'), task('b'), task('c')]
    const build = buildProjectPlanSpec(project(), tasks, profile, sched, ['b'])
    expect(build.spec!.requests.map(r => r.ref.id)).toEqual(['b'])
  })
})

describe('estimates are required, never invented', () => {
  it('reports a task with no estimate in skipped, with a reason', () => {
    const build = buildProjectPlanSpec(project(), [task('a'), task('b', { estimated_hours: undefined })], profile, sched)

    expect(build.spec!.requests).toHaveLength(1)
    expect(build.skipped).toHaveLength(1)
    expect(build.skipped[0].title).toBe('b')
    expect(build.skipped[0].reason).toMatch(/[֐-׿]/)
  })

  it('refuses to plan at all when nothing carries an estimate, rather than guessing', () => {
    const tasks = [task('a', { estimated_hours: undefined }), task('b', { estimated_hours: undefined })]
    const build = buildProjectPlanSpec(project(), tasks, profile, sched)

    expect(build.spec).toBeUndefined()
    expect(build.error).toBeTruthy()
    expect(build.skipped).toHaveLength(2)
  })

  it('floors a tiny estimate instead of scheduling a two-minute session', () => {
    const build = buildProjectPlanSpec(project(), [task('a', { estimated_hours: 0.01 })], profile, sched)
    expect(build.spec!.requests[0].totalMinutes).toBe(15)
  })
})

describe('deadlines and ordering', () => {
  it('inherits the project deadline when the task has none', () => {
    const build = buildProjectPlanSpec(project(), [task('a')], profile, sched)
    expect(build.spec!.requests[0].deadline).toBe('2026-08-27T09:00:00')
  })

  it('lets a task deadline win over the project one', () => {
    const build = buildProjectPlanSpec(project(), [task('a', { deadline: '2026-08-20T09:00:00' })], profile, sched)
    expect(build.spec!.requests[0].deadline).toBe('2026-08-20T09:00:00')
  })

  it('leaves the deadline unset when neither the task nor the project has one', () => {
    const build = buildProjectPlanSpec(project({ kind: 'build', deadline: undefined }), [task('a')], profile, sched)
    expect(build.spec!.requests[0].deadline).toBeUndefined()
  })

  it('carries depends_on through to the engine as dependsOn', () => {
    const tasks = [task('a'), task('b', { depends_on: ['a'] })]
    const build = buildProjectPlanSpec(project(), tasks, profile, sched)
    const b = build.spec!.requests.find(r => r.ref.id === 'b')!
    expect(b.dependsOn).toEqual(['a'])
  })

  it('never sets sessionMinutes — session length is the method\'s decision', () => {
    const build = buildProjectPlanSpec(project(), [task('a', { estimated_hours: 6 })], profile, sched)
    expect(build.spec!.requests[0].sessionMinutes).toBeUndefined()
  })

  it('stamps the project id so the written events can link back', () => {
    const build = buildProjectPlanSpec(project(), [task('a')], profile, sched)
    expect(build.spec!.projectId).toBe(PROJECT_ID)
  })
})

describe('cycles are refused here, by name', () => {
  it('finds a two-task cycle and names both', () => {
    const tasks = [
      task('a', { title: 'לכתוב', depends_on: ['b'] }),
      task('b', { title: 'לבדוק', depends_on: ['a'] }),
    ]
    const cycle = findCycle(tasks)
    expect(cycle).toBeTruthy()
    expect([cycle!.a, cycle!.b].sort()).toEqual(['לבדוק', 'לכתוב'])
  })

  it('refuses to build a spec at all when there is a cycle', () => {
    const tasks = [task('a', { depends_on: ['b'] }), task('b', { depends_on: ['a'] })]
    const build = buildProjectPlanSpec(project(), tasks, profile, sched)

    expect(build.spec).toBeUndefined()
    expect(build.cycle).toBeTruthy()
  })

  it('does not mistake a diamond for a cycle', () => {
    const tasks = [
      task('root'),
      task('left', { depends_on: ['root'] }),
      task('right', { depends_on: ['root'] }),
      task('join', { depends_on: ['left', 'right'] }),
    ]
    expect(findCycle(tasks)).toBeNull()
    expect(buildProjectPlanSpec(project(), tasks, profile, sched).spec).toBeTruthy()
  })

  it('ignores a dependency pointing outside the batch instead of calling it a cycle', () => {
    expect(findCycle([task('a', { depends_on: ['finished-last-week'] })])).toBeNull()
  })
})
