/**
 * health.test.ts
 *
 * The card's numbers are the product; the board is only where they get drawn. If
 * these are wrong the board is a lie told in the language of confidence, so this
 * file is deliberately adversarial about the ways a progress card usually lies:
 *
 *  - counting a parent AND its children, so progress inflates
 *  - counting work that is already scheduled as still outstanding, so risk gets
 *    worse the moment you plan the project (the double-count trap)
 *  - reporting "on track" for a project that has no deadline to be on track for
 *  - reporting "on track" from estimates that do not exist
 *  - reporting "no time estimate" once a plan has already scheduled everything
 *  - reporting "on track" for a project that has no tasks at all
 *  - reporting hours a user never worked
 */

import { describe, expect, it } from 'vitest'
import { CalendarEvent, Project, Task } from '@/types'
import { computeFacts, pickNextStep, resolveSignals } from './health'
import { ProjectProbeResult } from './capacity'

const NOW = '2026-08-16T07:30:00'
const PROJECT_ID = 'p1'

function project(over: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    user_id: 'u1',
    title: 'אלגברה ליניארית',
    kind: 'course',
    status: 'active',
    created_at: '2026-08-01T00:00:00.000Z',
    deadline: '2026-08-27T09:00:00',
    ...over,
  }
}

function task(over: Partial<Task> & Pick<Task, 'id'>): Task {
  return {
    user_id: 'u1',
    title: over.id,
    priority: 'medium',
    status: 'pending',
    project_id: PROJECT_ID,
    created_at: '2026-08-01T00:00:00.000Z',
    ...over,
  } as Task
}

function event(over: Partial<CalendarEvent> & Pick<CalendarEvent, 'id' | 'start_time' | 'end_time'>): CalendarEvent {
  return {
    user_id: 'u1',
    title: 'בלוק',
    is_all_day: false,
    source: 'zman',
    created_by: 'ai',
    status: 'confirmed',
    created_at: '2026-08-01T00:00:00.000Z',
    project_id: PROJECT_ID,
    ...over,
  } as CalendarEvent
}

/** Comfortable: the engine placed the full padded ask, so there is room to slip. */
const okProbe: ProjectProbeResult = {
  status: 'ok', placedMinutes: 600, requestedMinutes: 600, lastEnd: '2026-08-20T12:00:00', suggestions: [],
}
const findSignal = (sigs: ReturnType<typeof resolveSignals>, name: string) => sigs.find(s => s.signal === name)

describe('computeFacts — leaves, not parents', () => {
  it('counts a parent OR its children, never both', () => {
    const tasks = [
      task({ id: 'parent', estimated_hours: 5 }),
      task({ id: 'child-a', parent_task_id: 'parent', estimated_hours: 2 }),
      task({ id: 'child-b', parent_task_id: 'parent', estimated_hours: 3 }),
    ]
    const facts = computeFacts(project(), tasks, [], NOW)

    expect(facts.totalLeafCount).toBe(2)
    expect(facts.remainingMinutes).toBe(300) // 2h + 3h, not 10h
  })

  it('ignores tasks belonging to a different project', () => {
    const tasks = [
      task({ id: 'mine', estimated_hours: 2 }),
      task({ id: 'theirs', project_id: 'other', estimated_hours: 40 }),
    ]
    expect(computeFacts(project(), tasks, [], NOW).remainingMinutes).toBe(120)
  })
})

