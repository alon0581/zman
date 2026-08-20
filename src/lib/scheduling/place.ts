/**
 * place.ts — putting ONE block somewhere, or saying exactly why not.
 *
 * The shape of the search is: generate candidates on a 15-minute grid inside the
 * windows, discard each one against a fixed ladder of hard rules, score whatever
 * survives, take the best. Roughly 450 candidates over a week-long horizon, so
 * exhaustive enumeration is cheap — and it buys the property that matters more
 * than speed here, which is that a rejection is always attributable to a named
 * rule rather than to a search that gave up.
 *
 * Nothing in this file is allowed to return "didn't fit". Every path out is
 * either a PlacedBlock or an UnplacedCode.
 */

import { LocalISO, addMinutes, localDateKey, minutesBetween } from './clock'
import { buildDayScoreContext, MIN_ACCEPTABLE_SCORE, scoreCandidate } from './score'
import { busyMinutesIn, inflate, inflateSides, overlaps, Span, travelPad } from './timeline'
import {
  BusyBlock, DayWindow, MethodRules, PlacedBlock, PlacementRequest, SchedulingContext, UnplacedCode,
} from './types'
import { clipWindows, minutesOf } from './windows'

/** Candidate starts land on quarter hours. Finer resolution buys nothing a human notices. */
export const GRANULARITY_MINUTES = 15

/**
 * Marks a BusyBlock the engine invented during this plan, as opposed to an event
 * that exists in the user's calendar.
 *
 * Repair must be able to tell them apart. Displacing one of our own not-yet-real
 * blocks is not a displacement at all — and worse, it left the PlacedBlock in the
 * returned `blocks` array sitting at the time the engine had just vacated, so the
 * plan contradicted itself. Ours are re-planned by the greedy pass or not at all.
 */
export const ENGINE_BLOCK_PREFIX = 'zman-plan:'

export function isEngineBlock(id: string): boolean {
  return id.startsWith(ENGINE_BLOCK_PREFIX)
}

/**
 * Everything the greedy loop accumulates as it goes.
 *
 * `busy` is the live world, not the original calendar: blocks this plan places
 * are appended to it, and blocks repair moves are rewritten in place. Keeping
 * one list means a later session physically cannot be scheduled on top of an
 * earlier one — the bug that let a recurring series double-book itself.
 */
export interface PlacementState {
  busy: BusyBlock[]
  /** Day key → sessions this plan has put there, for rules.maxSessionsPerDay. */
  sessionsByDay: Record<string, number>
  /** Request index → the day keys its sessions landed on, for SPREAD. */
  daysByRequest: Record<number, string[]>
}

export function emptyState(ctx: SchedulingContext): PlacementState {
  return { busy: [...ctx.busy], sessionsByDay: {}, daysByRequest: {} }
}

export function cloneState(state: PlacementState): PlacementState {
  return {
    busy: [...state.busy],
    sessionsByDay: { ...state.sessionsByDay },
    daysByRequest: Object.fromEntries(
      Object.entries(state.daysByRequest).map(([k, v]) => [k, [...v]])
    ),
  }
}

export interface PlaceOptions {
  /** Overrides profile.bufferMinutes — the `drop_buffer` relaxation. */
  bufferMinutes?: number
  /** Treat ask_first commitments as absent — the `move_ask_first` relaxation. */
  ignoreAskFirst?: boolean
  /** eat_the_frog marked this request as the hardest one. */
  isFrog?: boolean
  /** Confine the search to one day — recurrence instances are anchored to theirs. */
  restrictToDay?: string
  /** Consider only this exact start. A recurring series prefers to keep its time. */
  pinnedStart?: LocalISO
}

/**
 * A rejected candidate that repair could conceivably do something with — every
 * blocker in the way is flexible, real, and movable.
 *
 * Deliberately not every rejected candidate: a full horizon produces tens of
 * thousands of them, repair looks at four, and nothing else reads the list.
 * Candidates blocked by a wall, or refused by a cap, are counted through the
 * failure code instead, which is what actually gets reported.
 */
