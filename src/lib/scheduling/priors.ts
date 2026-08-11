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
} as const

/** Only these keys are read. `pattern_*` records behaviour, `pref_*` a stated wish. */
const PATTERN_KEY = /^pattern_/
const PREF_KEY = /^pref_/
/** Phrases the prompt teaches: "before 9:00", "לפני 9:00", and their after-counterparts. */
const BEFORE_HOUR = /(?:before|לפני)\s*(\d{1,2})(?::\d{2})?/
const AFTER_HOUR = /(?:after|אחרי)\s*(\d{1,2})(?::\d{2})?/
/** A memory only counts as a rejection when it says so — otherwise we read it as a preference. */
const REJECTION_WORD = /reject|avoid|דוחה|נמנע|לא רוצה/

export function buildPriors(signals: FeedbackSignal[], memory: AIMemory[] = []): Priors {
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
    if (s.type === 'rejected') {
      bumpHour(s.fromHour, PRIOR_WEIGHTS.rejectedHour)
      bumpDay(s.day, PRIOR_WEIGHTS.rejectedHour)
      continue
    }
    // A move is evidence about two hours: the one they left and the one they chose.
    bumpHour(s.fromHour, PRIOR_WEIGHTS.movedFromHour)
    bumpHour(s.toHour, PRIOR_WEIGHTS.movedToHour)
    // FeedbackSignal.day describes the original slot only, so the weekday only
    // ever learns the negative half of a move.
    bumpDay(s.day, PRIOR_WEIGHTS.movedFromHour)
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
