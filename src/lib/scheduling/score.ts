/**
 * score.ts — why one surviving slot beats another.
 *
 * Every term emits exactly one ScoredReason carrying its own signed
 * contribution, and the total is nothing but their sum. That is the property
 * that makes the plan explainable: the AI never has to invent a justification,
 * because the justification is the arithmetic that produced the answer. If a
 * reason is missing from the list, it did not influence the choice.
 *
 * Scoring runs only on candidates that already survived the hard filter, so
 * nothing here is allowed to reject anything — a term may push a candidate to
 * last place, never out of the running.
 */

import { LocalISO, localDateKey, minutesBetween } from './clock'
import { overlapMinutes, Span } from './timeline'
import { BusyBlock, PlacementRequest, ReasonCode, ScoredReason, SchedulingContext } from './types'
import { dayHourISO, weekdayOf } from './windows'

/**
 * The tuning surface. One place, so a complaint like "it keeps burying my
 * afternoons" is a one-line change rather than an archaeology exercise.
 *
 * Read them as "how many points is this worth at full strength". Most terms
 * scale continuously between 0 and their weight; SPREAD and THEME_DAY can go
 * negative, because "you already have a session that day" and "this is not that
 * day's theme" are real objections, not merely the absence of a bonus.
 */
export const WEIGHTS: Record<ReasonCode, number> = {
  /** The single strongest signal we have about *when* someone works well. */
  PEAK_MATCH: 30,
  /** Spreading beats clustering: two sessions in one day is barely two sessions. */
  SPREAD: 25,
  /** eat_the_frog only applies to one request, so it can afford to be loud. */
  FROG_FIRST: 22,
  /** Finishing early is worth real points; the crunch penalty is what bites. */
  DEADLINE_MARGIN: 20,
  /** A theme day is a promise the user made to themselves. */
  THEME_DAY: 18,
  /** Right block size for their method — always true-ish, so it must not dominate. */
  METHOD_FIT: 15,
  /** Demanding work in a high-energy window, on top of the generic peak match. */
  ENERGY_MATCH: 14,
  /** Learned from their own corrections; clamped upstream so it cannot run away. */
  PRIOR_HOUR: 12,
  /** Comfort, not correctness — the hard filter already guaranteed the minimum. */
  BUFFER_RESPECTED: 8,
  /** A gentle gradient toward "sooner", mostly so ties resolve sensibly. */
  EARLIEST_AVAILABLE: 6,
}

/** 'Sun'…'Sat', matching the convention FeedbackSignal.day already uses. */
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/** Beyond three days apart, extra separation stops buying anything. */
const SPREAD_SATURATION_DAYS = 3
/** The last fifth of the runway before a deadline is where plans go to die. */
const DEADLINE_CRUNCH_FRACTION = 0.2
/** Matches PRIOR_WEIGHTS.clamp — the magnitude a fully-reinforced prior reaches. */
const PRIOR_SCALE = 3

export interface ScoreInput {
  ctx: SchedulingContext
  request: PlacementRequest
  start: LocalISO
  end: LocalISO
  /** Day keys the other sessions of this same request already landed on. */
  siblingDays: string[]
  /** Commitments sharing the candidate's day, for the buffer term. */
  neighbours: BusyBlock[]
  /** True when eat_the_frog singled this request out as the hardest. */
  isFrog: boolean
  /** Effective buffer — may be 0 while probing the `drop_buffer` relaxation. */
  bufferMinutes: number
}

export interface ScoreResult {
  total: number
  /** Best-first, so explain.ts can render the top few and stop. */
  reasons: ScoredReason[]
}

