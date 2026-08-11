import { afterEach, describe, expect, it } from 'vitest'
import {
  SchedulerCtx, buildBreakdownSpec, buildScheduleItemSpec, methodMobility, methodTitleFormatter,
  planMove, planRecurring, proposePlan, recurringToolResult,
} from './schedulerTools'
import { __resetPlanStore, getPlan } from './planStore'
import { CalendarEvent, UserProfile } from '@/types'

/**
 * The engine-backed tools, tested without Next.js, a database, or a model.
 * Everything here is the decision half — what the engine is asked, and what the
 * assistant is handed back. The write half lives in the chat route and is a
 * handful of lines of storage calls.
 */

const NOW = '2026-08-16T07:30:00'   // Sunday morning, before the first lecture

const SCHED: SchedulerCtx = {
  enabled: true,
  memory: [],
  feedback: [],
  timezone: 'Asia/Jerusalem',
  isHe: true,
}

const PROFILE: UserProfile = {
  user_id: 'u1',
  autonomy_mode: 'hybrid',
  theme: 'dark',
  voice_response_enabled: false,
  language: 'he',
  onboarding_completed: true,
  preferred_hours: { start: 8, end: 23 },
  productivity_peak: 'morning',
  scheduling_method: 'pomodoro',
}

function event(over: Partial<CalendarEvent> & Pick<CalendarEvent, 'id' | 'start_time' | 'end_time'>): CalendarEvent {
  return {
    user_id: 'u1',
    title: 'אירוע',
    is_all_day: false,
    source: 'zman',
    created_by: 'user',
    status: 'confirmed',
    created_at: '2026-08-01T00:00:00.000Z',
    ...over,
  } as CalendarEvent
}

afterEach(() => __resetPlanStore())

describe('buildScheduleItemSpec', () => {
  it('turns the model\'s arguments into an engine request', () => {
    const spec = buildScheduleItemSpec({
      title: 'לימוד לבחינה',
      total_minutes: 240,
      session_count: 4,
      deadline: '2026-08-27T09:00:00',
      earliest: '2026-08-18T00:00:00',
      category: 'study',
      energy: 'high',
    }, PROFILE, SCHED)!

    expect(spec.requests[0]).toMatchObject({
      title: 'לימוד לבחינה',
      totalMinutes: 240,
      sessionCount: 4,
      deadline: '2026-08-27T09:00:00',
      earliest: '2026-08-18T00:00:00',
      category: 'study',
      energy: 'high',
    })
    expect(spec.color).toBe('#6366F1')  // study
  })

  it('rejects a call with no title instead of scheduling something anonymous', () => {
    expect(buildScheduleItemSpec({}, PROFILE, SCHED)).toBeNull()
    expect(buildScheduleItemSpec({ title: '   ' }, PROFILE, SCHED)).toBeNull()
  })

  it('drops nonsense enum values rather than passing them to the engine', () => {
    const spec = buildScheduleItemSpec({ title: 'x', category: 'astrology', energy: 'cosmic', mobility_type: 'welded' }, PROFILE, SCHED)!
    expect(spec.requests[0].category).toBeUndefined()
    expect(spec.requests[0].energy).toBeUndefined()
    expect(spec.mobility).toBe('flexible')  // pomodoro's default, not 'welded'
  })

  it('normalises a UTC deadline the model may have echoed back', () => {
    const spec = buildScheduleItemSpec({ title: 'x', deadline: '2026-08-27T06:00:00.000Z' }, PROFILE, SCHED)!
    expect(spec.requests[0].deadline).toBe('2026-08-27T09:00:00')
  })

  it('ignores non-positive numbers rather than asking for a zero-minute block', () => {
    const spec = buildScheduleItemSpec({ title: 'x', total_minutes: 0, session_count: -3 }, PROFILE, SCHED)!
    expect(spec.requests[0].totalMinutes).toBeUndefined()
    expect(spec.requests[0].sessionCount).toBeUndefined()
  })

  it('honours an explicit mobility_type over the method default', () => {
    const spec = buildScheduleItemSpec({ title: 'x', mobility_type: 'fixed' }, PROFILE, SCHED)!
    expect(spec.mobility).toBe('fixed')
  })
})

