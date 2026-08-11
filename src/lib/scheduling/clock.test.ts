import { describe, it, expect } from 'vitest'
import {
  toLocalISO,
  parseLocal,
  nowLocal,
  addMinutes,
  minutesBetween,
  startOfLocalDay,
  localDateKey,
} from './clock'

/**
 * These tests guard one thing above all: that a UTC-flavoured string can never
 * be mistaken for a LocalISO. That confusion is the bug that put suggested slots
 * hours away from where they belonged, so it gets the most coverage here.
 */

describe('the naive-local invariant', () => {
  it('never emits a Z suffix or an offset', () => {
    expect(toLocalISO(new Date(2026, 7, 11, 14, 30, 0))).toBe('2026-08-11T14:30:00')
    expect(toLocalISO(new Date(2026, 0, 1, 0, 0, 0))).not.toMatch(/[zZ]$|[+-]\d{2}:?\d{2}$/)
  })

  it('rejects a UTC string instead of silently shifting it', () => {
    expect(() => parseLocal('2026-08-11T14:30:00Z')).toThrow(/naive LocalISO/)
    expect(() => parseLocal('2026-08-11T14:30:00+03:00')).toThrow(/naive LocalISO/)
    expect(() => parseLocal('2026-08-11T14:30:00-0500')).toThrow(/naive LocalISO/)
  })

  it('round-trips a wall-clock time unchanged', () => {
    const s = '2026-08-11T09:15:00'
    expect(toLocalISO(parseLocal(s))).toBe(s)
  })
})

describe('arithmetic stays in wall-clock terms', () => {
  it('adds and subtracts minutes', () => {
    expect(addMinutes('2026-08-11T09:00:00', 90)).toBe('2026-08-11T10:30:00')
    expect(addMinutes('2026-08-11T09:00:00', -30)).toBe('2026-08-11T08:30:00')
  })

  it('crosses midnight correctly', () => {
    expect(addMinutes('2026-08-11T23:30:00', 60)).toBe('2026-08-12T00:30:00')
  })

  it('measures a gap, signed', () => {
    expect(minutesBetween('2026-08-11T09:00:00', '2026-08-11T10:30:00')).toBe(90)
    expect(minutesBetween('2026-08-11T10:30:00', '2026-08-11T09:00:00')).toBe(-90)
  })

  it('finds the start of the local day', () => {
    expect(startOfLocalDay('2026-08-11T23:59:59')).toBe('2026-08-11T00:00:00')
  })

  it('extracts a day-grouping key', () => {
    expect(localDateKey('2026-08-11T23:59:59')).toBe('2026-08-11')
  })
})

describe('DST boundaries do not corrupt wall-clock arithmetic', () => {
  // Israel springs forward on 2026-03-27 (02:00 -> 03:00) and falls back on
  // 2026-10-25. Because LocalISO carries no offset, the engine's arithmetic is
  // pure calendar math and must be unaffected either way.
  it('adds a day across spring-forward without losing an hour', () => {
    expect(addMinutes('2026-03-27T01:30:00', 24 * 60)).toBe('2026-03-28T01:30:00')
  })

  it('adds a day across fall-back without repeating an hour', () => {
    expect(addMinutes('2026-10-25T01:30:00', 24 * 60)).toBe('2026-10-26T01:30:00')
  })

  it('measures a 24-hour span as exactly 1440 minutes across a DST change', () => {
    expect(minutesBetween('2026-03-27T12:00:00', '2026-03-28T12:00:00')).toBe(1440)
  })
})

describe('nowLocal', () => {
  it('produces a parseable LocalISO for an IANA zone', () => {
    const s = nowLocal('Asia/Jerusalem')
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
    expect(() => parseLocal(s)).not.toThrow()
  })

  it('falls back to environment local time on a bogus zone rather than throwing', () => {
    expect(() => nowLocal('Not/AZone')).not.toThrow()
    expect(nowLocal('Not/AZone')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
  })

  it('reports a different wall clock for zones that are hours apart', () => {
    // Same instant, two zones — the wall-clock strings must not match.
    expect(nowLocal('Asia/Jerusalem')).not.toBe(nowLocal('America/Los_Angeles'))
  })
})
