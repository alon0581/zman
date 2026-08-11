/**
 * student-week.ts — a realistic week of busy blocks for Zman's actual user:
 * an engineering student in Israel (Asia/Jerusalem).
 *
 * DATA ONLY. This file does not test the engine (windows.ts / timeline.ts /
 * score.ts / place.ts / plan.ts / repair.ts are still being written by another
 * agent as of this file's creation) — it just gives that engine, once it
 * exists, deterministic ground truth to run scenario tests against.
 *
 * This is a stand-in, shaped from what a typical CS/engineering student's week
 * looks like (lectures, one lab, gym, an exam, a reserve-duty trip). It is
 * expected to be replaced with Alon's actual real schedule at review time —
 * treat the specific titles/times as illustrative, not authoritative.
 *
 * All dates are fixed and absolute (no `new Date()`, no randomness) so any
 * test built on top of this fixture is reproducible byte-for-byte.
 *
 * The week: Sun 2026-08-16 -> Sat 2026-08-22 (Israeli week: Sunday first).
 * `STUDENT_WEEK_NOW` sits before the week's first lecture. The exam and the
 * multi-day reserve-duty block deliberately fall outside those 7 days, to
 * exercise a horizon that extends past "this week" the way a real planning
 * request would.
 */

import { LocalISO } from '../clock'
import { MethodResult } from '../methodMapper'
import { getMethodRules } from '../methodRules'
import { BusyBlock, Priors, SchedulingContext, SchedulingProfile } from '../types'

// ── "Now" the tests should inject ───────────────────────────────────────────
// Sunday, 07:30 — before the first lecture of the week (09:00).
export const STUDENT_WEEK_NOW: LocalISO = '2026-08-16T07:30:00'

// ── Busy blocks ──────────────────────────────────────────────────────────────
//
// Two recurring lecture series (mornings and afternoons), one lab, one exam
// ~11 days out, three gym sessions, one one-off user commitment, and one
// multi-day all-day block — the exact case today's code drops on the floor,
// because `is_all_day` is written on creation and never read again (see the
// BusyBlock.isAllDay doc in types.ts). Shabbat (Fri evening -> Sat evening)
// is left free of any work block, matching how a religious-adjacent Israeli
// week actually looks even for a non-observant student — nobody schedules
// study blocks there.
export const STUDENT_WEEK_BUSY: BusyBlock[] = [
  // ── "מבני נתונים" (Data Structures) lecture — mornings, Sun/Tue/Thu ────────
  {
    id: 'busy-ds-lec-sun',
    title: 'הרצאה במבני נתונים',
    start: '2026-08-16T09:00:00',
    end: '2026-08-16T11:00:00',
    mobility: 'fixed', // classifyMobility() matches the "הרצאה" keyword
    createdBy: 'user',
    isAllDay: false,
    seriesId: 'series-ds-lecture',
    category: 'study',
  },
  {
    id: 'busy-ds-lec-tue',
    title: 'הרצאה במבני נתונים',
    start: '2026-08-18T09:00:00',
    end: '2026-08-18T11:00:00',
    mobility: 'fixed',
    createdBy: 'user',
    isAllDay: false,
    seriesId: 'series-ds-lecture',
    category: 'study',
  },
  {
    id: 'busy-ds-lec-thu',
    title: 'הרצאה במבני נתונים',
    start: '2026-08-20T09:00:00',
    end: '2026-08-20T11:00:00',
    mobility: 'fixed',
    createdBy: 'user',
    isAllDay: false,
    seriesId: 'series-ds-lecture',
    category: 'study',
  },

  // ── "אותות ומערכות" (Signals & Systems) lecture — afternoons, Mon/Wed ──────
  {
    id: 'busy-signals-lec-mon',
    title: 'הרצאה באותות ומערכות',
    start: '2026-08-17T14:00:00',
    end: '2026-08-17T16:00:00',
    mobility: 'fixed',
    createdBy: 'user',
    isAllDay: false,
    seriesId: 'series-signals-lecture',
    category: 'study',
  },
  {
    id: 'busy-signals-lec-wed',
    title: 'הרצאה באותות ומערכות',
    start: '2026-08-19T14:00:00',
    end: '2026-08-19T16:00:00',
    mobility: 'fixed',
    createdBy: 'user',
    isAllDay: false,
    seriesId: 'series-signals-lecture',
    category: 'study',
  },

  // ── Lab, Tuesday — classifyMobility() matches "מעבדה" as fixed ─────────────
  {
    id: 'busy-ds-lab-tue',
    title: 'מעבדה במבני נתונים',
    start: '2026-08-18T12:00:00',
    end: '2026-08-18T14:00:00',
    mobility: 'fixed',
    createdBy: 'user',
    isAllDay: false,
    seriesId: 'series-ds-lab',
    category: 'study',
  },

  // ── Exam, ~11 days out — classifyMobility() matches "בחינה" as fixed ───────
  {
    id: 'busy-linalg-exam',
    title: 'בחינה באלגברה ליניארית',
    start: '2026-08-27T09:00:00',
    end: '2026-08-27T12:00:00',
    mobility: 'fixed',
    createdBy: 'user',
    isAllDay: false,
    category: 'study',
  },

  // ── Gym, 3x/week (Sun/Tue/Thu evenings) — flexible ──────────────────────────
  // "אימון כושר" hits no FIXED_/FLEXIBLE_KEYWORDS entry in mobilityClassifier.ts,
  // so a plain user-created event would default to ask_first. Here it is set to
  // 'flexible' deliberately, the same way EventPopup lets a user manually
  // override mobility and tags it "(ידני)" — this student is happy to have Zman
  // move gym around, unlike the group-work commitment below.
  {
    id: 'busy-gym-sun',
    title: 'אימון כושר',
    start: '2026-08-16T18:00:00',
    end: '2026-08-16T19:00:00',
    mobility: 'flexible',
    createdBy: 'user',
    isAllDay: false,
    category: 'fitness',
  },
  {
    id: 'busy-gym-tue',
    title: 'אימון כושר',
    start: '2026-08-18T18:00:00',
    end: '2026-08-18T19:00:00',
    mobility: 'flexible',
    createdBy: 'user',
    isAllDay: false,
    category: 'fitness',
  },
  {
    id: 'busy-gym-thu',
    title: 'אימון כושר',
    start: '2026-08-20T18:00:00',
    end: '2026-08-20T19:00:00',
    mobility: 'flexible',
    createdBy: 'user',
    isAllDay: false,
    category: 'fitness',
  },

  // ── One-off user commitment — defaults to ask_first (no keyword match) ─────
  {
    id: 'busy-project-group-mon',
    title: 'פגישת קבוצת עבודה בפרויקט הגמר',
    start: '2026-08-17T17:00:00',
    end: '2026-08-17T18:00:00',
    mobility: 'ask_first',
    createdBy: 'user',
    isAllDay: false,
    category: 'work',
  },

  // ── Multi-day all-day block — the case the old code ignored entirely ───────
  // Three-day reserve duty (מילואים), immediately after the modeled week.
  // isAllDay:true is load-bearing here: this block must occupy all three whole
  // days, not just its nominal start/end timestamps (see BusyBlock.isAllDay).
  {
    id: 'busy-miluim',
    title: 'מילואים',
    start: '2026-08-23T00:00:00',
    end: '2026-08-25T23:59:59',
    mobility: 'fixed',
    createdBy: 'user',
    isAllDay: true,
    category: 'admin',
  },
]

