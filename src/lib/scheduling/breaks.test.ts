import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { planSchedule } from './plan'
import { spacingAround, ENGINE_BLOCK_PREFIX } from './place'
import { METHOD_RULES } from './methodRules'
import { SchedulingMethod } from './methodMapper'
import { buildStudentWeekContext } from './__fixtures__/student-week'
import { minutesBetween } from './clock'
import { BusyBlock, PlacedBlock, PlacementRequest, SchedulingContext } from './types'

/**
 * breaks.test.ts — the two methods that promise a break now schedule one.
 *
 * METHOD_LABELS.pomodoro sells "25-min focused sessions with 5-min breaks" and
 * rule_5217 sells "52 min work + 17 min real break". `MethodRules.breakMinutes`
 * and `breakAfterMinutes` carried those numbers while nothing in the engine read
 * either field, so the calendar showed 25-minute blocks with whatever hole the
 * scorer happened to leave — 35 minutes, typically. See the design note on
 * `spacingAround` in place.ts for why a break is spacing rather than a block.
 */

const METHODS = Object.keys(METHOD_RULES) as SchedulingMethod[]
const WITH_BREAKS = METHODS.filter(m => METHOD_RULES[m].breakMinutes !== undefined)
const WITHOUT_BREAKS = METHODS.filter(m => METHOD_RULES[m].breakMinutes === undefined)

const engineBlock = (start: string, end: string, over: Partial<BusyBlock> = {}): BusyBlock => ({
  id: `${ENGINE_BLOCK_PREFIX}0:${start}`,
  title: 'session',
  start,
  end,
  mobility: 'flexible',
  createdBy: 'ai',
  isAllDay: false,
  ...over,
})

const calendarBlock = (start: string, end: string): BusyBlock =>
  ({ ...engineBlock(start, end), id: 'busy-lecture' })

function contextFor(method: SchedulingMethod): SchedulingContext {
  const base = buildStudentWeekContext()
  return { ...base, method: { primary: method, secondary: [] }, rules: METHOD_RULES[method] }
}

/** Gaps in minutes between consecutive blocks of one request that share a day. */
function sameDayGaps(blocks: PlacedBlock[]): number[] {
  const sorted = [...blocks].sort((a, b) => (a.start < b.start ? -1 : 1))
  const gaps: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start.slice(0, 10) !== sorted[i - 1].start.slice(0, 10)) continue
    gaps.push(minutesBetween(sorted[i - 1].end, sorted[i].start))
  }
  return gaps
}

// ── The promise, kept ───────────────────────────────────────────────────────

describe('a method that promises a break now schedules one', () => {
  // One request, many sessions, no deadline pressure — the plain case a user
  // hits by saying "put four pomodoros on today".
  const request = (): PlacementRequest[] => ([{
    ref: { kind: 'task', id: 'study' },
    title: 'לימוד',
    category: 'study',
    energy: 'high',
    sessionCount: 4,
  }])

  it('pomodoro: consecutive sessions on one day are separated by exactly the 5-minute break', () => {
    const ctx = contextFor('pomodoro')
    const outcome = planSchedule(ctx, request())
    const blocks = 'blocks' in outcome ? outcome.blocks : []
    const gaps = sameDayGaps(blocks)

    expect(gaps.length).toBeGreaterThan(0)
    for (const gap of gaps) expect(gap).toBe(METHOD_RULES.pomodoro.breakMinutes)
    // And the work itself is still the promised length, not work-plus-break.
    for (const b of blocks) expect(minutesBetween(b.start, b.end)).toBe(METHOD_RULES.pomodoro.sessionMinutes)
  })

  it('rule_5217: consecutive sessions on one day are separated by exactly the 17-minute break', () => {
    const ctx = contextFor('rule_5217')
    const outcome = planSchedule(ctx, request())
    const blocks = 'blocks' in outcome ? outcome.blocks : []
    const gaps = sameDayGaps(blocks)

    expect(gaps.length).toBeGreaterThan(0)
    for (const gap of gaps) expect(gap).toBe(METHOD_RULES.rule_5217.breakMinutes)
    for (const b of blocks) expect(minutesBetween(b.start, b.end)).toBe(METHOD_RULES.rule_5217.sessionMinutes)
  })

  it('the break is empty time, never a block of its own', () => {
    // Every block returned belongs to a request the caller asked for, carries a
    // real score and real reasons. A break masquerading as a PlacedBlock would
    // show up here as an extra, unattributable entry.
    for (const method of WITH_BREAKS) {
      const outcome = planSchedule(contextFor(method), request())
      const blocks = 'blocks' in outcome ? outcome.blocks : []
      for (const b of blocks) {
        expect(b.requestIndex, `${method}: block "${b.title}" is not attributable to a request`).toBe(0)
        expect(b.title).toBe('לימוד')
        expect(b.reasons.length, `${method}: an unexplained block`).toBeGreaterThan(0)
        expect(b.score).toBe(
          Math.round(b.reasons.reduce((sum, r) => sum + r.weight, 0) * 100) / 100
        )
      }
    }
  })

  it('a break is never charged to the day cap or the session count', () => {
    // pomodoro's own comment reads "8 x (25+5) = 4h"; if the break consumed a
    // session slot the user would get four sessions a day, not eight.
    const ctx = contextFor('pomodoro')
    const outcome = planSchedule(ctx, [{
      ref: { kind: 'task', id: 'study' },
      title: 'לימוד',
      category: 'study',
      sessionCount: 8,
    }])
    const blocks = 'blocks' in outcome ? outcome.blocks : []
    const day = blocks[0].start.slice(0, 10)
    const onDay = blocks.filter(b => b.start.slice(0, 10) === day)
    const workedMinutes = onDay.reduce((sum, b) => sum + minutesBetween(b.start, b.end), 0)

    // Breaks cost nothing, so the ceiling that binds is the method's, measured in
    // work minutes only.
    expect(onDay.length).toBeLessThanOrEqual(METHOD_RULES.pomodoro.maxSessionsPerDay)
    expect(workedMinutes).toBeLessThanOrEqual(METHOD_RULES.pomodoro.dailyCapMinutes)
  })
})

