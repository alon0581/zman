/**
 * types.ts — the contract for the scheduling engine.
 *
 * The engine exists because the LLM was doing this arithmetic itself, and it got
 * it wrong in ways nobody could see: all-day events that blocked nothing,
 * recurring series that skipped conflict checks, "free" slots that were already
 * booked. Everything below is designed so those failures become impossible by
 * construction rather than unlikely.
 *
 * Three properties the whole design leans on:
 *
 *   1. PURE. No fs, no fetch, no `new Date()` — `now` is always passed in. The
 *      same context in must give the same plan out, every time, so a fixture
 *      test can assert exact start/end times.
 *   2. EVERY REJECTION IS ATTRIBUTABLE. A candidate slot is never dropped
 *      silently: it either becomes a PlacedBlock or produces an Unplaced with a
 *      code saying why. "Nothing fits" is a bug; "nothing fits because the day
 *      cap was reached" is an answer.
 *   3. EVERY CHOICE IS EXPLAINABLE. A PlacedBlock carries the ScoredReasons that
 *      won it. The AI's job is to paraphrase those in Hebrew — it is forbidden
 *      to invent a reason, because the reason is data, not narration.
 *
 * All times are LocalISO (naive wall-clock, never UTC). See clock.ts.
 */

import { LocalISO } from './clock'
import { MethodResult } from './methodMapper'

// ── Vocabulary ──────────────────────────────────────────────────────────────

/** Matches CalendarEvent['mobility_type'] — how movable a block is. */
export type Mobility = 'fixed' | 'flexible' | 'ask_first'

/** 0 = Sunday … 6 = Saturday. Sunday-first, because the Israeli week is. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** Coarse kind of work — drives theme days and energy matching. */
export type Category = 'study' | 'work' | 'fitness' | 'personal' | 'social' | 'admin'

/** How much focus something needs. Matched against the user's peak window. */
export type Energy = 'high' | 'medium' | 'low'

// ── Inputs ──────────────────────────────────────────────────────────────────

/**
 * A span of time that is already taken. Built from CalendarEvent by timeline.ts.
 *
 * `isAllDay` is load-bearing: today `is_all_day` is written on creation and then
 * never read, so a three-day trip blocks nothing and the AI happily schedules
 * study sessions inside it. An all-day block must occupy its whole day.
 */
export interface BusyBlock {
  id: string
  title: string
  start: LocalISO
  end: LocalISO
  mobility: Mobility
  createdBy: 'user' | 'ai'
  isAllDay: boolean
  seriesId?: string
  category?: Category
}

/** A stretch of a single day the user is willing to be scheduled in. */
export interface DayWindow {
  /** "YYYY-MM-DD" — the day this window belongs to. */
  day: string
  start: LocalISO
  end: LocalISO
}

/**
 * Scheduling parameters for one time-management method.
 *
 * These MUST agree with the METHOD_LABELS descriptions in methodMapper.ts, which
 * are shown to the user ("25-min sessions with 5-min breaks"). If the UI promises
 * 25 and the engine schedules 50, the product is lying to the user.
 */
export interface MethodRules {
  /** Default length of one working session. */
  sessionMinutes: number
  /** Never place a block shorter than this. */
  minBlock: number
  /** Never place a block longer than this. */
  maxBlock: number
  /** Insert a break after this much continuous work (pomodoro 25, rule_5217 52). */
  breakAfterMinutes?: number
  /** Length of that break (pomodoro 5, rule_5217 17). */
  breakMinutes?: number
  maxSessionsPerDay: number
  /** deep_work wants one long block, pomodoro is happy with several short ones. */
  preferContiguous: boolean
  /** eat_the_frog: put the hardest item in the earliest viable slot. */
  hardestFirst: boolean
  /** theme_days: this weekday belongs to this category. */
  themeDays?: Partial<Record<Weekday, Category>>
  /** Total scheduled minutes allowed per day, across everything. */
  dailyCapMinutes: number
}

/**
 * What we have learned from the user's own corrections.
 *
 * Fed by FeedbackSignal: `rejected` (they deleted an AI event) and `moved` (they
 * dragged one to a better time). A move is the stronger signal — it says not just
 * "not here" but "there instead".
 */
export interface Priors {
  /** hour 0-23 → weight. Negative means the user keeps moving work away from it. */
  hourWeight: Partial<Record<number, number>>
  /** 'Sun'…'Sat' → weight, same sign convention. */
  dayWeight: Partial<Record<string, number>>
}

/** The scheduling-relevant slice of UserProfile, already resolved to numbers. */
export interface SchedulingProfile {
  /** IANA zone, e.g. "Asia/Jerusalem". */
  timezone: string
  /** Earliest hour the user wants anything scheduled (from preferred_hours/wake_time). */
  dayStartHour: number
  /** Latest hour (from preferred_hours/sleep_time). */
  dayEndHour: number
  /** The user's focus peak, derived from productivity_peak. */
  peakStartHour: number
  peakEndHour: number
  /** Breathing room to leave on each side of an existing commitment. */
  bufferMinutes: number
}

/** Everything the engine needs to know about the world. Assembled by the caller. */
export interface SchedulingContext {
  now: LocalISO
  horizon: { from: LocalISO; to: LocalISO }
  profile: SchedulingProfile
  method: MethodResult
  rules: MethodRules
  busy: BusyBlock[]
  priors: Priors
}