// ── Context helpers ──────────────────────────────────────────────────────────

/** A typical student profile: peak focus late morning, day runs 08:00-23:00. */
export const STUDENT_WEEK_PROFILE: SchedulingProfile = {
  timezone: 'Asia/Jerusalem',
  dayStartHour: 8,
  dayEndHour: 23,
  peakStartHour: 9,
  peakEndHour: 13,
  bufferMinutes: 15,
}

/** Matches mapToMethod('student', 'procrastination', 'fixed') in methodMapper.ts. */
export const STUDENT_WEEK_METHOD: MethodResult = {
  primary: 'pomodoro',
  secondary: ['eat_the_frog', 'time_blocking', 'ivy_lee'],
}

/**
 * Mild, plausible learned preferences: this student has previously moved
 * things away from early mornings and tends to actually keep 20:00 slots.
 * Not derived from real feedback data — just enough shape for a test to
 * assert priors get read at all.
 */
export const STUDENT_WEEK_PRIORS: Priors = {
  hourWeight: { 8: -2, 20: 1.5 },
  dayWeight: { Fri: -3, Sat: -5 }, // Shabbat-adjacent — strongly avoided
}

/** Horizon covering the modeled week plus the exam and the reserve-duty trip. */
export const STUDENT_WEEK_HORIZON = {
  from: STUDENT_WEEK_NOW,
  to: '2026-08-29T23:59:59' as LocalISO,
}

/**
 * Assembles a full SchedulingContext around the fixture data above.
 * Pass `overrides` to swap out any single field (e.g. a different method)
 * without having to reconstruct the whole context by hand.
 */
export function buildStudentWeekContext(overrides: Partial<SchedulingContext> = {}): SchedulingContext {
  return {
    now: STUDENT_WEEK_NOW,
    horizon: STUDENT_WEEK_HORIZON,
    profile: STUDENT_WEEK_PROFILE,
    method: STUDENT_WEEK_METHOD,
    rules: getMethodRules(STUDENT_WEEK_METHOD.primary),
    busy: STUDENT_WEEK_BUSY,
    priors: STUDENT_WEEK_PRIORS,
    ...overrides,
  }
}