export interface CandidateAttempt {
  start: LocalISO
  end: LocalISO
  /** The movable commitments in the way. Never empty — that is the point of the list. */
  blockers: BusyBlock[]
}

export type PlaceResult =
  | { ok: true; block: PlacedBlock }
  | { ok: false; code: UnplacedCode; detail?: Record<string, string | number>; attempts: CandidateAttempt[] }

export function placeOne(
  ctx: SchedulingContext,
  request: PlacementRequest,
  requestIndex: number,
  durationMinutes: number,
  windows: DayWindow[],
  state: PlacementState,
  opts: PlaceOptions = {}
): PlaceResult {
  const buffer = opts.bufferMinutes ?? ctx.profile.bufferMinutes
  const rules = ctx.rules

  // Length bounds are a property of the request, not of any one slot, so they are
  // checked once instead of 450 times.
  if (durationMinutes < rules.minBlock || durationMinutes > rules.maxBlock) {
    return {
      ok: false,
      code: 'no_window',
      detail: { reason: 'block_length', minutes: durationMinutes, minBlock: rules.minBlock, maxBlock: rules.maxBlock },
      attempts: [],
    }
  }

  const dayScoped = opts.restrictToDay ? windows.filter(w => w.day === opts.restrictToDay) : windows
  const floor = maxISO(ctx.now, request.earliest)
  const admissible = clipWindows(dayScoped, floor, request.deadline, durationMinutes)

  // Stage A — temporal admissibility. Distinguishing "the deadline removed every
  // window" from "the horizon did" from "the windows were never long enough" is
  // the difference between three different pieces of advice.
  if (admissible.length === 0) {
    return { ok: false, code: temporalFailure(ctx, request, dayScoped, floor, durationMinutes), detail: { minutes: durationMinutes }, attempts: [] }
  }

  // Stage B — collisions and caps, over the candidates that are in time.
  const attempts: CandidateAttempt[] = []
  const survivors: { start: LocalISO; end: LocalISO; total: number; block: PlacedBlock }[] = []
  const siblingDays = state.daysByRequest[requestIndex] ?? []
  let sawAskFirstOnly = false
  let sawFixed = false
  let sawTravel = false
  let sawCap = false
  let bestRejectedByFloor: number | null = null

  // Inflated and sorted ONCE per call. The buffer does not change while we
  // search, and rebuilding every block's padded span for every day was tens of
  // thousands of timestamp rebuilds per plan. Sorting here also means the
  // blockers reported for any candidate come out in a stable order for free.
  const inflated = state.busy
    .map(b => {
      const spacing = spacingAround(b, buffer, rules)
      // `core` is the span this block would have had before travel existed: the
      // commitment plus its spacing. Kept alongside the full span because it is
      // the only thing that can tell a real collision from a travel-only one —
      // see the note above `travelPad`, and the use in the candidate loop below.
      const core = inflate(b, spacing)
      const pad = travelPad(b, spacing)
      // Identical object when there is no travel, which both skips the second
      // set of timestamp rebuilds and makes the "is this travel-only" test below
      // a reference comparison for every block on an ordinary calendar.
      return { block: b, span: pad === null ? core : inflateSides(b, pad), core }
    })
    .sort((a, b) =>
      (a.block.start < b.block.start ? -1 : a.block.start > b.block.start ? 1 : 0) ||
      (a.block.id < b.block.id ? -1 : a.block.id > b.block.id ? 1 : 0)
    )
  const neighboursByDay = groupNeighboursByDay(state.busy)

  for (const window of admissible) {
    // Everything below is a property of the DAY, not of the candidate, and the
    // state cannot change while we walk one window — so it is computed once here
    // instead of ~60 times inside the loop. Recomputing the day's committed
    // minutes per candidate was 90% of the engine's runtime.
    const relevant = inflated.filter(e => overlaps(e.span, window))
    const neighbours = neighboursByDay.get(window.day) ?? []
    const dayFull = exceedsDayCap(ctx, windows, state, window.day, durationMinutes, opts.ignoreAskFirst ?? false)
    const dayContext = buildDayScoreContext(ctx, request, window.day, neighbours, siblingDays)

    for (const span of candidateSpans(window, durationMinutes, opts.pinnedStart)) {
      const { start, end } = span

      // Allocates nothing at all for a free candidate, which is the common case.
      let blockers: BusyBlock[] | null = null
      // How a travel-only collision is told apart from a real one, and the whole
      // trick is that `core` is kept: a candidate that overlaps a block's full
      // span but NOT its core never touched the commitment or its buffer, so the
      // only thing it ran into was the journey. `e.core === e.span` is the
      // no-travel case (same object, built once above) and short-circuits it.
      let hitCore = false
      for (const e of relevant) {
        if (!overlaps(span, e.span)) continue
        if (opts.ignoreAskFirst && e.block.mobility === 'ask_first') continue
        (blockers ??= []).push(e.block)
        if (e.core === e.span || overlaps(span, e.core)) hitCore = true
      }
      if (blockers) {
        // Collisions are checked before caps so that `day_cap_reached` only ever
        // means "the slot was genuinely free and a rule of your method refused
        // it" — otherwise the cap would mask every real obstacle behind it.
        //
        // Travel is checked before the mobility ladder for the same reason it is
        // reported before `blocked_by_fixed`: when nothing but the journey was in
        // the way, naming the lecture is naming the wrong obstacle. Note this
        // also keeps such a candidate out of `attempts` — repair moves events,
        // and a travel window is not an event it could move.
        if (!hitCore) sawTravel = true
        else if (blockers.every(b => b.mobility === 'ask_first')) sawAskFirstOnly = true
        else if (blockers.some(b => b.mobility === 'fixed')) sawFixed = true
        else if (blockers.every(isDisplaceable)) attempts.push({ start, end, blockers })
        continue
      }

      if (dayFull) {
        sawCap = true
        continue
      }

      const scored = scoreCandidate({
        ctx, request, start, end, siblingDays, neighbours, dayContext,
        durationMinutes,
        isFrog: opts.isFrog ?? false,
        bufferMinutes: buffer,
      })
      // A slot this bad is worse than no slot: the user deletes it on sight, and
      // the deletion then teaches priors that the hour was the problem.
      if (scored.total < MIN_ACCEPTABLE_SCORE) {
        if (bestRejectedByFloor === null || scored.total > bestRejectedByFloor) bestRejectedByFloor = scored.total
        continue
      }
      survivors.push({
        start,
        end,
        total: scored.total,
        block: { requestIndex, title: request.title, start, end, score: scored.total, reasons: scored.reasons },
      })
    }
  }

  if (survivors.length === 0) {
    // A slot that existed and was merely awful is a different answer from no slot
    // at all, and it points at different advice.
    if (bestRejectedByFloor !== null) {
      return {
        ok: false,
        code: 'below_quality_floor',
        detail: { bestScore: bestRejectedByFloor, floor: MIN_ACCEPTABLE_SCORE },
        attempts,
      }
    }
    return { ok: false, code: collisionFailure(sawAskFirstOnly, sawCap, sawTravel, sawFixed), attempts }
  }

  // Ties break on (start ascending, then title ascending) so the same context
  // always yields the same plan, byte for byte.
  survivors.sort((a, b) =>
    (b.total - a.total) ||
    (a.start < b.start ? -1 : a.start > b.start ? 1 : 0) ||
    (a.block.title < b.block.title ? -1 : a.block.title > b.block.title ? 1 : 0)
  )
  return { ok: true, block: survivors[0].block }
}

