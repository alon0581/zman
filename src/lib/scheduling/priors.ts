/**
 * priors.ts — what the user's own corrections say about when to schedule.
 *
 * Two sources, deliberately unequal:
 *
 *   - FeedbackSignal. A `rejected` says "not here". A `moved` says "not here,
 *     *there* instead", which is strictly more information, so it counts for
 *     more and pushes in both directions at once.
 *   - AIMemory. Free Hebrew prose is not a parser input and we do not pretend
 *     otherwise: only the one phrasing the system prompt actually teaches the
 *     model to write ("rejects slots before 9:00" / "דוחה זמנים לפני 9:00") is
 *     read. Anything else is ignored rather than guessed at, because a
 *     misparsed memory silently biases every future plan.
 *
 * Weights are clamped so one loud pattern cannot outvote the whole scorer.
 */

import { AIMemory, FeedbackSignal } from '@/types'
import { Priors } from './types'
import { LocalISO } from './clock'

/**
 * Signed contributions, in "signal units". score.ts normalises by CLAMP before
 * turning them into a PRIOR_HOUR reason, so these numbers are about relative
 * strength, not about the final score scale.
 */
export const PRIOR_WEIGHTS = {
  /** They deleted an AI event that started at this hour. */
  rejectedHour: -1,
  /** They dragged work out of this hour — a stronger "no" than a delete. */
  movedFromHour: -1.5,
  /** They dragged work into this hour. The only positive evidence we ever get. */
  movedToHour: 1.5,
  /** Weekday evidence is weaker than hour evidence: a bad Tuesday is usually a bad 08:00. */
  dayFactor: 0.5,
  /** A stated pattern is worth about one observed correction. */
  memoryHour: 1,
  /** No hour may exceed this magnitude, however many times it is reinforced. */
  clamp: 3,
  /** Signal weight halves every 30 days. FeedbackSignal.at finally has a reader. */
  halfLifeDays: 30,
  /** Past this, a signal contributes exactly zero and is dropped. */
  floorDays: 120,
} as const

/** Only these keys are read. `pattern_*` records behaviour, `pref_*` a stated wish. */
const PATTERN_KEY = /^pattern_/
const PREF_KEY = /^pref_/
/** Phrases the prompt teaches: "before 9:00", "לפני 9:00", and their after-counterparts. */
const BEFORE_HOUR = /(?:before|לפני)\s*(\d{1,2})(?::\d{2})?/
const AFTER_HOUR = /(?:after|אחרי)\s*(\d{1,2})(?::\d{2})?/
/** A memory only counts as a rejection when it says so — otherwise we read it as a preference. */
const REJECTION_WORD = /reject|avoid|דוחה|נמנע|לא רוצה/

export function buildPriors(
  signals: FeedbackSignal[],
  memory: AIMemory[] = [],
  opts?: { now?: LocalISO; activePhaseId?: string; closedPhaseIds?: string[] },
): Priors {
  const hour: Record<number, number> = {}
  const day: Record<string, number> = {}

  const bumpHour = (h: number | undefined, by: number) => {
    if (h === undefined || !Number.isInteger(h) || h < 0 || h > 23) return
    hour[h] = (hour[h] ?? 0) + by
  }
  const bumpDay = (d: string | undefined, by: number) => {
    if (!d) return
    day[d] = (day[d] ?? 0) + by * PRIOR_WEIGHTS.dayFactor
  }

  for (const s of signals) {
    // Signals from a phase the user has since closed shouldn't keep steering a
    // plan that no longer belongs to that phase. A signal with no phase_id at
    // all predates phases (or is timeless) — it is kept, not specially cased.
    if (s.phase_id && opts?.closedPhaseIds?.includes(s.phase_id)) continue

    // Decay is folded into `by` here, BEFORE it lands in `hour`/`day` — the
    // ±3 clamp only ever sees the already-decayed, already-summed total at the
    // very end (see the loop below that builds hourWeight/dayWeight). Doing it
    // the other way — clamping first, decaying after — would let a handful of
    // fresh signals get capped at ±3 and then shrunk, instead of letting a pile
    // of *fresh* signals actually reach ±3 the way twenty old ones never could.
    const decay = decayFactor(s.at, opts?.now)
    if (decay === 0) continue

    if (s.type === 'rejected') {
      bumpHour(s.fromHour, PRIOR_WEIGHTS.rejectedHour * decay)
      bumpDay(s.day, PRIOR_WEIGHTS.rejectedHour * decay)
      continue
    }
    // A move is evidence about two hours: the one they left and the one they chose.
    bumpHour(s.fromHour, PRIOR_WEIGHTS.movedFromHour * decay)
    bumpHour(s.toHour, PRIOR_WEIGHTS.movedToHour * decay)
    // FeedbackSignal.day describes the original slot only, so the weekday only
    // ever learns the negative half of a move.
    bumpDay(s.day, PRIOR_WEIGHTS.movedFromHour * decay)
  }

  for (const m of memory) {
    const isPattern = PATTERN_KEY.test(m.key)
    if (!isPattern && !PREF_KEY.test(m.key)) continue
    // A pattern is recorded from a correction, so it is negative unless the text
    // says otherwise; a pref_* is something the user asked for, so it is positive.
    const sign = REJECTION_WORD.test(m.key) || REJECTION_WORD.test(m.value) ? -1 : isPattern ? -1 : 1
    const magnitude = PRIOR_WEIGHTS.memoryHour * sign

    const before = BEFORE_HOUR.exec(m.value)
    if (before) {
      const bound = Number(before[1])
      for (let h = 0; h < bound && h < 24; h++) bumpHour(h, magnitude)
    }
    const after = AFTER_HOUR.exec(m.value)
    if (after) {
      const bound = Number(after[1])
      for (let h = bound; h < 24; h++) bumpHour(h, magnitude)
    }
  }

  const hourWeight: Partial<Record<number, number>> = {}
  // Sorted so the object's key order is a function of the data, not of the order
  // signals happened to arrive in — two runs must serialise identically.
  for (const h of Object.keys(hour).map(Number).sort((a, b) => a - b)) {
    const w = clamp(hour[h])
    if (w !== 0) hourWeight[h] = w
  }
  const dayWeight: Partial<Record<string, number>> = {}
  for (const d of Object.keys(day).sort()) {
    const w = clamp(day[d])
    if (w !== 0) dayWeight[d] = w
  }

  return { hourWeight, dayWeight }
}

