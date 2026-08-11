import { describe, it, expect } from 'vitest'
import { SchedulingProfile } from './types'
import { buildDayWindows, clipWindows, eachDayKey, minutesOf, weekdayOf, WEEKEND_DAYS } from './windows'

/**
 * August 2026 is used throughout: the 10th is a Monday and the 14th–15th are the
 * Friday/Saturday weekend, so weekday and weekend behaviour can be asserted
 * against real dates rather than against whatever day the tests happen to run.
 */
const profile: SchedulingProfile = {
  timezone: 'Asia/Jerusalem',
  dayStartHour: 9,
  dayEndHour: 17,
  peakStartHour: 9,
  peakEndHour: 12,
  bufferMinutes: 10,
}

const horizon = { from: '2026-08-10T00:00:00', to: '2026-08-16T00:00:00' }

describe('eachDayKey', () => {
  it('is inclusive at both ends', () => {
    expect(eachDayKey('2026-08-10T23:00:00', '2026-08-12T01:00:00'))
      .toEqual(['2026-08-10', '2026-08-11', '2026-08-12'])
  })

  it('yields nothing for a reversed range instead of looping', () => {
    expect(eachDayKey('2026-08-12T00:00:00', '2026-08-10T00:00:00')).toEqual([])
  })
})

describe('weekdayOf', () => {
  it('reads Sunday as 0 and Saturday as 6', () => {
    expect(weekdayOf('2026-08-09')).toBe(0)
    expect(weekdayOf('2026-08-15')).toBe(6)
  })

  it('agrees with WEEKEND_DAYS about which days are the weekend', () => {
    expect(WEEKEND_DAYS.includes(weekdayOf('2026-08-14'))).toBe(true)  // Friday
    expect(WEEKEND_DAYS.includes(weekdayOf('2026-08-13'))).toBe(false) // Thursday
  })
})

describe('buildDayWindows', () => {
  it('gives one window per weekday, at the profile hours', () => {
    const windows = buildDayWindows(profile, horizon)
    expect(windows.map(w => w.day)).toEqual(['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13'])
    expect(windows[0]).toEqual({ day: '2026-08-10', start: '2026-08-10T09:00:00', end: '2026-08-10T17:00:00' })
  })

  it('keeps the weekend clear by default and fills it on request', () => {
    const withWeekend = buildDayWindows(profile, horizon, { includeWeekend: true })
    expect(withWeekend.map(w => w.day)).toContain('2026-08-14')
    expect(withWeekend.map(w => w.day)).toContain('2026-08-15')
  })

  it('clips the first and last window to the horizon', () => {
    const windows = buildDayWindows(profile, { from: '2026-08-10T11:30:00', to: '2026-08-11T10:00:00' })
    expect(windows[0].start).toBe('2026-08-10T11:30:00')
    expect(windows[1].end).toBe('2026-08-11T10:00:00')
  })

  it('clamps a day that runs past midnight to its own 24:00 rather than spilling into tomorrow', () => {
    // sleep_time 01:00 makes dayEndHour < dayStartHour.
    const nightOwl = { ...profile, dayStartHour: 20, dayEndHour: 1 }
    const windows = buildDayWindows(nightOwl, { from: '2026-08-10T00:00:00', to: '2026-08-12T00:00:00' })
    expect(windows[0]).toEqual({ day: '2026-08-10', start: '2026-08-10T20:00:00', end: '2026-08-11T00:00:00' })
  })

  it('drops a day the horizon leaves no room in', () => {
    const windows = buildDayWindows(profile, { from: '2026-08-10T18:00:00', to: '2026-08-11T08:00:00' })
    expect(windows).toEqual([])
  })

  it('honours an extended day, which is what the extend_day relaxation buys', () => {
    const windows = buildDayWindows(profile, horizon, { dayStartHour: 8, dayEndHour: 18 })
    expect(minutesOf(windows[0])).toBe(10 * 60)
  })
})

describe('clipWindows', () => {
  const windows = buildDayWindows(profile, horizon)

  it('applies a floor and a ceiling', () => {
    const clipped = clipWindows(windows, '2026-08-11T10:00:00', '2026-08-12T12:00:00')
    expect(clipped.map(w => w.day)).toEqual(['2026-08-11', '2026-08-12'])
    expect(clipped[0].start).toBe('2026-08-11T10:00:00')
    expect(clipped[1].end).toBe('2026-08-12T12:00:00')
  })

  it('drops windows too short to hold the block', () => {
    const clipped = clipWindows(windows, '2026-08-10T16:30:00', undefined, 60)
    expect(clipped.map(w => w.day)).not.toContain('2026-08-10')
  })
})