/** How a recurring request repeats. */
export interface Recurrence {
  frequency: 'weekly' | 'biweekly' | 'monthly'
  /** Number of instances, when the caller knows it. */
  count?: number
  /** Last day an instance may land on, when the caller knows that instead. */
  endDate?: LocalISO
}

/**
 * One thing that needs a place in the schedule.
 *
 * `ref.kind` and `dependsOn` are deliberately wider than today's needs: the next
 * feature is project management, and a project is exactly "a batch of placement
 * requests with dependencies between them". Getting the shape right now is what
 * keeps that from being a rewrite.
 */
export interface PlacementRequest {
  ref: { kind: 'event' | 'task' | 'project'; id?: string }
  title: string
  category?: Category
  energy?: Energy
  /** Total work to place. Split into sessions by the engine when sessionCount > 1. */
  totalMinutes?: number
  /** Override the method's default session length. */
  sessionMinutes?: number
  /** How many separate sessions to spread out. Defaults to 1. */
  sessionCount?: number
  /** Must finish by this time. */
  deadline?: LocalISO
  /** Must not start before this time. */
  earliest?: LocalISO
  mobility?: Mobility
  recurrence?: Recurrence
  /** Hard user constraint, e.g. "only in the evening". Overrides the day window. */
  hardWindows?: DayWindow[]
  /** Reserved for projects: ids of requests that must be placed before this one. */
  dependsOn?: string[]
}

// ── Outputs ─────────────────────────────────────────────────────────────────

/** Why a slot scored the way it did. Rendered to Hebrew by explain.ts. */
export type ReasonCode =
  | 'PEAK_MATCH'          // lands in the user's focus peak
  | 'METHOD_FIT'          // block size matches their method
  | 'SPREAD'              // separated from the other sessions of this item
  | 'DEADLINE_MARGIN'     // comfortably before the deadline
  | 'PRIOR_HOUR'          // an hour the user has historically kept
  | 'THEME_DAY'           // matches this weekday's theme
  | 'ENERGY_MATCH'        // demanding work in a high-energy window
  | 'FROG_FIRST'          // hardest item, earliest viable slot
  | 'BUFFER_RESPECTED'    // leaves breathing room around neighbours
  | 'EARLIEST_AVAILABLE'  // simply the first slot that fit

export interface ScoredReason {
  code: ReasonCode
  /** Contribution to the total score. Signed: a penalty is negative. */
  weight: number
  /** Values for the Hebrew sentence, e.g. { hour: 9, daysLeft: 3 }. */
  detail?: Record<string, string | number>
}

export interface PlacedBlock {
  /** Index into the PlacementRequest[] this block belongs to. */
  requestIndex: number
  title: string
  start: LocalISO
  end: LocalISO
  score: number
  /** Ordered best-first. explain.ts renders the top few. */
  reasons: ScoredReason[]
}

/** Why a request could not be placed. Never "it just didn't fit". */
export type UnplacedCode =
  | 'no_window'           // no day window in the horizon could hold it
  | 'deadline_too_close'  // not enough free time before the deadline
  | 'day_cap_reached'     // every candidate day is already at dailyCapMinutes
  | 'blocked_by_fixed'    // only fixed events stood in the way
  | 'needs_user_approval' // would require moving an ask_first event
  | 'horizon_exhausted'   // ran out of days before placing every session
  | 'no_free_space'       // only flexible work was in the way and repair could not move it
  | 'below_quality_floor' // slots existed, but all of them were bad enough to be worse than nothing

export interface Unplaced {
  requestIndex: number
  code: UnplacedCode
  /** How many of the requested sessions did land, when it was partial. */
  placedCount?: number
  detail?: Record<string, string | number>
}

/** A constraint the user could relax to unblock the plan, with its payoff. */
export type RelaxationCode =
  | 'shorten_sessions'
  | 'extend_day'
  | 'use_weekend'
  | 'move_ask_first'
  | 'drop_buffer'

export interface Relaxation {
  code: RelaxationCode
  /** Human-facing size of the change, e.g. "45 → 30" or "+1h". */
  delta: string
  /**
   * How many currently-unplaced sessions this would place. A floor, not an
   * estimate: the engine re-runs the real filter to get it, but may stop probing
   * early on a large backlog, in which case the true number is higher. Never
   * lower — so "this would place at least N more" is always a safe reading.
   */
  wouldPlace: number
  /** Which request the payoff belongs to, so the advice can name it. */
  requestIndex?: number
}

/** A flexible event the engine moved to make room. Always reported, never silent. */
export interface Displacement {
  eventId: string
  title: string
  from: LocalISO
  to: LocalISO
  reasons: ScoredReason[]
}

/**
 * The result of planning.
 *
 * Three states, not two: partial success is the common real-world case ("I fit 4
 * of your 6 sessions"), and collapsing it into either "ok" or "failed" is how you
 * end up with an assistant that says "done!" after doing half the job.
 */
export type PlanOutcome =
  | { status: 'ok'; blocks: PlacedBlock[]; displacements: Displacement[] }
  | { status: 'partial'; blocks: PlacedBlock[]; displacements: Displacement[]; unplaced: Unplaced[]; relaxations: Relaxation[] }
  | { status: 'blocked'; unplaced: Unplaced[]; relaxations: Relaxation[] }