/** An empty Priors — the honest starting point for a user with no history. */
export function emptyPriors(): Priors {
  return { hourWeight: {}, dayWeight: {} }
}

function clamp(raw: number): number {
  return round2(Math.max(-PRIOR_WEIGHTS.clamp, Math.min(PRIOR_WEIGHTS.clamp, raw)))
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ── Time decay ───────────────────────────────────────────────────────────────
//
// FeedbackSignal.at is written with `new Date().toISOString()` (real UTC, "Z"
// suffix, milliseconds); `now` arrives as a LocalISO — naive wall-clock, no
// offset. Neither is "real UTC" once you're comparing across those two, and at
// day granularity (a 30-day half-life, a 120-day floor) a few hours of zone
// skew between the two is noise. So rather than pull in `new Date()` (banned
// in this file — see the module header) this reads the wall-clock digits
// straight out of both strings with a regex and does the subtraction with
// `Date.UTC`, which returns a plain number, not a Date instance. Same trick
// clock.ts's toWallClockInstant uses for LocalISO arithmetic, just without the
// `new Date(...)` wrapper this file isn't allowed to have.

/** Wall-clock digits (Y-M-D H:m:s, ignoring any trailing "Z"/offset/ms) as a
 *  Date.UTC-style number. Undefined when `s` doesn't even look like a timestamp. */
function wallClockDigitsToEpoch(s: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(s)
  if (!m) return undefined
  const [, y, mo, d, hh, mi, ss] = m.map(Number)
  const epoch = Date.UTC(y, mo - 1, d, hh, mi, ss)
  return Number.isNaN(epoch) ? undefined : epoch
}

/**
 * Age of `at` relative to `now`, in days. An unparseable `at` (or, defensively,
 * an unparseable `now`) reads as age 0 — full weight — rather than throwing or
 * silently dropping the signal: a signal we can't date is not evidence that it's
 * stale, and a scheduler that throws on one malformed timestamp in a 40-signal
 * FIFO is a worse failure than slightly over-weighting it. Negative ages (a
 * signal timestamped after `now`, e.g. clock skew) are floored at 0 for the same
 * reason — clock skew should never *boost* a signal past its true weight.
 */
function ageDays(at: string, now: LocalISO): number {
  const atEpoch = wallClockDigitsToEpoch(at)
  const nowEpoch = wallClockDigitsToEpoch(now)
  if (atEpoch === undefined || nowEpoch === undefined) return 0
  return Math.max(0, (nowEpoch - atEpoch) / 86_400_000)
}

/**
 * 0.5 ** (ageDays / halfLifeDays), floored to exactly 0 past floorDays.
 *
 * When `now` is absent, decay is off — the factor is exactly 1, byte-for-byte,
 * for every call site that predates this feature (all of them, today). That's
 * the compatibility mechanism, same idea as SCHEDULER_V2 elsewhere in this repo.
 */
function decayFactor(at: string, now: LocalISO | undefined): number {
  if (now === undefined) return 1
  const age = ageDays(at, now)
  // Inclusive: a signal exactly floorDays old already contributes zero, so the
  // exponential tail is never actually evaluated past this line.
  if (age >= PRIOR_WEIGHTS.floorDays) return 0
  return 0.5 ** (age / PRIOR_WEIGHTS.halfLifeDays)
}
