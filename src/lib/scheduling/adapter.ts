/**
 * adapter.ts — the translation layer between the app and the scheduling engine.
 *
 * The engine (plan.ts and friends) is pure and deliberately knows nothing about
 * `UserProfile`, `CalendarEvent`, or the chat route. That purity is
 * what makes it testable, and it is exactly why something has to stand between
 * the two. This file is that something, and it has two jobs:
 *
 *   1. IN  — turn app state into a `SchedulingContext`. Profile fields become
 *            concrete hours, stored events become `BusyBlock`s, feedback and
 *            memory become `Priors`, the user's method becomes `MethodRules`.
 *   2. OUT — turn a `PlanOutcome` into something an LLM can read. Critically,
 *            that means **already-rendered Hebrew sentences** from explain.ts.
 *            The model never sees a `ReasonCode`: it is told to paraphrase what
 *            the engine said, and it cannot paraphrase `PEAK_MATCH`.
 *
 * The one impure edge is time normalisation. `clock.ts` forbids mixing naive
 * LocalISO with UTC strings, but the database has both (older rows were written
 * with `.toISOString()`). `normalizeToLocalISO` is the single, explicit place
 * that boundary is crossed — exactly as clock.ts's header asks for.
 */

import { AIMemory, CalendarEvent, FeedbackSignal, UserProfile } from '@/types'
import { LocalISO, addMinutes, localDateKey, minutesBetween, parseLocal, startOfLocalDay, toLocalISO } from './clock'
import { explainReasons } from './explain'
import { MethodResult, SchedulingMethod, mapToMethod } from './methodMapper'
import { METHOD_RULES, getMethodRules } from './methodRules'
import { buildPriors, emptyPriors } from './priors'
import { toBusyBlocks } from './timeline'
import {
  BusyBlock, PlacementRequest, PlanOutcome, RelaxationCode, SchedulingContext,
  SchedulingProfile, UnplacedCode, Weekday,
} from './types'

/** Breathing room around existing commitments. Matches BUFFER_MIN in the chat route. */
export const DEFAULT_BUFFER_MINUTES = 15
/** How far ahead to plan when the caller doesn't say. Two weeks covers "this week" and "next". */
export const DEFAULT_HORIZON_DAYS = 14
/** The engine walks a 15-minute grid per day; a year-long horizon would be a chat-reply-length wait. */
export const MAX_HORIZON_DAYS = 120
/** Same default the rest of the app assumes when the client hasn't reported one. */
export const DEFAULT_TIMEZONE = 'Asia/Jerusalem'

// ── Time normalisation (the one UTC ⇄ LocalISO boundary) ────────────────────

/** Naive "YYYY-MM-DD[THH:mm[:ss[.sss]]]" — no zone marker of any kind. */
const NAIVE_LOCAL = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/

/**
 * Coerces whatever the database or the model handed us into a LocalISO.
 *
 * A naive string is kept as-is (only padded to second precision). A string that
 * carries a `Z` or an offset is a real instant, so it is resolved to the
 * wall-clock time a person in `timezone` would read off a clock — the honest
 * translation, done once, here. Anything unparseable returns null rather than
 * throwing: one malformed row must not take down a chat turn.
 */
export function normalizeToLocalISO(value: string | null | undefined, timezone?: string): LocalISO | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null

  const naive = NAIVE_LOCAL.exec(trimmed)
  if (naive) {
    const [, y, m, d, hh = '00', mm = '00', ss = '00'] = naive
    return `${y}-${m}-${d}T${hh}:${mm}:${ss}`
  }

  const instant = new Date(trimmed)
  if (isNaN(instant.getTime())) return null
  return instantToLocalISO(instant, timezone)
}

