/**
 * timeline.ts — what is already taken, and therefore what is not.
 *
 * Two bugs from the old getFreeSlots are closed here by construction:
 *
 *   1. `is_all_day` was written on creation and never read again, so a
 *      three-day trip blocked nothing and study sessions landed inside reserve
 *      duty. An all-day event becomes a block spanning 00:00 of its first day
 *      to 24:00 of its last, so it cannot be scheduled through.
 *   2. Events were filtered by "does the start time fall on this day", which
 *      makes a multi-day event invisible from its second day onward. Nothing
 *      here filters by start day — overlap is always tested span against span.
 *
 * Blocks keep their identity all the way through. Merging happens only where a
 * merged view is actually what is wanted (free-gap iteration, day load); the
 * hard filter works against individual blocks because "which event blocked me,
 * and is it movable" is the whole difference between `blocked_by_fixed` and a
 * repair.
 */

import { CalendarEvent } from '@/types'
import { LocalISO, addMinutes, localDateKey, minutesBetween, parseLocal } from './clock'
import { classifyMobility } from './mobilityClassifier'
import { BusyBlock, DayWindow } from './types'

/** A bare stretch of time. A BusyBlock without the identity. */
export interface Span {
  start: LocalISO
  end: LocalISO
}

/** Half-open overlap: touching at an edge (09:00–10:00 and 10:00–11:00) is not a clash. */
export function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end
}

/** Minutes two spans share. 0 when they only touch or miss entirely. */
export function overlapMinutes(a: Span, b: Span): number {
  const start = a.start > b.start ? a.start : b.start
  const end = a.end < b.end ? a.end : b.end
  return end > start ? minutesBetween(start, end) : 0
}

/**
 * Converts stored events into BusyBlocks.
 *
 * Times must already be naive LocalISO — a UTC string is rejected loudly here
 * rather than being silently compared against wall-clock times two or three
 * hours away, which is the precise failure clock.ts exists to prevent.
 */
export function toBusyBlocks(events: CalendarEvent[]): BusyBlock[] {
  return events.map(toBusyBlock)
}

function toBusyBlock(ev: CalendarEvent): BusyBlock {
  const start = assertLocal(ev.start_time, ev, 'start_time')
  const end = assertLocal(ev.end_time, ev, 'end_time')
  const span = ev.is_all_day ? allDaySpan(start, end) : { start, end: end > start ? end : start }

  return {
    id: ev.id,
    title: ev.title,
    start: span.start,
    end: span.end,
    // A stored mobility_type is the user's own decision (possibly a manual
    // override) and always wins; the classifier only fills the gap for events
    // written before mobility existed.
    mobility: ev.mobility_type ?? classifyMobility(ev.title, ev.created_by),
    createdBy: ev.created_by,
    isAllDay: ev.is_all_day,
    seriesId: ev.series_id,
  }
}

function assertLocal(value: string, ev: CalendarEvent, field: string): LocalISO {
  try {
    parseLocal(value)
  } catch (err) {
    throw new Error(`[timeline.ts] event ${ev.id} ("${ev.title}") has a non-LocalISO ${field}: ${(err as Error).message}`)
  }
  return value
}

/**
 * The full days an all-day event owns: 00:00 of its first day through 24:00 of
 * its last.
 *
 * An end of exactly midnight on a later day is the exclusive boundary calendars
 * conventionally use for "through yesterday", so it must not claim a day the
 * user is genuinely free on.
 */
function allDaySpan(start: LocalISO, end: LocalISO): Span {
  const firstDay = localDateKey(start)
  let lastDay = localDateKey(end)
  if (end.slice(11) === '00:00:00' && lastDay > firstDay) {
    lastDay = localDateKey(addMinutes(`${lastDay}T00:00:00`, -1))
  }
  if (lastDay < firstDay) lastDay = firstDay
  return { start: `${firstDay}T00:00:00`, end: addMinutes(`${lastDay}T00:00:00`, 24 * 60) }
}

/**
 * The block plus the breathing room the profile asks for on each side.
 *
 * All-day blocks are never padded: they already own their whole day, and
 * inflating them would leak the buffer into neighbouring days that are free.
 */
export function inflate(block: BusyBlock, bufferMinutes: number): Span {
  if (block.isAllDay || bufferMinutes <= 0) return { start: block.start, end: block.end }
  return { start: addMinutes(block.start, -bufferMinutes), end: addMinutes(block.end, bufferMinutes) }
}

/**
 * Every block that stands in the way of `span`, once inflated by the buffer.
 * Ordered by start then id so two runs report the same blockers in the same
 * order — the plan is only reproducible if its explanations are.
 */
export function blockersFor(span: Span, busy: BusyBlock[], bufferMinutes: number): BusyBlock[] {
  return busy
    .filter(b => overlaps(span, inflate(b, bufferMinutes)))
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Merges overlapping and touching spans into the smallest equivalent set. */
export function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
  const merged: Span[] = []
  for (const s of sorted) {
    const last = merged[merged.length - 1]
    if (last && s.start <= last.end) {
      if (s.end > last.end) last.end = s.end
    } else {
      merged.push({ start: s.start, end: s.end })
    }
  }
  return merged
}

/** The gaps left inside a window once every (buffered) commitment is removed. */
export function freeGaps(window: DayWindow, busy: BusyBlock[], bufferMinutes: number): Span[] {
  const taken = mergeSpans(
    busy
      .map(b => inflate(b, bufferMinutes))
      .filter(s => overlaps(s, window))
  )
  const gaps: Span[] = []
  let cursor = window.start
  for (const t of taken) {
    if (t.start > cursor) gaps.push({ start: cursor, end: t.start < window.end ? t.start : window.end })
    if (t.end > cursor) cursor = t.end
    if (cursor >= window.end) break
  }
  if (cursor < window.end) gaps.push({ start: cursor, end: window.end })
  return gaps.filter(g => g.start < g.end)
}

/**
 * Committed minutes inside a window. Used for the daily cap, which types.ts
 * defines as "across everything" — so existing commitments count, not just what
 * this plan added. Buffers deliberately do not: they are breathing room, not
 * scheduled time, and charging them to the cap would shrink the day twice.
 */
export function busyMinutesIn(window: DayWindow, busy: BusyBlock[]): number {
  // Narrowed to the window before merging. Blocks elsewhere in the horizon
  // contribute nothing once clipped, and merging the whole calendar to discover
  // that meant sorting every event for every candidate slot considered.
  const inside: Span[] = []
  for (const b of busy) {
    if (b.start < window.end && window.start < b.end) inside.push({ start: b.start, end: b.end })
  }
  return mergeSpans(inside).reduce((sum, s) => sum + overlapMinutes(s, window), 0)
}