// ── spacingAround, the unit ─────────────────────────────────────────────────

describe('spacingAround decides how much empty time guards a commitment', () => {
  const BUFFER = 15

  it('gives the profile buffer to the user\'s own calendar events, break or no break', () => {
    const lecture = calendarBlock('2026-08-16T09:00:00', '2026-08-16T11:00:00')
    for (const method of METHODS) {
      expect(spacingAround(lecture, BUFFER, METHOD_RULES[method]), method).toBe(BUFFER)
    }
  })

  it('gives the method\'s break to the plan\'s own session blocks', () => {
    const pomodoro = engineBlock('2026-08-16T09:00:00', '2026-08-16T09:25:00')
    expect(spacingAround(pomodoro, BUFFER, METHOD_RULES.pomodoro)).toBe(5)

    const stretch = engineBlock('2026-08-16T09:00:00', '2026-08-16T09:52:00')
    expect(spacingAround(stretch, BUFFER, METHOD_RULES.rule_5217)).toBe(17)
  })

  it('is inert for every method that configures no break', () => {
    const block = engineBlock('2026-08-16T09:00:00', '2026-08-16T11:00:00')
    for (const method of WITHOUT_BREAKS) {
      expect(spacingAround(block, BUFFER, METHOD_RULES[method]), method).toBe(BUFFER)
    }
  })

  it('keeps the buffer for a block too short to have earned its break', () => {
    // breakAfterMinutes is a threshold of continuous work, not decoration.
    const stub = engineBlock('2026-08-16T09:00:00', '2026-08-16T09:15:00')
    expect(spacingAround(stub, BUFFER, METHOD_RULES.pomodoro)).toBe(BUFFER)
  })

  it('never shrinks an all-day block, which owns its whole day', () => {
    const allDay = engineBlock('2026-08-23T00:00:00', '2026-08-24T00:00:00', { isAllDay: true })
    expect(spacingAround(allDay, BUFFER, METHOD_RULES.pomodoro)).toBe(BUFFER)
  })
})

// ── Inertness for the other sixteen methods ─────────────────────────────────

/**
 * The identity test the break change is held to.
 *
 * Sixteen of eighteen methods configure no break, and for them the plan must be
 * what it was before any of this existed — not "equivalent", identical. These
 * digests were recorded on the fixture week immediately before the break change
 * landed (and after `sessionMinutes: 50 → 45`, which is a separate, deliberate
 * correction pinned by its own test in methodRules.test.ts).
 *
 * A digest that moves means the break leaked into a method that never promised
 * one. Do not update a number here to make the suite green: find out what leaked.
 */
const UNCHANGED_PLANS: Partial<Record<SchedulingMethod, string>> = {
  deep_work: 'bcea66833d436f7b',
  eisenhower: 'e7a07ebfce6d61af',
  gtd: 'e7a07ebfce6d61af',
  time_blocking: '8e7731d2035b15db',
  ivy_lee: '77b5883f9a1c776e',
  eat_the_frog: 'dbf18a0874638ea4',
  theme_days: '5437c850cc4b6513',
  the_one_thing: '56f076bf71ee95fb',
  weekly_review: 'c11629f52b6a68d7',
  okr: 'e7a07ebfce6d61af',
  kanban: '52a29a63cbf77bc9',
  time_boxing: '02da64646f5fb8b4',
  moscow: 'e7a07ebfce6d61af',
  scrum: '8e7731d2035b15db',
  energy_management: '52a29a63cbf77bc9',
  twelve_week_year: '136c2b9668061699',
}

/** The same realistic ask the acceptance-gate fixture makes. */
const IDENTITY_REQUESTS: PlacementRequest[] = [
  {
    ref: { kind: 'task', id: 'r0' },
    title: 'לימוד לבחינה באלגברה ליניארית',
    category: 'study',
    energy: 'high',
    totalMinutes: 12 * 60,
    sessionCount: 6,
    deadline: '2026-08-27T09:00:00',
  },
  {
    ref: { kind: 'task', id: 'r1' },
    title: 'תרגיל בית במבני נתונים',
    category: 'study',
    energy: 'medium',
    totalMinutes: 3 * 60,
    sessionCount: 2,
    deadline: '2026-08-20T23:59:00',
  },
]

describe('breaks are inert for the sixteen methods that promise none', () => {
  it('covers exactly the methods with no break configured', () => {
    expect(WITH_BREAKS.sort()).toEqual(['pomodoro', 'rule_5217'])
    expect(WITHOUT_BREAKS).toHaveLength(16)
    expect(Object.keys(UNCHANGED_PLANS).sort()).toEqual([...WITHOUT_BREAKS].sort())
  })

  for (const method of WITHOUT_BREAKS) {
    it(`${method}: plans the fixture week byte for byte as before`, () => {
      const outcome = planSchedule(contextFor(method), IDENTITY_REQUESTS)
      const digest = createHash('sha256').update(JSON.stringify(outcome)).digest('hex').slice(0, 16)
      expect(digest).toBe(UNCHANGED_PLANS[method])
    })
  }
})
