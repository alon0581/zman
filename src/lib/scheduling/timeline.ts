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
 * How much empty time to hold on each side of a block. Named fields rather than
 * two positional numbers on purpose: the whole reason this type exists is that
 * the two sides differ, and `(block, 45, 20)` is a transposition waiting to
 * happen at the call site while `{ before, after }` cannot be got backwards.
 */
export interface Padding {
  before: number
  after: number
}

/**
 * The block plus the breathing room the profile asks for on each side.
 *
 * All-day blocks are never padded: they already own their whole day, and
 * inflating them would leak the buffer into neighbouring days that are free.
 *
 * ONE scalar, both edges — kept exactly as it was, because several callers
 * (blockersFor, freeGaps, and the tests that pin them) mean precisely that. When
 * the two sides differ, reach for `inflateSides` instead of widening this.
 */
export function inflate(block: BusyBlock, bufferMinutes: number): Span {
  return inflateSides(block, { before: bufferMinutes, after: bufferMinutes })
}

/**
 * The block plus a different amount of room before it and after it.
 *
 * Travel is the reason this exists and it is asymmetric by nature: the trip in
 * carries getting-ready time and the trip out does not, so the two numbers are
 * routinely unequal (see `TravelWindow` in src/lib/places/travel.ts). A single
 * scalar could only ever be one of them — taking the larger would block time
 * that is genuinely free, taking the smaller would schedule into a journey.
 *
 * Each edge is clamped at zero independently, so a negative or absent amount on
 * one side leaves that edge untouched without disturbing the other. That is also
 * what makes `inflate` a pure delegation rather than a re-implementation: with
 * before === after this is the identical span, non-positive values included.
 */
export function inflateSides(block: BusyBlock, pad: Padding): Span {
  // An all-day block already owns its whole day; padding it would leak into
  // neighbouring days that are free, in either direction.
  if (block.isAllDay) return { start: block.start, end: block.end }
  return {
    start: pad.before > 0 ? addMinutes(block.start, -pad.before) : block.start,
    end: pad.after > 0 ? addMinutes(block.end, pad.after) : block.end,
  }
}

/**
 * Every block that stands in the way of `span`, once inflated by the buffer.
 * Ordered by start then id so two runs report the same blockers in the same
 * order — the plan is only reproducible if its explanations are.
 */
export function blockersFor(span: Span, busy: BusyBlock[], bufferMinutes: number): BusyBlock[] {
  return busy
    .filter(b => {
      const pad = travelPad(b, bufferMinutes)
      return overlaps(span, pad === null ? inflate(b, bufferMinutes) : inflateSides(b, pad))
    })
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * The total room to hold on each side of one commitment: its spacing, PLUS the
 * journey to and from it.
 *
 * Lives here rather than in place.ts because it now has two callers — the
 * engine's hard filter and `blockersFor` — and this repo has been bitten twice
 * by one number living in two tables. See the long note above `spacingAround`
 * in place.ts for why travel ADDS to the spacing while a method break REPLACES
 * it, and why `drop_buffer` structurally cannot take the travel with it.
 */
export function travelPad(block: BusyBlock, spacing: number): Padding | null {
  const lead = block.leadMinutes ?? 0
  const trail = block.trailMinutes ?? 0
  // `null` rather than `{before: spacing, after: spacing}` so callers can keep
  // the symmetric fast path — which is every block on a calendar with no places
  // on it, i.e. all of them until the user declares one.
  if (lead === 0 && trail === 0) return null
  return { before: spacing + lead, after: spacing + trail }
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
 *
 * Travel does not count either, and the argument is the REVERSE of the buffer's,
 * which is why it is worth writing down rather than filing under "same as
 * buffers". A buffer is not consumed time at all; travel plainly is — an hour on
 * a bus is an hour of the user's life. It stays out anyway because the cap is a
 * ceiling on *scheduled work*, and travel already shrinks the day once by
 * removing the slots it covers. Charging it a second time would mean a student
 * with a 90-minute commute lost three hours of their cap to it — the day would
 * come out visibly emptier than the same day with the same lecture and no
 * declared place, which is the one thing places must never do.
 *
 * If plans start coming back thinner than they should once places are in real
 * use, THIS is the number to revisit — not the padding in place.ts.
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