/**
 * How much empty time must sit on each side of one commitment while we search.
 *
 * ── Why a break is spacing, and not a block ────────────────────────────────
 *
 * `MethodRules.breakMinutes` / `breakAfterMinutes` describe a promise the UI has
 * already made the user: METHOD_LABELS.pomodoro says "25-min focused sessions
 * with 5-min breaks", rule_5217 says "52 min work + 17 min real break". There
 * were three ways to keep it, and only one of them survives contact with the
 * rest of the engine:
 *
 *   (a) A break as its own PlacedBlock. Rejected. A PlacedBlock carries the
 *       ScoredReasons that won its slot (types.ts, invariant 3) and a break wins
 *       nothing — it is a consequence of the session before it, so it would have
 *       to ship with either no reasons (an unexplained block, which the invariant
 *       forbids) or invented ones (which is exactly the narration the engine
 *       exists to abolish). It also collides with every number next to it:
 *       `commitBlock` would charge it to `sessionsByDay`, halving pomodoro's
 *       maxSessionsPerDay of 8 to four real sessions; `busyMinutesIn` would
 *       charge it to `dailyCapMinutes`; and on apply_plan it would become a real
 *       CalendarEvent the user has to delete eight times a day. Nobody wants
 *       "הפסקה" written on their calendar eight times. They want the gap.
 *
 *   (b) Spacing — what this function does. A break IS empty time between two
 *       work blocks, and timeline.ts already owns exactly that concept: a block
 *       inflated by N minutes cannot be scheduled against within N minutes.
 *       Nothing new is invented, nothing new is stored, and there is no second
 *       copy of the numbers — METHOD_RULES stays the one table.
 *
 *   (c) A longer block with the break inside it. Rejected: it would make
 *       clampBlock's bounds mean "work plus rest", so pomodoro's promised 25
 *       minutes would land on the calendar as 30 and METHOD_FIT would score the
 *       length the user was never promised.
 *
 * ── Why it REPLACES the buffer rather than adding to it ───────────────────
 *
 * `profile.bufferMinutes` is breathing room around the user's *existing
 * commitments* — 15 minutes to walk out of a lecture. Between two sessions of
 * the method's own rhythm the right separation is the method's break, which is a
 * different and deliberately chosen number. Taking the max, or the sum, would
 * mean pomodoro's 5-minute break could never happen at all, because a 15-minute
 * buffer forbids it: the promise would stay unkept in the name of respecting it.
 * So for the plan's own blocks the break governs, and it cuts both ways — it
 * loosens pomodoro (5 < 15) and tightens rule_5217 (17 > 15).
 *
 * Scoped to engine blocks (`ENGINE_BLOCK_PREFIX`) because those are precisely the
 * blocks this method shaped. A lecture on the user's calendar was not sized by
 * pomodoro and gets the buffer it always got, which is also what keeps this inert
 * for the sixteen methods that configure no break.
 *
 * `breakAfterMinutes` is the threshold it says it is: a block that did not reach
 * that much continuous work has not earned a break, and keeps the buffer.
 *
 * One consequence worth stating: the `drop_buffer` relaxation (bufferMinutes: 0)
 * does NOT drop the break. Dropping breathing room is the user's trade to make;
 * dropping a break would quietly cancel the promise METHOD_LABELS made them, and
 * `Relaxation.wouldPlace` stays honest either way because it re-runs this same
 * filter rather than estimating.
 *
 * What this function returns is only half the room around a block. Travel is the
 * other half and it is added to this rather than competing with it — see
 * `travelPad` in timeline.ts, the one place the two are composed, and the only
 * one, because `blockersFor` needs the identical rule.
 */