describe('buildBreakdownSpec', () => {
  it('takes the session length from the user\'s method, keeping the UI\'s promise', () => {
    // Pomodoro's label says 25-minute sessions; METHOD_SESSION_HOURS says 0.5h.
    const spec = buildBreakdownSpec({ task_title: 'פרויקט', total_hours: 4, deadline: '2026-08-27T09:00:00' }, PROFILE, SCHED)!
    expect(spec.requests[0].sessionMinutes).toBe(30)
    expect(spec.requests[0].totalMinutes).toBe(240)
  })

  it('lets an explicit session_length_hours win', () => {
    const spec = buildBreakdownSpec({ task_title: 'פרויקט', total_hours: 4, session_length_hours: 1.5 }, PROFILE, SCHED)!
    expect(spec.requests[0].sessionMinutes).toBe(90)
  })

  it('rejects a task with no hours instead of scheduling nothing and claiming success', () => {
    expect(buildBreakdownSpec({ task_title: 'x', total_hours: 0 }, PROFILE, SCHED)).toBeNull()
    expect(buildBreakdownSpec({ total_hours: 4 }, PROFILE, SCHED)).toBeNull()
  })
})

describe('method shaping', () => {
  it('matches the v1 mobility defaults exactly', () => {
    expect(methodMobility('deep_work')).toBe('fixed')
    expect(methodMobility('the_one_thing')).toBe('fixed')
    expect(methodMobility('eat_the_frog')).toBe('ask_first')
    expect(methodMobility('pomodoro')).toBe('flexible')
    expect(methodMobility(undefined)).toBe('flexible')
  })

  it('matches the v1 title formats exactly', () => {
    expect(methodTitleFormatter('pomodoro')('לימוד', 0)).toBe('לימוד — פומודורו 1')
    expect(methodTitleFormatter('eat_the_frog')('לימוד', 0)).toBe('🐸 לימוד')
    expect(methodTitleFormatter('ivy_lee')('לימוד', 2)).toBe('#3 לימוד')
    expect(methodTitleFormatter(undefined)('לימוד', 1)).toBe('לימוד — Session 2')
  })
})

