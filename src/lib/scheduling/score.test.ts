import { describe, it, expect } from 'vitest'
import { scoreCandidate, ScoreInput, WEIGHTS } from './score'
import { MethodRules, ReasonCode, SchedulingContext, SchedulingProfile } from './types'

const profile: SchedulingProfile = {
  timezone: 'Asia/Jerusalem',
  dayStartHour: 9,
  dayEndHour: 17,
  peakStartHour: 9,
  peakEndHour: 12,
  bufferMinutes: 10,
}

const rules: MethodRules = {
  sessionMinutes: 60,
  minBlock: 30,
  maxBlock: 240,
  maxSessionsPerDay: 3,
  preferContiguous: false,
  hardestFirst: false,
  dailyCapMinutes: 480,
}

function ctxOf(over: Partial<SchedulingContext> = {}): SchedulingContext {
  return {
    now: '2026-08-10T08:00:00',
    horizon: { from: '2026-08-10T00:00:00', to: '2026-08-14T00:00:00' },
    profile,
    method: { primary: 'time_blocking', secondary: [] },
    rules,
    busy: [],
    priors: { hourWeight: {}, dayWeight: {} },
    ...over,
  }
}

function inputOf(over: Partial<ScoreInput> = {}): ScoreInput {
  return {
    ctx: ctxOf(),
    request: { ref: { kind: 'task' }, title: 'לימוד' },
    start: '2026-08-10T09:00:00',
    end: '2026-08-10T10:00:00',
    siblingDays: [],
    neighbours: [],
    isFrog: false,
    bufferMinutes: 10,
    ...over,
  }
}

function weightOf(input: ScoreInput, code: ReasonCode): number {
  return scoreCandidate(input).reasons.find(r => r.code === code)?.weight ?? 0
}

describe('PEAK_MATCH scores by overlap, not by the start hour', () => {
  it('gives full credit to a block entirely inside the peak', () => {
    expect(weightOf(inputOf(), 'PEAK_MATCH')).toBe(WEIGHTS.PEAK_MATCH)
  })

  it('halves the credit for a six-hour block that is only half peak', () => {
    // The old code called this "peak" outright, because it starts at 09:00.
    const wide = inputOf({ start: '2026-08-10T09:00:00', end: '2026-08-10T15:00:00' })
    expect(weightOf(wide, 'PEAK_MATCH')).toBe(WEIGHTS.PEAK_MATCH / 2)
    expect(weightOf(wide, 'PEAK_MATCH')).toBeLessThan(weightOf(inputOf(), 'PEAK_MATCH'))
  })

  it('still credits a block that starts before the peak but runs into it', () => {
    // Start hour 08:00 says "not peak"; two of its three hours say otherwise.
    const early = inputOf({ start: '2026-08-10T08:00:00', end: '2026-08-10T11:00:00' })
    expect(weightOf(early, 'PEAK_MATCH')).toBeCloseTo(WEIGHTS.PEAK_MATCH * (2 / 3), 1)
  })

  it('emits no reason at all when the block misses the peak entirely', () => {
    const off = inputOf({ start: '2026-08-10T14:00:00', end: '2026-08-10T15:00:00' })
    expect(scoreCandidate(off).reasons.some(r => r.code === 'PEAK_MATCH')).toBe(false)
  })
})

describe('SPREAD', () => {
  it('penalises stacking onto a day this request already uses', () => {
    expect(weightOf(inputOf({ siblingDays: ['2026-08-10'] }), 'SPREAD')).toBe(-WEIGHTS.SPREAD)
  })

  it('penalises twice as hard for a second session on that day', () => {
    expect(weightOf(inputOf({ siblingDays: ['2026-08-10', '2026-08-10'] }), 'SPREAD')).toBe(-2 * WEIGHTS.SPREAD)
  })

  it('rewards distance from the nearest sibling, up to saturation', () => {
    const oneDay = weightOf(inputOf({ start: '2026-08-11T09:00:00', end: '2026-08-11T10:00:00', siblingDays: ['2026-08-10'] }), 'SPREAD')
    const threeDays = weightOf(inputOf({ start: '2026-08-13T09:00:00', end: '2026-08-13T10:00:00', siblingDays: ['2026-08-10'] }), 'SPREAD')
    expect(threeDays).toBeGreaterThan(oneDay)
    expect(threeDays).toBe(WEIGHTS.SPREAD)
  })

  it('says nothing when this is the first session', () => {
    expect(scoreCandidate(inputOf()).reasons.some(r => r.code === 'SPREAD')).toBe(false)
  })
})

describe('DEADLINE_MARGIN', () => {
  it('rewards finishing with room to spare', () => {
    const early = inputOf({ request: { ref: { kind: 'task' }, title: 'x', deadline: '2026-08-13T17:00:00' } })
    expect(weightOf(early, 'DEADLINE_MARGIN')).toBeGreaterThan(0)
  })

  it('turns negative inside the last fifth of the runway', () => {
    // Runway is now→deadline; this block ends with barely any of it left.
    const crunch = inputOf({
      start: '2026-08-13T15:00:00',
      end: '2026-08-13T16:00:00',
      request: { ref: { kind: 'task' }, title: 'x', deadline: '2026-08-13T16:30:00' },
    })
    expect(weightOf(crunch, 'DEADLINE_MARGIN')).toBeLessThan(0)
  })

  it('says nothing when there is no deadline to be early for', () => {
    expect(scoreCandidate(inputOf()).reasons.some(r => r.code === 'DEADLINE_MARGIN')).toBe(false)
  })
})

