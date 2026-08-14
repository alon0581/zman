/**
 * projectPlanFlow.test.ts
 *
 * Covers the seam between `buildProjectPlanSpec` and the EXISTING `proposePlan`,
 * which is where a project plan actually becomes stored blocks. Two things here
 * are easy to get wrong and invisible when you do:
 *
 *  1. Session numbering used to be global. For a single request that reads fine,
 *     but a project batch would render block 3 of task A and block 1 of task B as
 *     "sessions 4 and 5" of one thing.
 *  2. The stored blocks must carry project_id and ref, or the events written by
 *     apply_plan link to nothing — and invested-time and next-step then silently
 *     return zero while looking perfectly healthy.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { CalendarEvent, Project, Task, UserProfile } from '@/types'
import { buildProjectPlanSpec } from './projectTools'
import { proposePlan, SchedulerCtx } from './schedulerTools'
import { __resetPlanStore, getPlan } from './planStore'

afterEach(() => __resetPlanStore())

const USER = 'u1'
const NOW = '2026-08-10T08:00:00'
const PROJECT_ID = 'p1'

const sched: SchedulerCtx = { enabled: true, memory: [], feedback: [], timezone: 'Asia/Jerusalem', isHe: true }

function profileWith(method: string): UserProfile {
  return {
    user_id: USER, autonomy_mode: 'hybrid', theme: 'dark', voice_response_enabled: false,
    language: 'he', onboarding_completed: true, productivity_peak: 'morning',
    preferred_hours: { start: 9, end: 20 },
    scheduling_method: method,
  } as UserProfile
}

const project: Project = {
  id: PROJECT_ID, user_id: USER, title: 'אלגברה', kind: 'course',
  status: 'active', created_at: '2026-08-01T00:00:00.000Z',
  deadline: '2026-08-27T09:00:00',
}

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id, user_id: USER, title: id, priority: 'medium', status: 'pending',
    project_id: PROJECT_ID, created_at: '2026-08-01T00:00:00.000Z',
    estimated_hours: 2, ...over,
  } as Task
}

const noEvents: CalendarEvent[] = []

function plan(tasks: Task[], method = 'pomodoro') {
  const profile = profileWith(method)
  const build = buildProjectPlanSpec(project, tasks, profile, sched)
  if (!build.spec) throw new Error('expected a spec')
  return proposePlan(USER, noEvents, profile, sched, NOW, build.spec)
}

describe('a project plan is one proposal covering every task', () => {
  it('places blocks for more than one task in a single plan', () => {
    const result = plan([task('a'), task('b')])
    const stored = result.stored

    expect(stored.length).toBeGreaterThan(1)
    const refs = new Set(stored.map(b => b.ref?.id))
    expect(refs.has('a')).toBe(true)
    expect(refs.has('b')).toBe(true)
  })

  it('returns one plan_id that resolves to exactly those blocks', () => {
    const result = plan([task('a'), task('b')])
    const planId = result.toolResult.plan_id as string

    expect(planId).toBeTruthy()
    const saved = getPlan(USER, planId)
    expect(saved!.blocks).toHaveLength(result.stored.length)
  })
})

describe('every stored block links back, or the feature silently does nothing', () => {
  it('stamps the project id on every block', () => {
    for (const block of plan([task('a'), task('b')]).stored) {
      expect(block.project_id).toBe(PROJECT_ID)
    }
  })

  it('stamps a task ref on every block, with the id required by CalendarEvent', () => {
    for (const block of plan([task('a'), task('b')]).stored) {
      expect(block.ref?.kind).toBe('task')
      expect(typeof block.ref?.id).toBe('string')
      expect(block.ref!.id.length).toBeGreaterThan(0)
    }
  })

  it('leaves project_id unset for an ordinary non-project plan', () => {
    // A plain schedule_item spec has no projectId, and must not acquire one.
    const profile = profileWith('pomodoro')
    const build = buildProjectPlanSpec(project, [task('a')], profile, sched)
    delete build.spec!.projectId
    const stored = proposePlan(USER, noEvents, profile, sched, NOW, build.spec!).stored
    expect(stored.every(b => b.project_id === undefined)).toBe(true)
  })
})

describe('session numbering is per task, not global', () => {
  it('numbers each task\'s sessions from 1 rather than continuing a running count', () => {
    // Pomodoro caps blocks at 25 minutes, so 2h of work is several sessions each.
    const stored = plan([task('a', { title: 'אלף', estimated_hours: 2 }),
                         task('b', { title: 'בית', estimated_hours: 2 })]).stored

    const alef = stored.filter(b => b.title.startsWith('אלף')).map(b => b.title)
    const bet = stored.filter(b => b.title.startsWith('בית')).map(b => b.title)

    expect(alef.length).toBeGreaterThan(1)
    expect(bet.length).toBeGreaterThan(1)
    // Both tasks start at 1. A global counter would give the second task 4, 5, 6…
    expect(alef[0]).toContain('1')
    expect(bet[0]).toContain('1')
    expect(bet.some(t => t.includes(String(alef.length + 1)))).toBe(false)
  })

  it('leaves a single-session task with the user\'s own words, unnumbered', () => {
    // time_blocking uses 60-minute sessions, so a 1h task is exactly one block.
    const stored = plan([task('solo', { title: 'לקרוא', estimated_hours: 1 })], 'time_blocking').stored
    expect(stored).toHaveLength(1)
    expect(stored[0].title).toBe('לקרוא')
  })
})

describe('dependencies survive the whole round trip', () => {
  it('never schedules a dependent before its prerequisite finishes', () => {
    const tasks = [
      task('first', { title: 'ראשון', estimated_hours: 2 }),
      task('second', { title: 'שני', estimated_hours: 1, depends_on: ['first'] }),
    ]
    const stored = plan(tasks, 'time_blocking').stored

    const firstEnd = stored.filter(b => b.ref?.id === 'first')
      .reduce((max, b) => (b.end > max ? b.end : max), '')
    const secondStart = stored.filter(b => b.ref?.id === 'second')
      .reduce((min, b) => (!min || b.start < min ? b.start : min), '')

    expect(firstEnd).toBeTruthy()
    expect(secondStart).toBeTruthy()
    expect(secondStart >= firstEnd).toBe(true)
  })
})