describe('proposePlan', () => {
  const busyWeek = [
    event({ id: 'lec1', title: 'הרצאה במבני נתונים', start_time: '2026-08-16T09:00:00', end_time: '2026-08-16T11:00:00' }),
    event({ id: 'lec2', title: 'הרצאה במבני נתונים', start_time: '2026-08-18T09:00:00', end_time: '2026-08-18T11:00:00' }),
  ]

  it('proposes without writing, and hands back a plan_id that resolves', () => {
    const spec = buildScheduleItemSpec({ title: 'לימוד', total_minutes: 60, session_count: 2 }, PROFILE, SCHED)!
    const { toolResult, stored } = proposePlan('u1', busyWeek, PROFILE, SCHED, NOW, spec)

    const planId = (toolResult as { plan_id: string }).plan_id
    expect(planId).toMatch(/^plan_/)
    expect(getPlan('u1', planId)?.blocks).toEqual(stored)
    // The proposal is the only thing that happened — no event objects returned.
    expect(toolResult).not.toHaveProperty('events_created')
  })

  it('tells the model in words that nothing was saved yet', () => {
    const spec = buildScheduleItemSpec({ title: 'לימוד', total_minutes: 60 }, PROFILE, SCHED)!
    const { toolResult } = proposePlan('u1', busyWeek, PROFILE, SCHED, NOW, spec)
    expect(String((toolResult as { next_step: string }).next_step)).toMatch(/apply_plan/)
    expect(String((toolResult as { summary: string }).summary)).toMatch(/הצעה/)
  })

  it('never schedules on top of an existing commitment', () => {
    const spec = buildScheduleItemSpec({ title: 'לימוד', total_minutes: 120, session_count: 2 }, PROFILE, SCHED)!
    const { stored } = proposePlan('u1', busyWeek, PROFILE, SCHED, NOW, spec)
    for (const b of stored) {
      for (const busy of busyWeek) {
        const clash = b.start < busy.end_time && busy.start_time < b.end
        expect(clash, `${b.start}-${b.end} vs ${busy.start_time}`).toBe(false)
      }
    }
  })

  it('respects a multi-day all-day block, which the old free-slot maths ignored', () => {
    const withMiluim = [
      ...busyWeek,
      event({ id: 'm', title: 'מילואים', is_all_day: true, start_time: '2026-08-17T00:00:00', end_time: '2026-08-19T23:59:59' }),
    ]
    const spec = buildScheduleItemSpec({ title: 'לימוד', total_minutes: 300, session_count: 6 }, PROFILE, SCHED)!
    const { stored } = proposePlan('u1', withMiluim, PROFILE, SCHED, NOW, spec)
    expect(stored.length).toBeGreaterThan(0)
    for (const b of stored) {
      expect(b.start.slice(0, 10) >= '2026-08-17' && b.start.slice(0, 10) <= '2026-08-19').toBe(false)
    }
  })

  it('carries the rendered reasons onto the stored blocks', () => {
    const spec = buildScheduleItemSpec({ title: 'לימוד', total_minutes: 60 }, PROFILE, SCHED)!
    const { stored } = proposePlan('u1', busyWeek, PROFILE, SCHED, NOW, spec)
    expect(stored[0].why.length).toBeGreaterThan(0)
    expect(stored[0].why[0]).not.toMatch(/^[A-Z_]+$/)
  })

  it('numbers a split by the method, but leaves a single block\'s own words alone', () => {
    // 25 minutes is exactly one Pomodoro, so this stays a single block.
    const one = buildScheduleItemSpec({ title: 'לימוד', total_minutes: 25 }, PROFILE, SCHED)!
    const single = proposePlan('u1', busyWeek, PROFILE, SCHED, NOW, one).stored
    expect(single).toHaveLength(1)
    expect(single[0].title).toBe('לימוד')

    const many = buildScheduleItemSpec({ title: 'לימוד', total_minutes: 90, session_count: 3 }, PROFILE, SCHED)!
    const titles = proposePlan('u1', busyWeek, PROFILE, SCHED, NOW, many).stored.map(b => b.title)
    expect(titles[0]).toBe('לימוד — פומודורו 1')
  })

  it('stores nothing when nothing could be placed, and says do not invent times', () => {
    // A one-hour block that must fit before a deadline 15 minutes from now.
    const spec = buildScheduleItemSpec(
      { title: 'בלתי אפשרי', total_minutes: 60, deadline: '2026-08-16T07:45:00' },
      PROFILE, SCHED,
    )!
    const { toolResult, stored } = proposePlan('u1', busyWeek, PROFILE, SCHED, NOW, spec)
    expect(stored).toEqual([])
    expect(toolResult).not.toHaveProperty('plan_id')
    expect(String((toolResult as { next_step: string }).next_step)).toMatch(/אל תמציא/)
  })

  it('reports a partial plan as partial rather than rounding it up to done', () => {
    const spec = buildScheduleItemSpec(
      { title: 'ענק', total_minutes: 40 * 60, session_count: 40, deadline: '2026-08-20T09:00:00' },
      PROFILE, SCHED,
    )!
    const { toolResult } = proposePlan('u1', busyWeek, PROFILE, SCHED, NOW, spec)
    const view = toolResult as { status: string; unplaced?: unknown[]; suggestions?: unknown[] }
    expect(view.status).toBe('partial')
    expect(view.unplaced?.length).toBeGreaterThan(0)
    expect(view.suggestions?.length).toBeGreaterThan(0)
  })

  it('keeps each user\'s proposals to themselves', () => {
    const spec = buildScheduleItemSpec({ title: 'לימוד', total_minutes: 60 }, PROFILE, SCHED)!
    const planId = (proposePlan('u1', busyWeek, PROFILE, SCHED, NOW, spec).toolResult as { plan_id: string }).plan_id
    expect(getPlan('u2', planId)).toBeNull()
  })

  it('degrades to an honest error rather than throwing on an unreadable calendar', () => {
    const broken = [event({ id: 'bad', start_time: 'sometime', end_time: 'later' })]
    const spec = buildScheduleItemSpec({ title: 'לימוד', total_minutes: 60 }, PROFILE, SCHED)!
    // The bad row is dropped by the adapter, so this still plans — the point is
    // that it does not throw out of the tool and take the chat turn with it.
    expect(() => proposePlan('u1', broken, PROFILE, SCHED, NOW, spec)).not.toThrow()
  })

  it('answers in English when the user is not Hebrew-speaking', () => {
    const spec = buildScheduleItemSpec({ title: 'Study', total_minutes: 60 }, PROFILE, { ...SCHED, isHe: false })!
    const { toolResult } = proposePlan('u1', busyWeek, PROFILE, { ...SCHED, isHe: false }, NOW, spec)
    expect(String((toolResult as { next_step: string }).next_step)).not.toMatch(/[֐-׿]/)
  })
})