export function spacingAround(block: BusyBlock, bufferMinutes: number, rules: MethodRules): number {
  const { breakMinutes, breakAfterMinutes } = rules
  // Cheapest discriminator first: 16 of 18 methods leave here immediately, and
  // the string test runs before any timestamp is parsed.
  if (breakMinutes === undefined || breakAfterMinutes === undefined) return bufferMinutes
  if (!isEngineBlock(block.id) || block.isAllDay) return bufferMinutes
  return blockMinutes(block) >= breakAfterMinutes ? breakMinutes : bufferMinutes
}

/** Records a placement in the state so every later decision can see it. */
export function commitBlock(
  state: PlacementState,
  requestIndex: number,
  block: PlacedBlock,
  busy: BusyBlock
): void {
  const day = localDateKey(block.start)
  state.busy.push(busy)
  state.sessionsByDay[day] = (state.sessionsByDay[day] ?? 0) + 1
  const days = state.daysByRequest[requestIndex] ?? []
  days.push(day)
  state.daysByRequest[requestIndex] = days
}

/**
 * Which temporal constraint emptied the window list. Answered by removing one
 * constraint at a time and seeing which removal brings windows back, so the code
 * describes the constraint that is actually binding rather than the first guess.
 */
function temporalFailure(
  ctx: SchedulingContext,
  request: PlacementRequest,
  windows: DayWindow[],
  floor: LocalISO,
  durationMinutes: number
): UnplacedCode {
  if (windows.length === 0) return 'no_window'
  if (request.deadline && clipWindows(windows, floor, undefined, durationMinutes).length > 0) return 'deadline_too_close'
  if (clipWindows(windows, undefined, request.deadline, durationMinutes).length > 0) return 'horizon_exhausted'
  if (windows.some(w => minutesOf(w) >= durationMinutes)) return 'horizon_exhausted'
  return 'no_window'
}

