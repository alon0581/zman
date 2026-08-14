/**
 * priors.decay.test.ts — FeedbackSignal.at finally has a reader.
 *
 * `buildPriors` used to have no time term at all: a three-month-old signal
 * weighed exactly as much as yesterday's. These tests pin down the decay this
 * file adds — 0.5 ** (ageDays / halfLifeDays), floored to 0 past floorDays —
 * and, above all, that it is fully opt-in: no `opts.now` means no decay, byte
 * for byte, which is what makes widening the signature safe.
 *
 * House style: frozen fixtures, no `new Date()`, one regression per test.
 * `now` is always '2026-08-15T12:00:00'; every `at` below is that date shifted
 * by a hand-counted number of calendar days, spelled out as a literal so
 * nothing here depends on `Date` arithmetic either.
 */
import { describe, it, expect } from 'vitest'
import { FeedbackSignal } from '@/types'
import { buildPriors, PRIOR_WEIGHTS } from './priors'

const NOW = '2026-08-15T12:00:00'

/** Exactly PRIOR_WEIGHTS.halfLifeDays (30) days before NOW. */
const HALF_LIFE_AGO = '2026-07-16T12:00:00Z'
/** Exactly PRIOR_WEIGHTS.floorDays (120) days before NOW. */
const FLOOR_AGO = '2026-04-17T12:00:00Z'
/** One day short of the floor — 119 days before NOW. */
const JUST_INSIDE_FLOOR_AGO = '2026-04-18T12:00:00Z'
/** Well past the floor — 150 days before NOW. */
const PAST_FLOOR_AGO = '2026-03-18T12:00:00Z'

function rejected(fromHour: number, day: string | undefined, at: string, phase_id?: string): FeedbackSignal {
  return { type: 'rejected', title: 'לימוד', fromHour, day, at, phase_id }
}

function moved(fromHour: number, toHour: number, at: string, day?: string): FeedbackSignal {
  return { type: 'moved', title: 'לימוד', fromHour, toHour, day, at }
}

describe('identity: opts is fully optional', () => {
  it('with no opts, a mixed signal set produces output deep-equal to the pre-decay build', () => {
    // `at` values below are deliberately varied — one real, one garbage — to
    // prove the compatibility path never even looks at them when `now` is absent.
    const signals: FeedbackSignal[] = [
      rejected(7, 'Sun', PAST_FLOOR_AGO),
      moved(8, 20, 'not-a-real-timestamp-at-all', 'Tue'),
      rejected(21, undefined, NOW),
    ]

    const expected = {
      hourWeight: {
        7: PRIOR_WEIGHTS.rejectedHour,
        8: PRIOR_WEIGHTS.movedFromHour,
        20: PRIOR_WEIGHTS.movedToHour,
        21: PRIOR_WEIGHTS.rejectedHour,
      },
      dayWeight: {
        Sun: PRIOR_WEIGHTS.rejectedHour * PRIOR_WEIGHTS.dayFactor,
        Tue: PRIOR_WEIGHTS.movedFromHour * PRIOR_WEIGHTS.dayFactor,
      },
    }

    const noArgsAtAll = buildPriors(signals)
    expect(noArgsAtAll).toEqual(expected)
  })

  it('an empty opts object behaves identically to opts being absent entirely', () => {
    const signals: FeedbackSignal[] = [rejected(7, 'Sun', HALF_LIFE_AGO), moved(8, 20, PAST_FLOOR_AGO, 'Tue')]
    const withoutOpts = buildPriors(signals)
    const withEmptyOpts = buildPriors(signals, [], {})
    expect(withEmptyOpts).toEqual(withoutOpts)
  })
})

describe('decay factor', () => {
  it('a signal exactly halfLifeDays old contributes exactly half', () => {
    const priors = buildPriors([rejected(7, undefined, HALF_LIFE_AGO)], [], { now: NOW })
    expect(priors.hourWeight[7]).toBe(PRIOR_WEIGHTS.rejectedHour * 0.5)
  })

  it('a signal older than floorDays contributes exactly zero and is dropped', () => {
    const priors = buildPriors([rejected(7, undefined, PAST_FLOOR_AGO)], [], { now: NOW })
    expect(priors.hourWeight[7]).toBeUndefined()
  })

  it('a signal exactly floorDays old also contributes zero — the floor is inclusive', () => {
    const priors = buildPriors([rejected(7, undefined, FLOOR_AGO)], [], { now: NOW })
    expect(priors.hourWeight[7]).toBeUndefined()
  })

  it('a fresh signal (age 0) has decay factor exactly 1', () => {
    const priors = buildPriors([rejected(7, undefined, NOW)], [], { now: NOW })
    expect(priors.hourWeight[7]).toBe(PRIOR_WEIGHTS.rejectedHour)
  })

  it('decay is applied before the clamp: 20 fresh rejections on one hour still reach exactly -3', () => {
    const signals = Array.from({ length: 20 }, () => rejected(7, undefined, NOW))
    const priors = buildPriors(signals, [], { now: NOW })
    expect(priors.hourWeight[7]).toBe(-PRIOR_WEIGHTS.clamp)
  })

  it('unlike 20 fresh rejections, 20 nearly-expired ones never reach the clamp', () => {
    const signals = Array.from({ length: 20 }, () => rejected(7, undefined, JUST_INSIDE_FLOOR_AGO))
    const priors = buildPriors(signals, [], { now: NOW })
    expect(priors.hourWeight[7]).toBeDefined()
    expect(Math.abs(priors.hourWeight[7]!)).toBeLessThan(PRIOR_WEIGHTS.clamp)
  })
})

describe('defensive parsing of FeedbackSignal.at', () => {
  it('a signal with an unparseable at is kept at full weight instead of thrown or dropped', () => {
    const priors = buildPriors([rejected(7, undefined, 'definitely not a date')], [], { now: NOW })
    expect(priors.hourWeight[7]).toBe(PRIOR_WEIGHTS.rejectedHour)
  })
})

describe('phase filter', () => {
  it('drops a signal whose phase_id is in closedPhaseIds', () => {
    const priors = buildPriors([rejected(7, undefined, NOW, 'old-phase')], [], {
      now: NOW,
      closedPhaseIds: ['old-phase'],
    })
    expect(priors.hourWeight[7]).toBeUndefined()
  })

  it('keeps a signal with no phase_id at all when closedPhaseIds is given — no special case needed', () => {
    const priors = buildPriors([rejected(7, undefined, NOW)], [], {
      now: NOW,
      closedPhaseIds: ['old-phase'],
    })
    expect(priors.hourWeight[7]).toBe(PRIOR_WEIGHTS.rejectedHour)
  })

  it('keeps a signal whose phase_id is present but not in closedPhaseIds', () => {
    const priors = buildPriors([rejected(7, undefined, NOW, 'active-phase')], [], {
      now: NOW,
      closedPhaseIds: ['old-phase'],
    })
    expect(priors.hourWeight[7]).toBe(PRIOR_WEIGHTS.rejectedHour)
  })
})

describe('determinism', () => {
  it('the same input, run twice with decay and a phase filter both active, is deep-equal', () => {
    const signals: FeedbackSignal[] = [
      rejected(7, 'Sun', HALF_LIFE_AGO),
      moved(8, 20, JUST_INSIDE_FLOOR_AGO, 'Tue'),
      rejected(9, undefined, NOW, 'closed'),
    ]
    const opts = { now: NOW, closedPhaseIds: ['closed'] }
    const a = buildPriors(signals, [], opts)
    const b = buildPriors(signals, [], opts)
    expect(a).toEqual(b)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})