describe('planMove', () => {
  const events = [
    event({ id: 'study', title: 'לימוד', start_time: '2026-08-17T09:00:00', end_time: '2026-08-17T10:00:00', created_by: 'ai', mobility_type: 'flexible' }),
    event({ id: 'exam', title: 'בחינה', start_time: '2026-08-18T09:00:00', end_time: '2026-08-18T12:00:00', mobility_type: 'fixed' }),
  ]

  it('finds a new slot and explains the choice', () => {
    const decision = planMove('study', events, PROFILE, SCHED, NOW)
    expect(decision.ok).toBe(true)
    if (!decision.ok) return
    expect(decision.start).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(decision.why.length).toBeGreaterThan(0)
  })

  it('does not let the event block itself out of a slot', () => {
    // The only free hour in the day is the one the event already occupies —
    // if it stayed in the busy set the engine would report "no room".
    const packed = [
      event({ id: 'study', title: 'לימוד', start_time: '2026-08-17T12:00:00', end_time: '2026-08-17T13:00:00', mobility_type: 'flexible' }),
    ]
    const decision = planMove('study', packed, PROFILE, SCHED, NOW)
    expect(decision.ok).toBe(true)
  })

  it('refuses to move a fixed event', () => {
    const decision = planMove('exam', events, PROFILE, SCHED, NOW)
    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.toolResult.error).toBe('fixed_event')
  })

  it('reports a missing event instead of guessing', () => {
    const decision = planMove('nope', events, PROFILE, SCHED, NOW)
    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.toolResult.error).toBe('not_found')
  })

  it('keeps the event\'s original duration, even when the method\'s blocks are shorter', () => {
    // Pomodoro caps blocks at 25 minutes. Applying that here would quietly turn
    // "move my hour-long session" into a 25-minute one — an edit nobody asked for.
    const decision = planMove('study', events, PROFILE, SCHED, NOW)
    if (!decision.ok) throw new Error('expected a slot')
    const minutes = (Date.parse(`${decision.end}Z`) - Date.parse(`${decision.start}Z`)) / 60000
    expect(minutes).toBe(60)
  })

  it('keeps a long event long, even past the method\'s daily cap', () => {
    const long = [event({
      id: 'workshop', title: 'סדנה', mobility_type: 'flexible',
      start_time: '2026-08-17T09:00:00', end_time: '2026-08-17T14:00:00',
    })]
    const decision = planMove('workshop', long, PROFILE, SCHED, NOW)
    if (!decision.ok) throw new Error('expected a slot')
    const minutes = (Date.parse(`${decision.end}Z`) - Date.parse(`${decision.start}Z`)) / 60000
    expect(minutes).toBe(300)
  })
})

