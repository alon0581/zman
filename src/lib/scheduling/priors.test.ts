import { describe, it, expect } from 'vitest'
import { AIMemory, FeedbackSignal } from '@/types'
import { buildPriors, emptyPriors, PRIOR_WEIGHTS } from './priors'

function rejected(fromHour: number, day?: string): FeedbackSignal {
  return { type: 'rejected', title: 'לימוד', fromHour, day, at: '2026-08-01T00:00:00' }
}

function moved(fromHour: number, toHour: number, day?: string): FeedbackSignal {
  return { type: 'moved', title: 'לימוד', fromHour, toHour, day, at: '2026-08-01T00:00:00' }
}

function memoryOf(key: string, value: string): AIMemory {
  return { id: key, user_id: 'u', key, value, learned_from: 'behavior', created_at: '2026-08-01T00:00:00' }
}

describe('feedback signals', () => {
  it('turns a rejection into a negative hour', () => {
    expect(buildPriors([rejected(7)]).hourWeight[7]).toBe(PRIOR_WEIGHTS.rejectedHour)
  })

  it('reads a move as evidence about both hours, and weighs it above a rejection', () => {
    const priors = buildPriors([moved(8, 20)])
    expect(priors.hourWeight[8]).toBe(PRIOR_WEIGHTS.movedFromHour)
    expect(priors.hourWeight[20]).toBe(PRIOR_WEIGHTS.movedToHour)
    expect(Math.abs(priors.hourWeight[8]!)).toBeGreaterThan(Math.abs(PRIOR_WEIGHTS.rejectedHour))
  })

  it('records the weekday more weakly than the hour', () => {
    const priors = buildPriors([rejected(7, 'Sun')])
    expect(priors.dayWeight.Sun).toBe(PRIOR_WEIGHTS.rejectedHour * PRIOR_WEIGHTS.dayFactor)
  })

  it('clamps a hour that is hammered over and over', () => {
    const priors = buildPriors(Array.from({ length: 20 }, () => rejected(7)))
    expect(priors.hourWeight[7]).toBe(-PRIOR_WEIGHTS.clamp)
  })

  it('ignores an out-of-range or missing hour rather than inventing a key', () => {
    const priors = buildPriors([rejected(99), { type: 'rejected', title: 'x', at: '2026-08-01T00:00:00' }])
    expect(priors.hourWeight).toEqual({})
  })

  it('omits hours that cancelled out', () => {
    // Rejected at 9, then moved *into* 9 later — the evidence is genuinely mixed.
    const priors = buildPriors([rejected(9), rejected(9), rejected(9), moved(14, 9), moved(15, 9)])
    expect(priors.hourWeight[9]).toBeUndefined()
  })
})

describe('memory is read narrowly, and only where the prompt taught a phrasing', () => {
  it('reads a Hebrew rejection pattern as a negative on the hours before the bound', () => {
    const priors = buildPriors([], [memoryOf('pattern_reject_early', 'דוחה זמנים לפני 9:00')])
    expect(priors.hourWeight[8]).toBe(-PRIOR_WEIGHTS.memoryHour)
    expect(priors.hourWeight[9]).toBeUndefined()
  })

  it('reads an English rejection pattern the same way', () => {
    const priors = buildPriors([], [memoryOf('pattern_reject_early', 'rejects slots before 9:00')])
    expect(priors.hourWeight[0]).toBe(-PRIOR_WEIGHTS.memoryHour)
  })

  it('reads a stated preference as a positive', () => {
    const priors = buildPriors([], [memoryOf('pref_study_time', 'ערב, אחרי 20:00')])
    expect(priors.hourWeight[21]).toBe(PRIOR_WEIGHTS.memoryHour)
    expect(priors.hourWeight[19]).toBeUndefined()
  })

  it('ignores memory it was not taught to parse instead of guessing', () => {
    const priors = buildPriors([], [
      memoryOf('occupation', 'סטודנט להנדסת תוכנה, שנה ג'),
      memoryOf('pattern_notes', 'עובד טוב יותר כשיש מוזיקה'),
    ])
    expect(priors).toEqual(emptyPriors())
  })
})

describe('determinism', () => {
  it('serialises identically regardless of the order signals arrived in', () => {
    const a = buildPriors([rejected(7), moved(8, 20), rejected(21, 'Tue')])
    const b = buildPriors([rejected(21, 'Tue'), rejected(7), moved(8, 20)])
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})
