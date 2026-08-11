/**
 * clock.ts — the shared time vocabulary for the scheduling engine.
 *
 * ── THE INVARIANT (read this before touching anything below) ───────────────
 *
 *   LocalISO is a NAIVE LOCAL timestamp: "2026-08-11T14:00:00"
 *
 *   It NEVER carries a "Z" suffix and NEVER carries a UTC offset
 *   ("+03:00", "-05:00", etc). It is not UTC. It is not "some timezone" —
 *   it is wall-clock time, the numbers a person would read off a clock,
 *   with no timezone attached at all.
 *
 *   The bug class this file exists to prevent: somewhere in this codebase,
 *   `new Date().toISOString()` (which IS UTC, and DOES carry a "Z") gets
 *   compared against, subtracted from, or stored alongside a naive local
 *   string like the one above — as if they were the same kind of value.
 *   They are not. Mixing them silently produces times that are off by
 *   whatever the server's UTC offset happens to be (2-3 hours for
 *   Asia/Jerusalem), and the bug does not announce itself — it just quietly
 *   schedules things at the wrong hour.
 *
 *   The rule going forward: anything that touches scheduling logic works in
 *   LocalISO, exclusively, end to end. Never call `.toISOString()` on a
 *   value that is going to be compared against a LocalISO. Never hand a
 *   LocalISO to something expecting real UTC. If you need to cross that
 *   boundary, do it explicitly and in one place, not by accident.
 *
 * ── Why "naive" instead of storing real Date/UTC everywhere ─────────────────
 *
 *   The whole point of a personal scheduler is "the user's 2pm", not "2pm
 *   somewhere". Keeping the wall-clock number as the source of truth (and
 *   only resolving a real timezone at the edges — e.g. when reading the
 *   user's IANA zone off their profile) means the arithmetic in the engine
 *   never has to think about DST or offsets at all. That's the deal this
 *   file is built around.
 *
 * All helpers below are pure: same input → same output, no I/O, no mutation.
 * Nothing in the app imports this yet — it is being introduced ahead of the
 * scheduling engine that will consume it.
 */

import { format, parseISO } from 'date-fns'

/**
 * A naive local timestamp, e.g. "2026-08-11T14:00:00".
 * Never a "Z" suffix, never a UTC offset. See the file header.
 */
export type LocalISO = string

// A LocalISO must not end in "Z" (UTC marker) or a "+HH:MM"/"-HH:MM" offset.
// This is the exact shape of the bug this file exists to prevent, so we
// fail loudly the moment a UTC-flavoured string tries to enter this module
// instead of quietly producing a time that's off by a few hours.
const OFFSET_OR_Z_SUFFIX = /(?:[zZ]|[+-]\d{2}:?\d{2})$/

function assertNaiveLocal(s: string, fn: string): void {
  if (OFFSET_OR_Z_SUFFIX.test(s)) {
    throw new Error(
      `[clock.ts] ${fn}() received "${s}", which looks like a UTC/offset timestamp, ` +
      `not a naive LocalISO string. LocalISO must never carry a "Z" suffix or a UTC ` +
      `offset — see the invariant documented at the top of clock.ts.`
    )
  }
}

/**
 * Formats a Date's LOCAL wall-clock fields (not UTC) as a LocalISO string.
 * This is the one place allowed to read a Date's local getters for the
 * purpose of producing a LocalISO — everything else should go through here.
 */
export function toLocalISO(d: Date): LocalISO {
  return format(d, "yyyy-MM-dd'T'HH:mm:ss")
}

/**
 * Parses a LocalISO string into a Date whose local getters (getHours(),
 * getDate(), ...) reproduce the same wall-clock numbers. Throws if handed
 * something that looks like a UTC/offset timestamp instead.
 */
export function parseLocal(s: LocalISO): Date {
  assertNaiveLocal(s, 'parseLocal')
  return parseISO(s)
}

/**
 * "Now", as a LocalISO — i.e. the wall-clock time as it appears in the given
 * IANA timezone (e.g. "Asia/Jerusalem"). Mirrors the `userNow` approach in
 * src/app/api/chat/route.ts (Intl.DateTimeFormat.formatToParts against the
 * real UTC "now"), but returns the naive string directly instead of routing
 * it back through `new Date(...)`.
 *
 * Falls back to the plain local wall-clock time of whatever environment this
 * code is running in when no timezone is given (or the timezone is invalid).
 */
export function nowLocal(timezone?: string): LocalISO {
  if (!timezone) return toLocalISO(new Date())
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date())
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00'
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`
  } catch {
    return toLocalISO(new Date())
  }
}

// ── Arithmetic: deliberately timezone-free ──────────────────────────────────
//
// `parseLocal` builds a Date in whatever timezone the *host* happens to run in,
// so doing arithmetic on it leaks that machine's DST rules into results that are
// supposed to be pure wall-clock math. That is not hypothetical: adding 1440
// minutes across Israel's autumn transition returned 00:30 instead of 01:30 on a
// developer machine set to Asia/Jerusalem, while a UTC server produced 01:30 —
// the same code, two answers, decided by an environment variable.
//
// So the arithmetic below never touches local getters. It reads the wall-clock
// fields into a UTC-backed instant, computes there (UTC has no DST, ever), and
// reads the wall-clock fields back out. Host timezone becomes irrelevant.

/** Reads the wall-clock fields of a LocalISO into a UTC-backed instant. */
function toWallClockInstant(s: LocalISO, fn: string): Date {
  assertNaiveLocal(s, fn)
  const [datePart, timePart = '00:00:00'] = s.split('T')
  const [y, m, d] = datePart.split('-').map(Number)
  const [hh, mm, ss] = timePart.split(':').map(Number)
  const instant = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0, ss ?? 0))
  if (isNaN(instant.getTime())) throw new Error(`[clock.ts] ${fn}() received an unparseable LocalISO: "${s}"`)
  return instant
}

/** Reads the wall-clock fields back out of a UTC-backed instant. */
function fromWallClockInstant(d: Date): LocalISO {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
         `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

/** Adds (or subtracts, for negative n) n minutes to a LocalISO, staying in LocalISO. */
export function addMinutes(s: LocalISO, n: number): LocalISO {
  return fromWallClockInstant(new Date(toWallClockInstant(s, 'addMinutes').getTime() + n * 60_000))
}

/** Whole minutes from `a` to `b` (positive when `b` is later than `a`). */
export function minutesBetween(a: LocalISO, b: LocalISO): number {
  const from = toWallClockInstant(a, 'minutesBetween').getTime()
  const to   = toWallClockInstant(b, 'minutesBetween').getTime()
  return Math.trunc((to - from) / 60_000)
}

/** Midnight (00:00:00) of the same local day as `s`. */
export function startOfLocalDay(s: LocalISO): LocalISO {
  assertNaiveLocal(s, 'startOfLocalDay')
  return `${localDateKey(s)}T00:00:00`
}

/** The "YYYY-MM-DD" date part of a LocalISO — useful as a day-grouping key. */
export function localDateKey(s: LocalISO): string {
  assertNaiveLocal(s, 'localDateKey')
  return s.slice(0, 10)
}