/** The wall-clock time `instant` corresponds to in `timezone`. */
export function instantToLocalISO(instant: Date, timezone?: string): LocalISO {
  if (!timezone) return toLocalISO(instant)
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(instant)
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00'
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`
  } catch {
    return toLocalISO(instant)
  }
}

/** Accepts either the `Date` the chat route already computes or a LocalISO string. */
export function resolveNow(now: Date | LocalISO | undefined, timezone?: string): LocalISO {
  if (typeof now === 'string') return normalizeToLocalISO(now, timezone) ?? toLocalISO(new Date())
  if (now instanceof Date && !isNaN(now.getTime())) return toLocalISO(now)
  return toLocalISO(new Date())
}

// ── Profile → SchedulingProfile ─────────────────────────────────────────────

/** "23:00" → 23. Mirrors parseHour() in the chat route. */
function parseHour(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const m = /^(\d{1,2})/.exec(value.trim())
  if (!m) return fallback
  const h = parseInt(m[1], 10)
  return h >= 0 && h <= 23 ? h : fallback
}

/**
 * The same day bounds and peak window `getFreeSlots` derives, expressed as the
 * numbers the engine wants.
 *
 * The peak is clamped into the available day: a "morning" peak of 06:00–12:00
 * means nothing to someone whose day starts at 09:00, and handing the engine a
 * peak it can never place in would make every PEAK_MATCH reason a lie. If the
 * clamp collapses the window entirely the raw hours are kept — a degenerate
 * peak is worse than a slightly-off one.
 */
export function buildSchedulingProfile(profile: UserProfile | null | undefined, timezone?: string): SchedulingProfile {
  const dayStartHour = profile?.preferred_hours?.start ?? parseHour(profile?.wake_time, 9)
  const dayEndHour = profile?.preferred_hours?.end ?? parseHour(profile?.sleep_time, 22)

  const peak = profile?.productivity_peak ?? 'morning'
  const rawPeakStart = peak === 'morning' ? 6 : peak === 'afternoon' ? 12 : 18
  const rawPeakEnd = peak === 'morning' ? 12 : peak === 'afternoon' ? 18 : 23

  const clampedStart = Math.max(rawPeakStart, dayStartHour)
  const clampedEnd = Math.min(rawPeakEnd, dayEndHour)
  const usable = clampedEnd > clampedStart

  return {
    timezone: timezone || profile?.timezone || DEFAULT_TIMEZONE,
    dayStartHour,
    dayEndHour,
    peakStartHour: usable ? clampedStart : rawPeakStart,
    peakEndHour: usable ? clampedEnd : rawPeakEnd,
    bufferMinutes: DEFAULT_BUFFER_MINUTES,
    weekendDays: weekendDaysFor(profile),
  }
}

/**
 * Which days to keep clear, from the user's own answer.
 *
 * This matters more than it looks: in the acceptance-gate week, holding Friday
 * back costs sixteen study sessions. For a student with an exam coming up that
 * is not a rounding error — it is the difference between the plan fitting and
 * the plan needing an explanation. So it is the user's call, not a constant.
 *
 * Defaults to Friday *and* Saturday because that is the pre-existing behaviour;
 * a `schedule_weekend` of `'friday'` frees Friday and keeps only Shabbat.
 */
function weekendDaysFor(profile: UserProfile | null | undefined): Weekday[] {
  switch (profile?.schedule_weekend) {
    case 'both':    return []      // schedule any day, nothing held back
    case 'friday':  return [6]     // Friday is a study day; Shabbat stays clear
    case 'none':
    default:        return [5, 6]
  }
}

// ── Profile → MethodResult ──────────────────────────────────────────────────

const VALID_METHODS = new Set(Object.keys(METHOD_RULES) as SchedulingMethod[])

function isMethod(value: unknown): value is SchedulingMethod {
  return typeof value === 'string' && VALID_METHODS.has(value as SchedulingMethod)
}

/**
 * The user's own choice wins.
 *
 * `scheduling_method` is what the UI already promised them (and what
 * METHOD_LABELS describes), so re-deriving it from persona/challenge would
 * silently override a setting they can see on screen. Only when it is missing
 * do we fall back to the onboarding mapping.
 */
export function resolveMethod(profile: UserProfile | null | undefined): MethodResult {
  if (isMethod(profile?.scheduling_method)) {
    return {
      primary: profile!.scheduling_method as SchedulingMethod,
      secondary: (profile!.secondary_methods ?? []).filter(isMethod),
    }
  }
  return mapToMethod(
    profile?.persona ?? 'other',
    profile?.challenge ?? '',
    profile?.day_structure ?? '',
  )
}

// ── Events → BusyBlock[] ────────────────────────────────────────────────────

export interface BusyConversion {
  busy: BusyBlock[]
  /** Events that could not be read as times at all. Reported, never silently dropped. */
  skipped: { id: string; title: string; reason: string }[]
}

/**
 * Stored events, normalised and handed to timeline.ts.
 *
 * Every event is normalised first, so a legacy UTC row cannot make `toBusyBlock`
 * throw and take the whole chat turn with it. An event whose times are genuinely
 * unreadable is reported in `skipped` rather than quietly ignored — an invisible
 * commitment is the exact failure the engine exists to prevent.
 */
export function toEngineBusy(events: CalendarEvent[] | null | undefined, timezone?: string): BusyConversion {
  const usable: CalendarEvent[] = []
  const skipped: BusyConversion['skipped'] = []

  for (const ev of events ?? []) {
    const start = normalizeToLocalISO(ev?.start_time, timezone)
    const end = normalizeToLocalISO(ev?.end_time, timezone)
    if (!start || !end) {
      skipped.push({ id: ev?.id ?? '(no id)', title: ev?.title ?? '(no title)', reason: 'unreadable_times' })
      continue
    }
    usable.push({ ...ev, start_time: start, end_time: end < start ? start : end })
  }

  try {
    return { busy: toBusyBlocks(usable), skipped }
  } catch {
    // Defence in depth: toBusyBlocks is strict by design, and a scheduling
    // request must degrade to "I couldn't read your calendar" rather than a 500.
    return { busy: [], skipped: [...skipped, { id: '*', title: '*', reason: 'timeline_rejected_batch' }] }
  }
}

// ── The whole context ───────────────────────────────────────────────────────

/**
 * Assembles everything the engine needs to know about the world.
 *
 * `now` is passed in rather than read, because the engine's determinism is only
 * worth anything if the caller controls the clock too.
 */
export function buildSchedulingContext(
  profile: UserProfile | null | undefined,
  events: CalendarEvent[] | null | undefined,
  memory: AIMemory[] | null | undefined,
  feedback: FeedbackSignal[] | null | undefined,
  timezone?: string,
  now?: Date | LocalISO,
  horizonDays: number = DEFAULT_HORIZON_DAYS,
): SchedulingContext {
  const schedulingProfile = buildSchedulingProfile(profile, timezone)
  const nowLocal = resolveNow(now, schedulingProfile.timezone)
  const days = clampHorizonDays(horizonDays)
  const method = resolveMethod(profile)

  return {
    now: nowLocal,
    horizon: { from: nowLocal, to: horizonEnd(nowLocal, days) },
    profile: schedulingProfile,
    method,
    rules: getMethodRules(method.primary),
    busy: toEngineBusy(events, schedulingProfile.timezone).busy,
    priors: feedback?.length || memory?.length
      ? buildPriors(feedback ?? [], memory ?? [])
      : emptyPriors(),
  }
}

export function clampHorizonDays(days: number): number {
  if (!Number.isFinite(days)) return DEFAULT_HORIZON_DAYS
  return Math.min(MAX_HORIZON_DAYS, Math.max(1, Math.trunc(days)))
}

/** End of the last day in the horizon, so a deadline at 23:00 is still reachable. */
export function horizonEnd(now: LocalISO, days: number): LocalISO {
  const lastDay = localDateKey(addMinutes(startOfLocalDay(now), days * 24 * 60))
  return `${lastDay}T23:59:59`
}

/**
 * How many days of horizon a deadline needs, so a request due in three weeks
 * isn't told "no window" by a fortnight-long horizon.
 */
export function horizonDaysFor(now: LocalISO, deadline: LocalISO | null | undefined, base = DEFAULT_HORIZON_DAYS): number {
  if (!deadline) return clampHorizonDays(base)
  const from = localDateKey(now)
  const to = localDateKey(deadline)
  if (to <= from) return clampHorizonDays(base)
  const dayMs = 24 * 60 * 60 * 1000
  const spanDays = Math.ceil((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / dayMs)
  return clampHorizonDays(Math.max(base, spanDays + 1))
}

// ── PlanOutcome → something an LLM can read ─────────────────────────────────

const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']
const EN_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function weekdayLabel(iso: LocalISO, isHe: boolean): string {
  try {
    const idx = parseLocal(iso).getDay()
    return isHe ? HE_DAYS[idx] : EN_DAYS[idx]
  } catch {
    return ''
  }
}

function hhmm(iso: LocalISO): string {
  return iso.slice(11, 16)
}

function minutesBetweenSafe(a: LocalISO, b: LocalISO): number {
  try {
    return minutesBetween(a, b)
  } catch {
    return 0
  }
}

/**
 * Why a request did not fit, as a sentence.
 *
 * The engine never says "it didn't fit" — every rejection has a named cause —
 * and that guarantee is only useful if the cause survives the trip to the model
 * as language rather than as an enum member.
 */
const UNPLACED_TEXT: Record<UnplacedCode, { he: string; en: string }> = {
  no_window: {
    he: 'לא נמצא אף חלון פנוי בטווח שנבדק',
    en: 'No available window at all in the range checked',
  },
  deadline_too_close: {
    he: 'אין מספיק זמן פנוי לפני המועד האחרון',
    en: 'Not enough free time before the deadline',
  },
  day_cap_reached: {
    he: 'כל הימים המתאימים כבר הגיעו למכסת השעות היומית',
    en: 'Every candidate day already hit the daily hour cap',
  },
  blocked_by_fixed: {
    he: 'אירועים קבועים (בחינה, הרצאה וכד\') חוסמים את כל האפשרויות',
    en: 'Fixed events (exams, lectures) block every option',
  },
  needs_user_approval: {
    he: 'כדי לפנות מקום צריך להזיז אירוע שמסומן "לשאול קודם" — צריך אישור',
    en: 'Making room would mean moving an "ask first" event — needs approval',
  },
  horizon_exhausted: {
    he: 'נגמרו הימים בטווח לפני שכל המפגשים שובצו',
    en: 'Ran out of days in the range before every session was placed',
  },
  no_free_space: {
    he: 'לא נשאר מקום פנוי, וגם הזזה של בלוקים גמישים לא פתרה את זה',
    en: 'No free space left, and moving flexible blocks did not solve it',
  },
  below_quality_floor: {
    he: 'היו חלונות פנויים, אבל כולם גרועים מספיק כדי שעדיף לא לקבוע בהם',
    en: 'Windows existed, but all of them were bad enough to be worse than nothing',
  },
}

/** What the user could give up, as a sentence. `delta` carries the size of the change. */
const RELAXATION_TEXT: Record<RelaxationCode, { he: (d: string) => string; en: (d: string) => string }> = {
  shorten_sessions: {
    he: d => `לקצר את המפגשים (${d} דק')`,
    en: d => `Shorten the sessions (${d} min)`,
  },
  extend_day: {
    he: d => `להאריך את שעות היום (${d})`,
    en: d => `Extend the day's hours (${d})`,
  },
  use_weekend: {
    he: () => 'להשתמש גם בסוף השבוע (שישי–שבת)',
    en: () => 'Use the weekend as well (Fri–Sat)',
  },
  move_ask_first: {
    he: d => `להרשות לי להזיז ${d} אירועים שמסומנים "לשאול קודם"`,
    en: d => `Let me move ${d} event(s) marked "ask first"`,
  },
  drop_buffer: {
    he: d => `לוותר על מרווח הנשימה בין אירועים (${d} דק')`,
    en: d => `Drop the breathing room between events (${d} min)`,
  },
}