/**
 * Precedence when everything collided: report the obstacle the user can do the
 * most about. An ask_first is a question we can ask them; a cap is a number they
 * chose; a fixed event is a wall; and "only flexible work was in the way, and
 * repair could not move it" is a genuine lack of room, which is its own answer
 * rather than the same one a too-short window gets.
 *
 * Travel goes AHEAD of fixed, which is the one place this ladder is not ordered
 * by how much the user can do about it. `blocked_by_fixed` renders as "fixed
 * events block every option"; if even one candidate was refused by a journey
 * rather than by an event, that sentence is false and the user is sent to look
 * at a calendar where nothing is drawn at the time we refused. A travel window is
 * invisible by design, so it is the half of the answer they cannot work out for
 * themselves; a wall they can see is the half they can.
 */
function collisionFailure(sawAskFirstOnly: boolean, sawCap: boolean, sawTravel: boolean, sawFixed: boolean): UnplacedCode {
  if (sawAskFirstOnly) return 'needs_user_approval'
  if (sawCap) return 'day_cap_reached'
  if (sawTravel) return 'blocked_by_travel'
  if (sawFixed) return 'blocked_by_fixed'
  return 'no_free_space'
}

/**
 * Could repair plausibly find this block another home? Repair applies the full
 * test itself (depth, what it has already moved); this is the cheap half, used
 * to keep hopeless candidates out of the attempts list in the first place.
 */
function isDisplaceable(block: BusyBlock): boolean {
  return block.mobility === 'flexible' && !block.isAllDay && !isEngineBlock(block.id)
}

/** Would this block push the day past either of the method's two ceilings? */
function exceedsDayCap(
  ctx: SchedulingContext,
  windows: DayWindow[],
  state: PlacementState,
  day: string,
  durationMinutes: number,
  ignoreAskFirst: boolean
): boolean {
  if ((state.sessionsByDay[day] ?? 0) + 1 > ctx.rules.maxSessionsPerDay) return true
  // An ask_first event we are pretending away must not still consume the cap —
  // otherwise the `move_ask_first` relaxation clears the slot and then refuses
  // to use it, and reports a payoff of zero for advice that would have worked.
  const counted = ignoreAskFirst ? state.busy.filter(b => b.mobility !== 'ask_first') : state.busy
  // Measured against the day's FULL windows, not the ones clipped by this
  // request's deadline — otherwise a tight deadline would silently shrink the cap.
  const load = windows
    .filter(w => w.day === day)
    .reduce((sum, w) => sum + busyMinutesIn(w, counted), 0)
  return load + durationMinutes > ctx.rules.dailyCapMinutes
}