describe('the double-count trap', () => {
  it('subtracts work already booked on the calendar from what is still remaining', () => {
    const tasks = [task({ id: 't1', estimated_hours: 4 })]
    const events = [
      event({ id: 'e1', start_time: '2026-08-18T09:00:00', end_time: '2026-08-18T11:00:00', ref: { kind: 'task', id: 't1' } }),
    ]
    const facts = computeFacts(project(), tasks, events, NOW)

    // 4h estimated, 2h already scheduled -> 2h genuinely left.
    expect(facts.remainingMinutes).toBe(120)
  })

  it('does not let scheduling a project make its own risk look worse', () => {
    const tasks = [task({ id: 't1', estimated_hours: 4 })]
    const before = computeFacts(project(), tasks, [], NOW).remainingMinutes
    const after = computeFacts(project(), tasks, [
      event({ id: 'e1', start_time: '2026-08-18T09:00:00', end_time: '2026-08-18T13:00:00', ref: { kind: 'task', id: 't1' } }),
    ], NOW).remainingMinutes

    expect(before).toBe(240)
    expect(after).toBe(0)
  })

  it('never lets over-scheduling drive remaining work negative', () => {
    const tasks = [task({ id: 't1', estimated_hours: 1 })]
    const facts = computeFacts(project(), tasks, [
      event({ id: 'e1', start_time: '2026-08-18T09:00:00', end_time: '2026-08-18T18:00:00', ref: { kind: 'task', id: 't1' } }),
    ], NOW)
    expect(facts.remainingMinutes).toBe(0)
  })
})

describe('invested time is measured, never self-reported', () => {
  it('counts only blocks that have already happened', () => {
    const events = [
      event({ id: 'past', start_time: '2026-08-14T09:00:00', end_time: '2026-08-14T11:00:00' }),
      event({ id: 'future', start_time: '2026-08-20T09:00:00', end_time: '2026-08-20T014:00:00'.replace('014', '14') }),
    ]
    expect(computeFacts(project(), [], events, NOW).investedMinutes).toBe(120)
  })

  it('excludes all-day rows, so a deadline marker is not reported as a day of work', () => {
    const events = [
      event({ id: 'marker', start_time: '2026-08-14T00:00:00', end_time: '2026-08-15T00:00:00', is_all_day: true }),
    ]
    expect(computeFacts(project(), [], events, NOW).investedMinutes).toBe(0)
  })

  it('survives a legacy Z-suffixed timestamp instead of throwing', () => {
    const events = [
      event({ id: 'legacy', start_time: '2026-08-14T06:00:00Z', end_time: '2026-08-14T08:00:00Z' }),
    ]
    expect(computeFacts(project(), [], events, NOW).investedMinutes).toBeGreaterThan(0)
  })

  it('reports zero rather than NaN when there are no events at all', () => {
    expect(computeFacts(project(), [], [], NOW).investedMinutes).toBe(0)
  })
})

describe('next step', () => {
  it('skips a task whose dependency is not done yet', () => {
    const tasks = [
      task({ id: 'second', depends_on: ['first'], priority: 'high' }),
      task({ id: 'first', priority: 'low' }),
    ]
    const facts = computeFacts(project(), tasks, [], NOW)
    expect(pickNextStep(facts, tasks)?.id).toBe('first')
  })

  it('prefers something already in progress over starting something new', () => {
    const tasks = [
      task({ id: 'fresh', priority: 'high' }),
      task({ id: 'started', status: 'in_progress', priority: 'low' }),
    ]
    const facts = computeFacts(project(), tasks, [], NOW)
    expect(pickNextStep(facts, tasks)?.id).toBe('started')
  })

  it('names the blocker instead of going silent when every task is blocked', () => {
    const tasks = [task({ id: 'only', depends_on: ['elsewhere'] })]
    const sigs = resolveSignals(project(), tasks, [], okProbe, 'time_blocking', NOW)
    const next = findSignal(sigs, 'next')

    expect(next?.state).toBe('warn')
    expect(next?.text.he).toContain('חסום')
  })

  it('flags a next step that has no calendar time as not scheduled', () => {
    const tasks = [task({ id: 't1', estimated_hours: 2 })]
    const sigs = resolveSignals(project(), tasks, [], okProbe, 'time_blocking', NOW)
    const next = findSignal(sigs, 'next')

    expect(next?.code).toBe('not_scheduled')
    expect(next?.state).toBe('warn')
  })
})