export interface PlanBlockView {
  index: number
  title: string
  start: LocalISO
  end: LocalISO
  day: string
  weekday: string
  time: string
  duration_minutes: number
  /** Already-rendered sentences from explain.ts. Paraphrase these; never invent one. */
  why: string[]
}

export interface PlanToolResult {
  status: PlanOutcome['status']
  plan_id?: string
  blocks: PlanBlockView[]
  displacements?: { title: string; from: LocalISO; to: LocalISO; why: string[] }[]
  unplaced?: { title?: string; code: UnplacedCode; reason: string; placed_count?: number }[]
  suggestions?: { code: RelaxationCode; suggestion: string; would_place_at_least: number; title?: string }[]
  summary: string
  /** Instruction to the model, since a plan is a proposal until the user says yes. */
  next_step?: string
}

/**
 * The engine's answer, in a shape a language model can actually talk about.
 *
 * `requests` is optional and only used to name an unplaced item — the placed
 * blocks already carry their own title.
 */
export function planOutcomeToToolResult(
  outcome: PlanOutcome,
  isHe: boolean,
  requests?: PlacementRequest[],
): PlanToolResult {
  const blocks = 'blocks' in outcome ? outcome.blocks : []
  const blockViews: PlanBlockView[] = blocks.map((b, index) => ({
    index,
    title: b.title,
    start: b.start,
    end: b.end,
    day: localDateKey(b.start),
    weekday: weekdayLabel(b.start, isHe),
    time: `${hhmm(b.start)}–${hhmm(b.end)}`,
    duration_minutes: minutesBetweenSafe(b.start, b.end),
    why: explainReasons(b.reasons, isHe, 2),
  }))

  const result: PlanToolResult = {
    status: outcome.status,
    blocks: blockViews,
    summary: summarize(outcome, blockViews.length, isHe),
  }

  if ('displacements' in outcome && outcome.displacements.length > 0) {
    result.displacements = outcome.displacements.map(d => ({
      title: d.title,
      from: d.from,
      to: d.to,
      why: explainReasons(d.reasons, isHe, 1),
    }))
  }

  if ('unplaced' in outcome && outcome.unplaced.length > 0) {
    result.unplaced = outcome.unplaced.map(u => ({
      title: requests?.[u.requestIndex]?.title,
      code: u.code,
      reason: (UNPLACED_TEXT[u.code] ?? UNPLACED_TEXT.no_window)[isHe ? 'he' : 'en'],
      placed_count: u.placedCount,
    }))
  }

  if ('relaxations' in outcome && outcome.relaxations.length > 0) {
    result.suggestions = outcome.relaxations.map(r => ({
      code: r.code,
      suggestion: (RELAXATION_TEXT[r.code] ?? RELAXATION_TEXT.shorten_sessions)[isHe ? 'he' : 'en'](r.delta),
      would_place_at_least: r.wouldPlace,
      title: r.requestIndex !== undefined ? requests?.[r.requestIndex]?.title : undefined,
    }))
  }

  return result
}

function summarize(outcome: PlanOutcome, placedCount: number, isHe: boolean): string {
  const unplacedCount = 'unplaced' in outcome ? outcome.unplaced.length : 0
  if (outcome.status === 'ok') {
    return isHe
      ? `נמצא מקום לכל ${placedCount} המפגשים. זו הצעה בלבד — שום דבר עדיין לא נשמר ביומן.`
      : `Found room for all ${placedCount} session(s). This is a proposal — nothing is saved to the calendar yet.`
  }
  if (outcome.status === 'partial') {
    return isHe
      ? `שובצו ${placedCount} מפגשים, ו-${unplacedCount} בקשות לא נכנסו. זו הצעה בלבד — עדיין לא נשמר כלום.`
      : `Placed ${placedCount} session(s); ${unplacedCount} request(s) did not fit. Proposal only — nothing saved yet.`
  }
  return isHe
    ? 'לא הצלחתי לשבץ כלום בטווח הזה. אל תמציא זמנים — הסבר למה זה לא נכנס והצע מה אפשר לשנות.'
    : 'Nothing could be placed in this range. Do not invent times — explain why and offer what could change.'
}