/** Commitments indexed by the day they start on, for the buffer term. All-day blocks are never neighbours — they are the day. */
function groupNeighboursByDay(busy: BusyBlock[]): Map<string, BusyBlock[]> {
  const byDay = new Map<string, BusyBlock[]>()
  for (const b of busy) {
    if (b.isAllDay) continue
    const day = localDateKey(b.start)
    const list = byDay.get(day)
    if (list) list.push(b)
    else byDay.set(day, [b])
  }
  return byDay
}

/**
 * The candidate spans inside one window, on the quarter-hour grid.
 *
 * Deliberately integer arithmetic over minutes-from-midnight rather than
 * repeated addMinutes: every clock.ts call re-validates the string with a regex
 * and rebuilds a Date, and at ~60 candidates a day over a two-week horizon that
 * is tens of thousands of parses per plan — for arithmetic that never leaves a
 * single day. The strings this produces are identical either way.
 */
function* candidateSpans(window: DayWindow, durationMinutes: number, pinnedStart?: LocalISO): Generator<Span> {
  if (pinnedStart) {
    const end = addMinutes(pinnedStart, durationMinutes)
    if (pinnedStart >= window.start && end <= window.end) yield { start: pinnedStart, end }
    return
  }
  // A start rounds up (a window opening at 09:07 cannot host 09:00) and an end
  // rounds down (a window closing at 23:59:59 cannot host a block ending 00:00).
  const from = minutesOfDay(window.day, window.start, 'up')
  const to = minutesOfDay(window.day, window.end, 'down')
  const first = Math.ceil(from / GRANULARITY_MINUTES) * GRANULARITY_MINUTES

  for (let m = first; m + durationMinutes <= to; m += GRANULARITY_MINUTES) {
    yield { start: atMinuteOf(window.day, m), end: atMinuteOf(window.day, m + durationMinutes) }
  }
}

/** Minutes from `day`'s midnight to `iso`, which belongs to `day` or is its end. */
function minutesOfDay(day: string, iso: LocalISO, round: 'up' | 'down'): number {
  if (iso.slice(0, 10) !== day) return 24 * 60
  const hh = Number(iso.slice(11, 13))
  const mm = Number(iso.slice(14, 16))
  const ss = Number(iso.slice(17, 19))
  return hh * 60 + mm + (round === 'up' && ss > 0 ? 1 : 0)
}

/** `day` at `m` minutes past midnight. m === 1440 is the following midnight. */
function atMinuteOf(day: string, m: number): LocalISO {
  if (m >= 24 * 60) return addMinutes(`${day}T00:00:00`, m)
  const hh = Math.floor(m / 60)
  const mm = m % 60
  return `${day}T${hh < 10 ? '0' : ''}${hh}:${mm < 10 ? '0' : ''}${mm}:00`
}

/** Snaps a start up to the next quarter hour, so plans read as 09:00, not 09:07. */
export function ceilToGrid(s: LocalISO): LocalISO {
  const [day, time] = s.split('T')
  const [hh, mm, ss] = time.split(':').map(Number)
  const minutes = (hh ?? 0) * 60 + (mm ?? 0) + ((ss ?? 0) > 0 ? 1 : 0)
  const snapped = Math.ceil(minutes / GRANULARITY_MINUTES) * GRANULARITY_MINUTES
  return addMinutes(`${day}T00:00:00`, snapped)
}

function maxISO(a: LocalISO, b?: LocalISO): LocalISO {
  return b && b > a ? b : a
}

/** Length of a block, in minutes. */
export function blockMinutes(block: { start: LocalISO; end: LocalISO }): number {
  return minutesBetween(block.start, block.end)
}