describe('deadline risk — unknown must never render as fine', () => {
  it('drops the deadline signal entirely when the project has no date', () => {
    const sigs = resolveSignals(
      project({ kind: 'build', deadline: undefined }),
      [task({ id: 't1', estimated_hours: 3 })], [], undefined, 'deep_work', NOW,
    )
    expect(findSignal(sigs, 'deadline')).toBeUndefined()
  })

  it('never reports a deadline-less project as on track', () => {
    const sigs = resolveSignals(
      project({ kind: 'build', deadline: undefined }),
      [task({ id: 't1', estimated_hours: 3 })], [], undefined, 'deep_work', NOW,
    )
    expect(sigs.every(s => s.signal !== 'deadline')).toBe(true)
  })

  it('reports unknown, not ok, when no task carries an estimate', () => {
    const tasks = [task({ id: 't1' }), task({ id: 't2' })]
    const sigs = resolveSignals(project(), tasks, [], undefined, 'time_blocking', NOW)
    const d = findSignal(sigs, 'deadline')

    expect(d?.state).toBe('unknown')
    expect(d?.code).toBe('no_estimates')
  })

  it('reads as ok, not no_estimates, when remaining hits zero because the plan already covers it', () => {
    // Pins the regression: remainingMinutes also lands on 0 right after a
    // SUCCESSFUL plan_project -> apply_plan, once every task's estimate is fully
    // covered by a future calendar block. That must not render as the same grey
    // "no time estimate" failure as a project nobody ever estimated.
    const tasks = [task({ id: 't1', estimated_hours: 2 })]
    const events = [
      event({ id: 'e1', start_time: '2026-08-18T09:00:00', end_time: '2026-08-18T11:00:00', ref: { kind: 'task', id: 't1' } }),
    ]
    const sigs = resolveSignals(project(), tasks, events, undefined, 'time_blocking', NOW)
    const d = findSignal(sigs, 'deadline')

    expect(d?.state).toBe('ok')
    expect(d?.code).toBeUndefined()
  })

  it('does not report on track for a project that has no tasks at all', () => {
    // An empty project is not a finished project. This must match the progress
    // card's own 'no_tasks' signal, not read better than it.
    const sigs = resolveSignals(project(), [], [], undefined, 'time_blocking', NOW)
    const d = findSignal(sigs, 'deadline')

    expect(d?.state).not.toBe('ok')
    expect(d?.state).toBe('unknown')
    expect(d?.code).toBe('no_tasks')
  })

  it('still reports ok "All done" when every task that ever existed is finished', () => {
    // Distinguishes the empty-project case above from genuine completion: here
    // totalLeafCount is nonzero and every leaf is done.
    const tasks = [task({ id: 't1', status: 'done' }), task({ id: 't2', status: 'done' })]
    const sigs = resolveSignals(project(), tasks, [], undefined, 'time_blocking', NOW)
    const d = findSignal(sigs, 'deadline')

    expect(d?.state).toBe('ok')
    expect(d?.text.he).toBe('הכול סגור')
  })

  it('caps the state at warn when only some tasks are estimated, and says so', () => {
    const tasks = [task({ id: 't1', estimated_hours: 2 }), task({ id: 't2' })]
    const sigs = resolveSignals(project(), tasks, [], okProbe, 'time_blocking', NOW)
    const d = findSignal(sigs, 'deadline')

    expect(d?.state).not.toBe('ok')
    expect(d?.text.he).toContain('מבוסס על 1 מתוך 2')
  })

  it('reports risk with the engine\'s own sentence when the plan comes back partial', () => {
    const probe: ProjectProbeResult = {
      status: 'partial', placedMinutes: 60, requestedMinutes: 750, suggestions: [],
      reason: 'אין מספיק זמן פנוי לפני המועד האחרון',
    }
    const sigs = resolveSignals(project(), [task({ id: 't1', estimated_hours: 10 })], [], probe, 'time_blocking', NOW)
    const d = findSignal(sigs, 'deadline')

    expect(d?.state).toBe('risk')
    expect(d?.text.he).toBe('אין מספיק זמן פנוי לפני המועד האחרון')
  })

  it('reads as warn, not ok, when the work fits with no room to spare', () => {
    // The probe asks for 125%; only the base amount landed, so it fits but there
    // is no slack. This must NOT read as "on track".
    const tight: ProjectProbeResult = {
      status: 'ok', placedMinutes: 600, requestedMinutes: 750, lastEnd: '2026-08-27T08:00:00', suggestions: [],
    }
    const sigs = resolveSignals(project(), [task({ id: 't1', estimated_hours: 10 })], [], tight, 'time_blocking', NOW)
    expect(findSignal(sigs, 'deadline')?.state).toBe('warn')
  })

  it('reads as ok when there is genuine slack, and does not cry wolf on a comfortable plan', () => {
    // The regression this pins: the engine SPREADS sessions across the horizon, so
    // the last block sits near the deadline even when there are two weeks of room.
    // Judging slack by the last block's position marked every project as tight.
    const comfortable: ProjectProbeResult = {
      status: 'ok', placedMinutes: 900, requestedMinutes: 900, lastEnd: '2026-08-26T18:00:00', suggestions: [],
    }
    const sigs = resolveSignals(project(), [task({ id: 't1', estimated_hours: 12 })], [], comfortable, 'time_blocking', NOW)
    expect(findSignal(sigs, 'deadline')?.state).toBe('ok')
  })

  it('reports unknown when the probe could not run at all', () => {
    const sigs = resolveSignals(project(), [task({ id: 't1', estimated_hours: 3 })], [], undefined, 'time_blocking', NOW)
    expect(findSignal(sigs, 'deadline')?.code).toBe('plan_unavailable')
  })
})

