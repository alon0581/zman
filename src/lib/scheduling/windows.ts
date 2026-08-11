/**
 * windows.ts — the stretches of time the user is willing to be scheduled in.
 *
 * A DayWindow belongs to exactly one calendar day, on purpose. Everything
 * downstream is per-day — the daily cap, theme days, the "one session per day"
 * spread — so making the day the unit here means "how much of Tuesday is even
 * available" has an answer instead of being an implicit loop bound buried in
 * the candidate generator, which is exactly where the old getFreeSlots hid it.
 *
 * Pure: no `new Date()` except through clock.ts, no I/O.
 */

import { LocalISO, addMinutes, localDateKey, minutesBetween, parseLocal, startOfLocalDay } from './clock'
import { DayWindow, SchedulingProfile, Weekday } from './types'

/**
 * Fallback only, for a profile that doesn't say. The real answer lives in
 * `SchedulingProfile.weekendDays`, because which days someone keeps clear is a
 * fact about that person, not a property of the algorithm: the Israeli working
 * week runs Sunday to Thursday, but plenty of students study on Friday and only
 * keep Shabbat. Either way, holding *some* days back is what makes the
 * `use_weekend` relaxation an honest offer ("I could place 3 more if you let me
 * use the weekend") instead of a no-op.
 */
export const WEEKEND_DAYS: readonly Weekday[] = [5, 6]

export interface WindowOptions {
  /** Overrides profile.dayStartHour — used by the `extend_day` relaxation. */
  dayStartHour?: number
  /** Overrides profile.dayEndHour — used by the `extend_day` relaxation. */
  dayEndHour?: number
  /** Include Friday and Saturday — used by the `use_weekend` relaxation. */
  includeWeekend?: boolean
}

/** Clamps an hour into 0..24. 24 is legal and means "midnight at the end of the day". */
function clampHour(h: number): number {
  if (!Number.isFinite(h)) return 0
  return Math.min(Math.max(Math.trunc(h), 0), 24)
}

/**
 * The LocalISO for `hour` o'clock on `day`. Going through addMinutes rather
 * than string-building is what lets hour 24 roll cleanly into the next day's
 * midnight instead of producing the invalid "T24:00:00".
 */
export function dayHourISO(day: string, hour: number): LocalISO {
  return addMinutes(`${day}T00:00:00`, hour * 60)
}

/** 0 = Sunday … 6 = Saturday, for a "YYYY-MM-DD" day key. */
export function weekdayOf(day: string): Weekday {
  return parseLocal(`${day}T00:00:00`).getDay() as Weekday
}

/** Every "YYYY-MM-DD" key from `from`'s day through `to`'s day, inclusive. */
export function eachDayKey(from: LocalISO, to: LocalISO): string[] {
  const last = localDateKey(to)
  const days: string[] = []
  // Day keys are fixed-width, so a lexical compare is a chronological one. A
  // reversed horizon simply yields nothing rather than looping forever.
  for (let cursor = startOfLocalDay(from); localDateKey(cursor) <= last; cursor = addMinutes(cursor, 24 * 60)) {
    days.push(localDateKey(cursor))
  }
  return days
}

/**
 * The user's available windows across the horizon, one per day, already clipped
 * to the horizon at both ends.
 *
 * A `dayEndHour` at or before `dayStartHour` means the user's day runs past
 * midnight (sleep_time 01:00). Since a window belongs to one day, that end is
 * clamped to the day's own 24:00 — spilling into tomorrow would put a "Monday"
 * block on Tuesday and quietly break every per-day rule downstream.
 */
export function buildDayWindows(
  profile: SchedulingProfile,
  horizon: { from: LocalISO; to: LocalISO },
  opts: WindowOptions = {}
): DayWindow[] {
  const startHour = clampHour(opts.dayStartHour ?? profile.dayStartHour)
  const rawEndHour = clampHour(opts.dayEndHour ?? profile.dayEndHour)
  const endHour = rawEndHour <= startHour ? 24 : rawEndHour
  const includeWeekend = opts.includeWeekend ?? false
  const weekendDays = profile.weekendDays ?? WEEKEND_DAYS

  const windows: DayWindow[] = []
  for (const day of eachDayKey(horizon.from, horizon.to)) {
    if (!includeWeekend && weekendDays.includes(weekdayOf(day))) continue

    const dayStart = dayHourISO(day, startHour)
    const dayEnd = dayHourISO(day, endHour)
    const start = dayStart > horizon.from ? dayStart : horizon.from
    const end = dayEnd < horizon.to ? dayEnd : horizon.to
    if (start >= end) continue

    windows.push({ day, start, end })
  }
  return windows
}

/**
 * Narrows windows to `[floor, ceiling]`, dropping anything that can no longer
 * hold `minMinutes`. The engine uses this to apply `now`, `earliest` and
 * `deadline` without rebuilding the window list from scratch each time.
 */
export function clipWindows(
  windows: DayWindow[],
  floor: LocalISO | undefined,
  ceiling: LocalISO | undefined,
  minMinutes = 0
): DayWindow[] {
  const out: DayWindow[] = []
  for (const w of windows) {
    const start = floor && floor > w.start ? floor : w.start
    const end = ceiling && ceiling < w.end ? ceiling : w.end
    if (start >= end) continue
    if (minMinutes > 0 && minutesOf({ day: w.day, start, end }) < minMinutes) continue
    out.push({ day: w.day, start, end })
  }
  return out
}

/** Length of a window in whole minutes. */
export function minutesOf(w: DayWindow): number {
  return minutesBetween(w.start, w.end)
}
