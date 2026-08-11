import { describe, it, expect } from 'vitest'
import { explainReasons, renderReason } from './explain'
import { ReasonCode, ScoredReason } from './types'

const ALL_CODES: ReasonCode[] = [
  'PEAK_MATCH', 'METHOD_FIT', 'SPREAD', 'DEADLINE_MARGIN', 'PRIOR_HOUR',
  'THEME_DAY', 'ENERGY_MATCH', 'FROG_FIRST', 'BUFFER_RESPECTED', 'EARLIEST_AVAILABLE',
]

function reason(code: ReasonCode, weight: number, detail?: ScoredReason['detail']): ScoredReason {
  return { code, weight, detail }
}

describe('every ReasonCode renders a non-empty sentence in both languages', () => {
  for (const code of ALL_CODES) {
    it(`${code}: positive weight, with detail`, () => {
      const r = reason(code, 5, { hour: 9, daysLeft: 3, minutes: 25, hours: 2, days: 1, day: 'Sun', category: 'study', bufferMinutes: 10 })
      const he = renderReason(r, true)
      const en = renderReason(r, false)
      expect(he.length).toBeGreaterThan(0)
      expect(en.length).toBeGreaterThan(0)
      expect(he).not.toMatch(/undefined/i)
      expect(en).not.toMatch(/undefined/i)
    })

    it(`${code}: positive weight, no detail`, () => {
      const r = reason(code, 5)
      const he = renderReason(r, true)
      const en = renderReason(r, false)
      expect(he.length).toBeGreaterThan(0)
      expect(en.length).toBeGreaterThan(0)
      expect(he).not.toMatch(/undefined/i)
      expect(en).not.toMatch(/undefined/i)
    })

    it(`${code}: negative weight is phrased as an honest trade-off`, () => {
      const r = reason(code, -3, { hour: 9 })
      const he = renderReason(r, true)
      const en = renderReason(r, false)
      expect(he.length).toBeGreaterThan(0)
      expect(en.length).toBeGreaterThan(0)
      expect(he).not.toMatch(/undefined/i)
      expect(en).not.toMatch(/undefined/i)
      // Trade-off phrasing should contain a "but" / "אבל" concession, not read
      // as a plain positive.
      expect(en.toLowerCase()).toMatch(/but/)
      expect(he).toMatch(/אבל/)
    })
  }
})

describe('explainReasons', () => {
  it('sorts by weight descending, best reason first', () => {
    const reasons: ScoredReason[] = [
      reason('EARLIEST_AVAILABLE', 1),
      reason('PEAK_MATCH', 9, { hour: 9 }),
      reason('METHOD_FIT', 4, { minutes: 25 }),
    ]
    const out = explainReasons(reasons, true, 3)
    expect(out[0]).toBe(renderReason(reasons[1], true)) // PEAK_MATCH, weight 9
    expect(out[1]).toBe(renderReason(reasons[2], true)) // METHOD_FIT, weight 4
    expect(out[2]).toBe(renderReason(reasons[0], true)) // EARLIEST_AVAILABLE, weight 1
  })

  it('respects the limit (default 3)', () => {
    const reasons: ScoredReason[] = ALL_CODES.map((code, i) => reason(code, ALL_CODES.length - i))
    expect(explainReasons(reasons, true)).toHaveLength(3)
    expect(explainReasons(reasons, true, 5)).toHaveLength(5)
    expect(explainReasons(reasons, false, 1)).toHaveLength(1)
    expect(explainReasons([], true)).toHaveLength(0)
  })

  it('never leaks the literal string "undefined" across a full mixed batch', () => {
    const reasons: ScoredReason[] = [
      reason('PEAK_MATCH', 5),
      reason('SPREAD', -2),
      reason('THEME_DAY', 3, { day: 'Tue' }), // category missing on purpose
      reason('BUFFER_RESPECTED', -1),
      reason('DEADLINE_MARGIN', 7, { daysLeft: 2 }),
    ]
    for (const isHe of [true, false]) {
      for (const s of explainReasons(reasons, isHe, 10)) {
        expect(s).not.toMatch(/undefined/i)
      }
    }
  })

  it('a negative weight never reads as if it were a positive', () => {
    const negative = reason('PEAK_MATCH', -4)
    const positive = reason('PEAK_MATCH', 4, { hour: 9 })
    expect(renderReason(negative, true)).not.toBe(renderReason(positive, true))
    expect(renderReason(negative, false)).not.toBe(renderReason(positive, false))
  })
})