describe('the card speaks the method\'s language', () => {
  it('reads progress as flow for kanban and as a percentage for okr', () => {
    const tasks = [
      task({ id: 'a', status: 'in_progress' }),
      task({ id: 'b' }),
      task({ id: 'c', status: 'done' }),
    ]
    const kanban = findSignal(resolveSignals(project(), tasks, [], okProbe, 'kanban', NOW), 'progress')
    const okr = findSignal(resolveSignals(project(), tasks, [], okProbe, 'okr', NOW), 'progress')

    expect(kanban?.text.he).toBe('1 בתהליך · 1 ממתינות')
    expect(okr?.text.he).toContain('33%')
  })

  it('counts pomodoro time in sessions, matching what the calendar calls the blocks', () => {
    const events = [event({ id: 'e1', start_time: '2026-08-14T09:00:00', end_time: '2026-08-14T11:05:00' })]
    const sigs = resolveSignals(project(), [], events, okProbe, 'pomodoro', NOW)
    const invested = findSignal(sigs, 'invested')

    // 125 minutes / 25-minute pomodoro = 5 sessions.
    expect(invested?.text.he).toContain('5 מפגשים')
  })

  it('orders the signals differently for a deadline-led method than a momentum-led one', () => {
    const tasks = [task({ id: 't1', estimated_hours: 2 })]
    const events = [event({ id: 'e1', start_time: '2026-08-14T09:00:00', end_time: '2026-08-14T10:00:00' })]

    const eis = resolveSignals(project(), tasks, events, okProbe, 'eisenhower', NOW).map(s => s.signal)
    const kan = resolveSignals(project(), tasks, events, okProbe, 'kanban', NOW).map(s => s.signal)

    expect(eis[0]).toBe('next')
    expect(kan[0]).toBe('progress')
  })
})

describe('determinism', () => {
  it('returns identical output for identical input', () => {
    const tasks = [task({ id: 't1', estimated_hours: 2 }), task({ id: 't2', estimated_hours: 3 })]
    const events = [event({ id: 'e1', start_time: '2026-08-14T09:00:00', end_time: '2026-08-14T10:00:00' })]

    const a = resolveSignals(project(), tasks, events, okProbe, 'time_blocking', NOW)
    const b = resolveSignals(project(), tasks, events, okProbe, 'time_blocking', NOW)
    expect(a).toEqual(b)
  })
})