describe('planRecurring', () => {
  const weekly = { frequency: 'weekly', count: 4 }
  const base = { title: 'אימון כושר', start_time: '2026-08-17T18:00:00', end_time: '2026-08-17T19:00:00' }

  it('generates every instance when the calendar is clear', () => {
    const plan = planRecurring(base, [], PROFILE, SCHED, weekly)
    expect(plan.instances.map(i => i.start)).toEqual([
      '2026-08-17T18:00:00', '2026-08-24T18:00:00', '2026-08-31T18:00:00', '2026-09-07T18:00:00',
    ])
    expect(plan.conflicts).toEqual([])
  })

  it('reports a clash by name instead of swallowing it in a skipped count', () => {
    // This is the bug: v1 counted the skip and the assistant reported success.
    const existing = [event({ id: 'x', title: 'פגישה', start_time: '2026-08-24T18:00:00', end_time: '2026-08-24T19:00:00' })]
    const plan = planRecurring(base, existing, PROFILE, SCHED, weekly)

    expect(plan.instances).toHaveLength(3)
    expect(plan.conflicts).toHaveLength(1)
    expect(plan.conflicts[0].date).toBe('2026-08-24')
    expect(plan.conflicts[0].blocked_by[0].title).toBe('פגישה')
  })

  it('is blocked by a multi-day all-day event, which the v1 overlap test could not see', () => {
    const miluim = [event({
      id: 'm', title: 'מילואים', is_all_day: true,
      start_time: '2026-08-23T00:00:00', end_time: '2026-08-25T23:59:59',
    })]
    const plan = planRecurring(base, miluim, PROFILE, SCHED, weekly)
    expect(plan.instances.map(i => i.start)).not.toContain('2026-08-24T18:00:00')
    expect(plan.conflicts.some(c => c.date === '2026-08-24')).toBe(true)
  })

  it('blocks on flexible and ask_first events too, and names their mobility so the AI can offer to move them', () => {
    const existing = [event({
      id: 'x', title: 'ארוחה', mobility_type: 'flexible',
      start_time: '2026-08-24T18:00:00', end_time: '2026-08-24T19:00:00',
    })]
    const plan = planRecurring(base, existing, PROFILE, SCHED, weekly)
    expect(plan.conflicts[0].blocked_by[0].mobility).toBe('flexible')
  })

  it('does not let an instance land on an earlier instance of its own series', () => {
    // A monthly stride of 30 days over a short window; every generated instance
    // must still be free of the ones already accepted.
    const plan = planRecurring(base, [], PROFILE, SCHED, { frequency: 'monthly', count: 3 })
    const starts = plan.instances.map(i => i.start)
    expect(new Set(starts).size).toBe(starts.length)
  })

  it('skips an exact duplicate rather than piling on a second copy', () => {
    const existing = [event({ id: 'dup', title: 'אימון כושר', start_time: '2026-08-17T18:00:00', end_time: '2026-08-17T19:00:00' })]
    const plan = planRecurring(base, existing, PROFILE, SCHED, weekly)
    expect(plan.duplicates).toContain('2026-08-17T18:00:00')
    expect(plan.instances.map(i => i.start)).not.toContain('2026-08-17T18:00:00')
  })

  it('stops at end_date', () => {
    const plan = planRecurring(base, [], PROFILE, SCHED, { frequency: 'weekly', count: 12, end_date: '2026-08-31' })
    expect(plan.instances.map(i => i.start)).toEqual([
      '2026-08-17T18:00:00', '2026-08-24T18:00:00', '2026-08-31T18:00:00',
    ])
  })

  it('rejects an invalid range instead of creating zero-length events', () => {
    const plan = planRecurring(
      { ...base, end_time: '2026-08-17T17:00:00' }, [], PROFILE, SCHED, weekly,
    )
    expect(plan.error?.error).toBe('invalid_range')
    expect(plan.instances).toEqual([])
  })

  it('rejects unparseable times', () => {
    const plan = planRecurring({ ...base, start_time: 'tuesday' }, [], PROFILE, SCHED, weekly)
    expect(plan.error?.error).toBe('invalid_date')
  })

  it('caps a runaway count', () => {
    const plan = planRecurring(base, [], PROFILE, SCHED, { frequency: 'weekly', count: 9999 })
    expect(plan.instances.length).toBeLessThanOrEqual(52)
  })
})

describe('recurringToolResult', () => {
  it('tells the model not to claim the whole series when instances were skipped', () => {
    const result = recurringToolResult('s1', 3, {
      instances: [], duplicates: [],
      conflicts: [{ date: '2026-08-24', time: '18:00–19:00', blocked_by: [{ title: 'פגישה', mobility: 'ask_first' }] }],
    }, []) as Record<string, unknown>

    expect(result.instances_created).toBe(3)
    expect(String(result.message)).toMatch(/do not claim the full series/)
    expect(result.success).toBe(true)  // nothing failed to save; it just didn't all fit
  })

  it('marks a write failure as a failure', () => {
    const result = recurringToolResult('s1', 1, { instances: [], conflicts: [], duplicates: [] }, ['boom']) as Record<string, unknown>
    expect(result.success).toBe(false)
    expect(result.error).toBe('write_failed')
    expect(String(result.message)).toMatch(/do NOT claim/)
  })

  it('is a clean success when everything landed', () => {
    const result = recurringToolResult('s1', 4, { instances: [], conflicts: [], duplicates: [] }, []) as Record<string, unknown>
    expect(result.success).toBe(true)
    expect(result.message).toBeUndefined()
    expect(result.error).toBeUndefined()
  })
})
