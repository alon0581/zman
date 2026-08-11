import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BUFFER_MINUTES,
  DEFAULT_HORIZON_DAYS,
  MAX_HORIZON_DAYS,
  buildSchedulingContext,
  buildSchedulingProfile,
  horizonDaysFor,
  horizonEnd,
  instantToLocalISO,
  normalizeToLocalISO,
  planOutcomeToToolResult,
  resolveMethod,
  toEngineBusy,
} from './adapter'
import { planSchedule } from './plan'
import { getMethodRules } from './methodRules'
import { STUDENT_WEEK_NOW, buildStudentWeekContext } from './__fixtures__/student-week'
import { CalendarEvent, FeedbackSignal, UserProfile } from '@/types'
import { PlacementRequest, PlanOutcome } from './types'

/**
 * The adapter is the seam where the pure engine meets the messy app, so these
 * tests are mostly about the mess: UTC rows that predate LocalISO, a profile
 * that has half its fields, a method the user picked by hand. The engine's own
 * correctness is covered next door — what is checked here is that nothing is
 * lost, invented, or silently dropped on the way in, and that what comes out is
 * language rather than enum members.
 */

const BASE_PROFILE: UserProfile = {
  user_id: 'u1',
  autonomy_mode: 'hybrid',
  theme: 'dark',
  voice_response_enabled: false,
  language: 'he',
  onboarding_completed: true,
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

describe('normalizeToLocalISO', () => {
  it('keeps a naive timestamp exactly as it is', () => {
    expect(normalizeToLocalISO('2026-08-16T09:00:00', 'Asia/Jerusalem')).toBe('2026-08-16T09:00:00')
  })

  it('pads a date-only or minute-precision value to seconds', () => {
    expect(normalizeToLocalISO('2026-08-16', 'Asia/Jerusalem')).toBe('2026-08-16T00:00:00')
    expect(normalizeToLocalISO('2026-08-16T09:30', 'Asia/Jerusalem')).toBe('2026-08-16T09:30:00')
  })

  it('drops sub-second precision rather than failing clock.ts validation', () => {
    expect(normalizeToLocalISO('2026-08-16T09:00:00.482', 'Asia/Jerusalem')).toBe('2026-08-16T09:00:00')
  })

  it('resolves a legacy UTC row to the wall-clock time the user would read', () => {
    // 06:00Z in August is 09:00 in Jerusalem (UTC+3). Getting this wrong is the
    // exact 2-3 hour drift clock.ts exists to prevent.
    expect(normalizeToLocalISO('2026-08-16T06:00:00.000Z', 'Asia/Jerusalem')).toBe('2026-08-16T09:00:00')
  })

  it('resolves an explicit offset the same way', () => {
    expect(normalizeToLocalISO('2026-08-16T04:00:00+01:00', 'Asia/Jerusalem')).toBe('2026-08-16T06:00:00')
  })

  it('returns null instead of throwing on junk', () => {
    expect(normalizeToLocalISO('not a date', 'Asia/Jerusalem')).toBeNull()
    expect(normalizeToLocalISO('', 'Asia/Jerusalem')).toBeNull()
    expect(normalizeToLocalISO(undefined, 'Asia/Jerusalem')).toBeNull()
    expect(normalizeToLocalISO(null, 'Asia/Jerusalem')).toBeNull()
  })

  it('never produces a string clock.ts would reject', () => {
    for (const raw of ['2026-08-16T06:00:00Z', '2026-08-16T04:00:00+01:00', '2026-08-16T09:00:00']) {
      expect(normalizeToLocalISO(raw, 'Asia/Jerusalem')).not.toMatch(/(?:[zZ]|[+-]\d{2}:?\d{2})$/)
    }
  })
})

describe('instantToLocalISO', () => {
  it('reads the wall clock in the requested zone', () => {
    const instant = new Date('2026-08-16T06:00:00.000Z')
    expect(instantToLocalISO(instant, 'Asia/Jerusalem')).toBe('2026-08-16T09:00:00')
    expect(instantToLocalISO(instant, 'UTC')).toBe('2026-08-16T06:00:00')
  })

  it('falls back to host local time when the zone is nonsense', () => {
    const out = instantToLocalISO(new Date('2026-08-16T06:00:00.000Z'), 'Not/AZone')
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
  })
})

describe('buildSchedulingProfile', () => {
  it('prefers preferred_hours over wake/sleep, matching getFreeSlots', () => {
    const p = buildSchedulingProfile(
      { ...BASE_PROFILE, preferred_hours: { start: 8, end: 23 }, wake_time: '06:00', sleep_time: '01:00' },
      'Asia/Jerusalem',
    )
    expect(p.dayStartHour).toBe(8)
    expect(p.dayEndHour).toBe(23)
  })

  it('falls back to wake_time / sleep_time', () => {
    const p = buildSchedulingProfile({ ...BASE_PROFILE, wake_time: '07:30', sleep_time: '23:00' })
    expect(p.dayStartHour).toBe(7)
    expect(p.dayEndHour).toBe(23)
  })

  it('uses the same 9/22 defaults as getFreeSlots when the profile is empty', () => {
    const p = buildSchedulingProfile(null)
    expect(p.dayStartHour).toBe(9)
    expect(p.dayEndHour).toBe(22)
    expect(p.bufferMinutes).toBe(DEFAULT_BUFFER_MINUTES)
  })

  it('maps productivity_peak to the same windows getFreeSlots uses', () => {
    const evening = buildSchedulingProfile({ ...BASE_PROFILE, productivity_peak: 'evening', preferred_hours: { start: 8, end: 23 } })
    expect(evening.peakStartHour).toBe(18)
    expect(evening.peakEndHour).toBe(23)
  })

  it('clamps the peak into the available day, so PEAK_MATCH can never name an unreachable hour', () => {
    // Morning peak is 06:00-12:00, but this user's day starts at 09:00.
    const p = buildSchedulingProfile({ ...BASE_PROFILE, productivity_peak: 'morning', preferred_hours: { start: 9, end: 22 } })
    expect(p.peakStartHour).toBe(9)
    expect(p.peakEndHour).toBe(12)
  })

  it('keeps the raw peak rather than collapsing it to nothing', () => {
    // Day starts at 13:00; a morning peak cannot be clamped into it at all.
    const p = buildSchedulingProfile({ ...BASE_PROFILE, productivity_peak: 'morning', preferred_hours: { start: 13, end: 22 } })
    expect(p.peakEndHour).toBeGreaterThan(p.peakStartHour)
  })

  it('takes the timezone argument over the profile, and the profile over the default', () => {
    expect(buildSchedulingProfile({ ...BASE_PROFILE, timezone: 'Europe/Berlin' }, 'America/New_York').timezone).toBe('America/New_York')
    expect(buildSchedulingProfile({ ...BASE_PROFILE, timezone: 'Europe/Berlin' }).timezone).toBe('Europe/Berlin')
    expect(buildSchedulingProfile(null).timezone).toBe('Asia/Jerusalem')
  })
})

describe('resolveMethod', () => {
  it('honours a scheduling_method the user already has', () => {
    // persona/challenge would map to pomodoro; the explicit choice must win, or
    // the app silently overrides a setting the user can see in Settings.
    const method = resolveMethod({
      ...BASE_PROFILE,
      persona: 'student', challenge: 'procrastination', day_structure: 'fixed',
      scheduling_method: 'deep_work',
      secondary_methods: ['theme_days', 'not_a_method'],
    })
    expect(method.primary).toBe('deep_work')
    expect(method.secondary).toEqual(['theme_days'])
  })

  it('falls back to the onboarding mapping when no method is set', () => {
    const method = resolveMethod({ ...BASE_PROFILE, persona: 'student', challenge: 'procrastination', day_structure: 'fixed' })
    expect(method.primary).toBe('pomodoro')
  })

  it('ignores a garbage stored method instead of crashing getMethodRules', () => {
    const method = resolveMethod({ ...BASE_PROFILE, scheduling_method: 'astrology' as never })
    expect(getMethodRules(method.primary)).toBeDefined()
  })
})

describe('toEngineBusy', () => {
  it('converts a mixed bag of naive and UTC rows without throwing', () => {
    const { busy, skipped } = toEngineBusy([
      event({ id: 'a', start_time: '2026-08-16T09:00:00', end_time: '2026-08-16T11:00:00' }),
      event({ id: 'b', start_time: '2026-08-16T12:00:00.000Z', end_time: '2026-08-16T13:00:00.000Z' }),
    ], 'Asia/Jerusalem')
    expect(skipped).toHaveLength(0)
    expect(busy.map(b => b.start)).toEqual(['2026-08-16T09:00:00', '2026-08-16T15:00:00'])
  })

  it('reports an unreadable event rather than dropping it silently', () => {
    const { busy, skipped } = toEngineBusy([
      event({ id: 'ok', start_time: '2026-08-16T09:00:00', end_time: '2026-08-16T10:00:00' }),
      event({ id: 'bad', title: 'שבור', start_time: 'yesterday-ish', end_time: '???' }),
    ], 'Asia/Jerusalem')
    expect(busy).toHaveLength(1)
    expect(skipped).toEqual([{ id: 'bad', title: 'שבור', reason: 'unreadable_times' }])
  })

  it('keeps is_all_day, which is what makes a multi-day trip actually block', () => {
    const { busy } = toEngineBusy([
      event({ id: 'miluim', title: 'מילואים', is_all_day: true, start_time: '2026-08-23T00:00:00', end_time: '2026-08-25T23:59:59' }),
    ], 'Asia/Jerusalem')
    expect(busy[0].isAllDay).toBe(true)
    expect(busy[0].start).toBe('2026-08-23T00:00:00')
    expect(busy[0].end).toBe('2026-08-26T00:00:00')
  })

  it('handles an empty or missing list', () => {
    expect(toEngineBusy([], 'Asia/Jerusalem').busy).toEqual([])
    expect(toEngineBusy(undefined, 'Asia/Jerusalem').busy).toEqual([])
  })
})

describe('horizon helpers', () => {
  it('ends the horizon at the end of the last day, so a late deadline is reachable', () => {
    expect(horizonEnd('2026-08-16T07:30:00', 14)).toBe('2026-08-30T23:59:59')
  })

  it('stretches the horizon to cover a distant deadline', () => {
    expect(horizonDaysFor('2026-08-16T07:30:00', '2026-09-20T09:00:00')).toBe(36)
  })

  it('does not shrink below the default for a near deadline', () => {
    expect(horizonDaysFor('2026-08-16T07:30:00', '2026-08-18T09:00:00')).toBe(DEFAULT_HORIZON_DAYS)
    expect(horizonDaysFor('2026-08-16T07:30:00', undefined)).toBe(DEFAULT_HORIZON_DAYS)
  })

  it('caps the horizon so one chat turn cannot become a multi-second search', () => {
    expect(horizonDaysFor('2026-08-16T07:30:00', '2030-01-01T09:00:00')).toBe(MAX_HORIZON_DAYS)
  })
})

describe('buildSchedulingContext', () => {
  const events = [
    event({ id: 'lec', title: 'הרצאה במבני נתונים', start_time: '2026-08-16T09:00:00', end_time: '2026-08-16T11:00:00' }),
    event({ id: 'gym', title: 'אימון כושר', start_time: '2026-08-16T18:00:00', end_time: '2026-08-16T19:00:00', mobility_type: 'flexible' }),
  ]

  it('assembles a context the engine can actually plan against', () => {
    const ctx = buildSchedulingContext(
      { ...BASE_PROFILE, preferred_hours: { start: 8, end: 23 }, productivity_peak: 'morning', scheduling_method: 'pomodoro' },
      events, [], [], 'Asia/Jerusalem', new Date('2026-08-16T04:30:00.000Z'), 14,
    )
    expect(ctx.now).toBe('2026-08-16T07:30:00')
    expect(ctx.horizon.to).toBe('2026-08-30T23:59:59')
    expect(ctx.method.primary).toBe('pomodoro')
    expect(ctx.rules).toEqual(getMethodRules('pomodoro'))
    expect(ctx.busy).toHaveLength(2)
    expect(ctx.profile.dayStartHour).toBe(8)
  })

  it('classifies mobility for events that predate the field', () => {
    const ctx = buildSchedulingContext(BASE_PROFILE, events, [], [], 'Asia/Jerusalem', new Date('2026-08-16T04:30:00.000Z'))
    // "הרצאה" is a fixed keyword; the gym event carries an explicit override.
    expect(ctx.busy.find(b => b.id === 'lec')?.mobility).toBe('fixed')
    expect(ctx.busy.find(b => b.id === 'gym')?.mobility).toBe('flexible')
  })

  it('turns feedback into priors the scorer can read', () => {
    const feedback: FeedbackSignal[] = [
      { type: 'moved', title: 'לימוד', fromHour: 8, toHour: 20, day: 'Sun', at: '2026-08-10T00:00:00.000Z' },
      { type: 'rejected', title: 'לימוד', fromHour: 8, day: 'Mon', at: '2026-08-11T00:00:00.000Z' },
    ]
    const ctx = buildSchedulingContext(BASE_PROFILE, [], [], feedback, 'Asia/Jerusalem', new Date('2026-08-16T04:30:00.000Z'))
    expect(ctx.priors.hourWeight[8]).toBeLessThan(0)
    expect(ctx.priors.hourWeight[20]).toBeGreaterThan(0)
  })

  it('starts from empty priors for a user with no history', () => {
    const ctx = buildSchedulingContext(BASE_PROFILE, [], [], [], 'Asia/Jerusalem', new Date('2026-08-16T04:30:00.000Z'))
    expect(ctx.priors).toEqual({ hourWeight: {}, dayWeight: {} })
  })

  it('survives a calendar full of legacy UTC rows', () => {
    const ctx = buildSchedulingContext(
      BASE_PROFILE,
      [event({ id: 'z', start_time: '2026-08-16T06:00:00.000Z', end_time: '2026-08-16T08:00:00.000Z' })],
      [], [], 'Asia/Jerusalem', new Date('2026-08-16T04:30:00.000Z'),
    )
    expect(ctx.busy[0].start).toBe('2026-08-16T09:00:00')
  })

  it('produces a context that plans deterministically', () => {
    const build = () => buildSchedulingContext(
      { ...BASE_PROFILE, preferred_hours: { start: 8, end: 23 }, scheduling_method: 'pomodoro' },
      events, [], [], 'Asia/Jerusalem', new Date('2026-08-16T04:30:00.000Z'), 10,
    )
    const request: PlacementRequest[] = [{ ref: { kind: 'task' }, title: 'לימוד', totalMinutes: 50, sessionCount: 2 }]
    const a = planSchedule(build(), request)
    const b = planSchedule(build(), request)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('planOutcomeToToolResult', () => {
  // A real plan against the acceptance-gate fixture, so the shape under test is
  // the one the assistant would actually be handed.
  const requests: PlacementRequest[] = [
    {
      ref: { kind: 'task' },
      title: 'לימוד לבחינה באלגברה ליניארית',
      category: 'study',
      energy: 'high',
      totalMinutes: 4 * 60,
      sessionCount: 4,
      deadline: '2026-08-27T09:00:00',
    },
  ]
  const outcome = planSchedule(buildStudentWeekContext(), requests)

  it('renders every reason as a sentence, never a ReasonCode', () => {
    const view = planOutcomeToToolResult(outcome, true, requests)
    expect(view.blocks.length).toBeGreaterThan(0)
    for (const block of view.blocks) {
      expect(block.why.length).toBeGreaterThan(0)
      for (const sentence of block.why) {
        expect(sentence).not.toMatch(/^[A-Z_]+$/)
        expect(sentence).not.toMatch(/PEAK_MATCH|METHOD_FIT|EARLIEST_AVAILABLE|ENERGY_MATCH|DEADLINE_MARGIN/)
        expect(sentence.length).toBeGreaterThan(5)
      }
    }
  })

  it('answers in Hebrew or English on request', () => {
    const he = planOutcomeToToolResult(outcome, true, requests)
    const en = planOutcomeToToolResult(outcome, false, requests)
    expect(he.blocks[0].why.join(' ')).toMatch(/[֐-׿]/)
    expect(en.blocks[0].why.join(' ')).not.toMatch(/[֐-׿]/)
    expect(he.blocks[0].weekday).toMatch(/[֐-׿]/)
  })

  it('carries the times through unchanged, with a readable day and duration', () => {
    const view = planOutcomeToToolResult(outcome, true, requests)
    const first = view.blocks[0]
    expect(first.start).toBe(('blocks' in outcome ? outcome.blocks[0].start : ''))
    expect(first.day).toBe(first.start.slice(0, 10))
    expect(first.time).toMatch(/^\d{2}:\d{2}–\d{2}:\d{2}$/)
    expect(first.duration_minutes).toBeGreaterThan(0)
  })

  it('never places anything before `now`', () => {
    const view = planOutcomeToToolResult(outcome, true, requests)
    for (const block of view.blocks) expect(block.start >= STUDENT_WEEK_NOW).toBe(true)
  })

  it('says the plan is only a proposal, so the model cannot report it as done', () => {
    const view = planOutcomeToToolResult(outcome, true, requests)
    expect(view.summary).toMatch(/הצעה/)
  })

  it('renders unplaced codes and relaxations as advice, and names the request', () => {
    // 40 hours of study in a week that is already full: guaranteed to be partial.
    const heavy: PlacementRequest[] = [{
      ref: { kind: 'task' },
      title: 'פרויקט ענק',
      totalMinutes: 40 * 60,
      sessionCount: 40,
      deadline: '2026-08-21T09:00:00',
    }]
    const partial = planSchedule(buildStudentWeekContext(), heavy)
    const view = planOutcomeToToolResult(partial, true, heavy)

    expect(view.status).not.toBe('ok')
    expect(view.unplaced?.length).toBeGreaterThan(0)
    for (const u of view.unplaced ?? []) {
      expect(u.reason).toMatch(/[֐-׿]/)
      expect(u.reason).not.toBe(u.code)
      expect(u.title).toBe('פרויקט ענק')
    }
    for (const s of view.suggestions ?? []) {
      expect(s.suggestion).toMatch(/[֐-׿]/)
      expect(s.would_place_at_least).toBeGreaterThan(0)
    }
  })

  it('tells the model not to invent times when nothing could be placed', () => {
    const blocked: PlanOutcome = {
      status: 'blocked',
      unplaced: [{ requestIndex: 0, code: 'blocked_by_fixed' }],
      relaxations: [{ code: 'use_weekend', delta: 'Fri–Sat', wouldPlace: 2, requestIndex: 0 }],
    }
    const view = planOutcomeToToolResult(blocked, true, requests)
    expect(view.blocks).toEqual([])
    expect(view.summary).toMatch(/אל תמציא/)
    expect(view.unplaced?.[0].reason).toMatch(/קבועים/)
    expect(view.suggestions?.[0].suggestion).toMatch(/סוף השבוע/)
  })

  it('handles every unplaced and relaxation code without falling back to an enum', () => {
    const codes = [
      'no_window', 'deadline_too_close', 'day_cap_reached', 'blocked_by_fixed',
      'needs_user_approval', 'horizon_exhausted', 'no_free_space', 'below_quality_floor',
    ] as const
    const relax = ['shorten_sessions', 'extend_day', 'use_weekend', 'move_ask_first', 'drop_buffer'] as const

    const view = planOutcomeToToolResult({
      status: 'blocked',
      unplaced: codes.map(code => ({ requestIndex: 0, code })),
      relaxations: relax.map(code => ({ code, delta: '1', wouldPlace: 1 })),
    }, true)

    expect(new Set((view.unplaced ?? []).map(u => u.reason)).size).toBe(codes.length)
    expect(new Set((view.suggestions ?? []).map(s => s.suggestion)).size).toBe(relax.length)
  })

  it('works without the requests array (titles simply go unnamed)', () => {
    const view = planOutcomeToToolResult({
      status: 'blocked',
      unplaced: [{ requestIndex: 3, code: 'no_window' }],
      relaxations: [],
    }, false)
    expect(view.unplaced?.[0].title).toBeUndefined()
    expect(view.unplaced?.[0].reason).toMatch(/No available window/)
  })
})