describe('the remaining terms', () => {
  it('rewards a theme-day match and penalises a mismatch', () => {
    // 2026-08-10 is a Monday.
    const ctx = ctxOf({ rules: { ...rules, themeDays: { 1: 'study' } } })
    const match = inputOf({ ctx, request: { ref: { kind: 'task' }, title: 'x', category: 'study' } })
    const miss = inputOf({ ctx, request: { ref: { kind: 'task' }, title: 'x', category: 'admin' } })
    expect(weightOf(match, 'THEME_DAY')).toBe(WEIGHTS.THEME_DAY)
    expect(weightOf(miss, 'THEME_DAY')).toBeLessThan(0)
  })

  it('sends high-energy work toward the peak and low-energy work away from it', () => {
    const peakSlot = { start: '2026-08-10T09:00:00', end: '2026-08-10T10:00:00' }
    const lateSlot = { start: '2026-08-10T15:00:00', end: '2026-08-10T16:00:00' }
    const high = { ref: { kind: 'task' as const }, title: 'x', energy: 'high' as const }
    const low = { ref: { kind: 'task' as const }, title: 'x', energy: 'low' as const }
    expect(weightOf(inputOf({ ...peakSlot, request: high }), 'ENERGY_MATCH')).toBe(WEIGHTS.ENERGY_MATCH)
    expect(weightOf(inputOf({ ...lateSlot, request: high }), 'ENERGY_MATCH')).toBe(0)
    expect(weightOf(inputOf({ ...lateSlot, request: low }), 'ENERGY_MATCH')).toBe(WEIGHTS.ENERGY_MATCH)
  })

  it('reads the learned hour prior, scaled by how strongly it was reinforced', () => {
    const strong = ctxOf({ priors: { hourWeight: { 9: -3 }, dayWeight: {} } })
    expect(weightOf(inputOf({ ctx: strong }), 'PRIOR_HOUR')).toBe(-WEIGHTS.PRIOR_HOUR)
    const mild = ctxOf({ priors: { hourWeight: { 9: -1.5 }, dayWeight: {} } })
    expect(weightOf(inputOf({ ctx: mild }), 'PRIOR_HOUR')).toBe(-WEIGHTS.PRIOR_HOUR / 2)
  })

  it('rewards the frog for being early, and nobody else', () => {
    const early = inputOf({ isFrog: true })
    const late = inputOf({ isFrog: true, start: '2026-08-13T15:00:00', end: '2026-08-13T16:00:00' })
    expect(weightOf(early, 'FROG_FIRST')).toBeGreaterThan(weightOf(late, 'FROG_FIRST'))
    expect(scoreCandidate(inputOf()).reasons.some(r => r.code === 'FROG_FIRST')).toBe(false)
  })

  it('rewards breathing room only when there is a neighbour to keep it from', () => {
    const neighbour = {
      id: 'n', title: 'פגישה', start: '2026-08-10T10:10:00', end: '2026-08-10T11:00:00',
      mobility: 'fixed' as const, createdBy: 'user' as const, isAllDay: false,
    }
    const tight = weightOf(inputOf({ neighbours: [neighbour] }), 'BUFFER_RESPECTED')
    const roomy = weightOf(inputOf({ neighbours: [{ ...neighbour, start: '2026-08-10T14:00:00', end: '2026-08-10T15:00:00' }] }), 'BUFFER_RESPECTED')
    expect(roomy).toBeGreaterThan(tight)
    expect(scoreCandidate(inputOf()).reasons.some(r => r.code === 'BUFFER_RESPECTED')).toBe(false)
  })

  it('scores a block that matches the method session length above one that does not', () => {
    expect(weightOf(inputOf(), 'METHOD_FIT')).toBe(WEIGHTS.METHOD_FIT)
    expect(weightOf(inputOf({ end: '2026-08-10T11:00:00' }), 'METHOD_FIT')).toBe(0)
  })
})

describe('the total is the arithmetic, and the reasons are the audit trail', () => {
  it('equals the sum of its reasons', () => {
    const scored = scoreCandidate(inputOf({
      siblingDays: ['2026-08-08'],
      request: { ref: { kind: 'task' }, title: 'x', energy: 'high', deadline: '2026-08-13T17:00:00' },
    }))
    const sum = scored.reasons.reduce((s, r) => s + r.weight, 0)
    expect(scored.total).toBeCloseTo(sum, 6)
  })

  it('orders reasons best-first so explain.ts can render the top few', () => {
    const reasons = scoreCandidate(inputOf({ siblingDays: ['2026-08-10'] })).reasons
    const weights = reasons.map(r => r.weight)
    expect(weights).toEqual([...weights].sort((a, b) => b - a))
    expect(reasons[0].code).toBe('PEAK_MATCH')
  })

  it('never emits a zero-weight reason — a term that did nothing is not a reason', () => {
    expect(scoreCandidate(inputOf({ start: '2026-08-10T14:00:00', end: '2026-08-10T15:00:00' })).reasons.every(r => r.weight !== 0)).toBe(true)
  })

  it('produces byte-identical output for the same input', () => {
    const input = inputOf({ isFrog: true, siblingDays: ['2026-08-12'] })
    expect(JSON.stringify(scoreCandidate(input))).toBe(JSON.stringify(scoreCandidate(input)))
  })
})