export function scoreCandidate(input: ScoreInput): ScoreResult {
  const reasons: ScoredReason[] = []
  const push = (code: ReasonCode, weight: number, detail?: Record<string, string | number>) => {
    const w = round2(weight)
    if (w === 0) return
    reasons.push(detail ? { code, weight: w, detail } : { code, weight: w })
  }

  const { ctx, request, start, end } = input
  const span: Span = { start, end }
  const duration = minutesBetween(start, end)
  const day = localDateKey(start)
  const weekday = weekdayOf(day)
  const peakFraction = fractionInPeak(span, duration, ctx)

  // PEAK_MATCH — by how much of the block sits inside the peak, not by its start
  // hour. The old code called a 6-hour window "peak" because it began at 09:00;
  // an hour of overlap out of six is not a peak slot and must not score like one.
  if (peakFraction > 0) {
    push('PEAK_MATCH', WEIGHTS.PEAK_MATCH * peakFraction, {
      fraction: round2(peakFraction),
      peakStart: ctx.profile.peakStartHour,
      peakEnd: ctx.profile.peakEndHour,
    })
  }

  // METHOD_FIT — distance from the session length the method promised the user.
  const target = request.sessionMinutes ?? ctx.rules.sessionMinutes
  if (target > 0) {
    const fit = clamp01(1 - Math.abs(duration - target) / target)
    push('METHOD_FIT', WEIGHTS.METHOD_FIT * fit, { minutes: duration, target })
  }

  // SPREAD — the day-striding idea from pickSpreadSlots, as a score instead of a
  // hand-rolled pass: stacking onto a day this request already uses is penalised
  // per session already there, and separation is rewarded up to saturation.
  if (input.siblingDays.length > 0) {
    const sameDay = input.siblingDays.filter(d => d === day).length
    if (sameDay > 0) {
      push('SPREAD', -WEIGHTS.SPREAD * sameDay, { sameDaySessions: sameDay })
    } else {
      const nearest = Math.min(...input.siblingDays.map(d => Math.abs(daysBetween(d, day))))
      const reward = Math.min(nearest, SPREAD_SATURATION_DAYS) / SPREAD_SATURATION_DAYS
      push('SPREAD', WEIGHTS.SPREAD * reward, { daysFromNearest: nearest })
    }
  }

  // DEADLINE_MARGIN — prefer finishing early, and actively punish the last fifth
  // of the runway, where a single slipped day means missing the deadline outright.
  if (request.deadline) {
    const runway = minutesBetween(ctx.now, request.deadline)
    if (runway > 0) {
      const margin = minutesBetween(end, request.deadline)
      const ratio = clamp01(margin / runway)
      const crunch = ratio < DEADLINE_CRUNCH_FRACTION
        ? -WEIGHTS.DEADLINE_MARGIN * (1 - ratio / DEADLINE_CRUNCH_FRACTION)
        : 0
      push('DEADLINE_MARGIN', WEIGHTS.DEADLINE_MARGIN * ratio + crunch, {
        marginMinutes: margin,
        ratio: round2(ratio),
      })
    }
  }

  // PRIOR_HOUR — their own corrections. Normalised by the clamp priors.ts applies,
  // so a fully-reinforced hour is worth exactly WEIGHTS.PRIOR_HOUR and no more.
  const hour = Number(start.slice(11, 13))
  const hourPrior = ctx.priors.hourWeight[hour] ?? 0
  const dayPrior = ctx.priors.dayWeight[WEEKDAY_LABELS[weekday]] ?? 0
  if (hourPrior !== 0 || dayPrior !== 0) {
    push('PRIOR_HOUR', WEIGHTS.PRIOR_HOUR * clampSigned((hourPrior + dayPrior) / PRIOR_SCALE), {
      hour,
      hourWeight: round2(hourPrior),
      dayWeight: round2(dayPrior),
    })
  }

  // THEME_DAY — a match is a bonus and a mismatch is a penalty, because the point
  // of theme days is that Wednesday is *not* for admin.
  const theme = ctx.rules.themeDays?.[weekday]
  if (theme && request.category) {
    push('THEME_DAY', theme === request.category ? WEIGHTS.THEME_DAY : -WEIGHTS.THEME_DAY / 2, {
      theme,
      category: request.category,
    })
  }

  // ENERGY_MATCH — what this particular item demands, on top of the generic peak
  // preference: high-energy work wants the peak, low-energy work should stay out
  // of it so the peak is left for something that needs it.
  if (request.energy === 'high') {
    push('ENERGY_MATCH', WEIGHTS.ENERGY_MATCH * peakFraction, { energy: 'high', fraction: round2(peakFraction) })
  } else if (request.energy === 'low') {
    push('ENERGY_MATCH', WEIGHTS.ENERGY_MATCH * (1 - peakFraction), { energy: 'low', fraction: round2(peakFraction) })
  }

  const earliness = earlinessFraction(ctx, start)

  // FROG_FIRST — eat_the_frog's whole claim is that the hardest thing goes first,
  // so for the frog, earliness is worth far more than it is for anything else.
  if (input.isFrog) {
    push('FROG_FIRST', WEIGHTS.FROG_FIRST * earliness, { earliness: round2(earliness) })
  }

  // BUFFER_RESPECTED — the hard filter already guaranteed the minimum gap; this
  // rewards slots that leave more than the minimum. A day with no neighbours at
  // all respects every buffer trivially and scores full marks: awarding it
  // nothing made a crowded day outrank an empty one, which is exactly backwards,
  // and it quietly dragged whole plans onto the days that were already busiest.
  const gap = nearestNeighbourGap(span, input.neighbours)
  const comfortable = 2 * Math.max(input.bufferMinutes, 15)
  const respect = gap === null ? 1 : clamp01(gap / comfortable)
  push('BUFFER_RESPECTED', WEIGHTS.BUFFER_RESPECTED * respect, gap === null ? undefined : { gapMinutes: gap })

  // EARLIEST_AVAILABLE — sooner is better, all else equal.
  push('EARLIEST_AVAILABLE', WEIGHTS.EARLIEST_AVAILABLE * earliness, { earliness: round2(earliness) })

  reasons.sort((a, b) => (b.weight - a.weight) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
  return { total: round2(reasons.reduce((sum, r) => sum + r.weight, 0)), reasons }
}

/** How much of the block falls inside the user's peak window, as 0..1. */
function fractionInPeak(span: Span, duration: number, ctx: SchedulingContext): number {
  if (duration <= 0) return 0
  const day = localDateKey(span.start)
  const peak: Span = {
    start: dayHourISO(day, ctx.profile.peakStartHour),
    end: dayHourISO(day, ctx.profile.peakEndHour),
  }
  if (peak.end <= peak.start) return 0
  return clamp01(overlapMinutes(span, peak) / duration)
}

/** 1.0 at `now`, falling to 0 at the far edge of the horizon. */
function earlinessFraction(ctx: SchedulingContext, start: LocalISO): number {
  const span = minutesBetween(ctx.now, ctx.horizon.to)
  if (span <= 0) return 0
  return clamp01(1 - minutesBetween(ctx.now, start) / span)
}

/** Minutes to the closest commitment on either side, or null when there is none. */
function nearestNeighbourGap(span: Span, neighbours: BusyBlock[]): number | null {
  let best: number | null = null
  for (const n of neighbours) {
    const gap = n.start >= span.end ? minutesBetween(span.end, n.start)
      : n.end <= span.start ? minutesBetween(n.end, span.start)
      : 0
    if (best === null || gap < best) best = gap
  }
  return best
}

/** Whole days from day key `a` to day key `b`. */
function daysBetween(a: string, b: string): number {
  return Math.round(minutesBetween(`${a}T00:00:00`, `${b}T00:00:00`) / (24 * 60))
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

function clampSigned(n: number): number {
  return Math.max(-1, Math.min(1, n))
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
