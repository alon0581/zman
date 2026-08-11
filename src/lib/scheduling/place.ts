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
import { scoreCandidate } from './score'
import { blockersFor, busyMinutesIn, Span } from './timeline'
import {
  BusyBlock, DayWindow, PlacedBlock, PlacementRequest, SchedulingContext, UnplacedCode,
} from './types'
import { clipWindows, minutesOf } from './windows'

/** Candidate starts land on quarter hours. Finer resolution buys nothing a human notices. */
export const GRANULARITY_MINUTES = 15

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

/** A candidate that was generated and then rejected, kept so repair can work from it. */
export interface CandidateAttempt {
  start: LocalISO
  end: LocalISO
  /** Commitments that stood in the way. Empty means the slot itself was free. */
  blockers: BusyBlock[]
  /** True when the slot was free and a method cap forbade it anyway. */
  capBlocked: boolean
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
  let sawAskFirstOnly = false
  let sawFixed = false
  let sawCap = false

  for (const window of admissible) {
    for (const start of candidateStarts(window, durationMinutes, opts.pinnedStart)) {
      const end = addMinutes(start, durationMinutes)
      const span: Span = { start, end }
      const day = window.day

      const blockers = blockersFor(span, state.busy, buffer)
        .filter(b => !(opts.ignoreAskFirst && b.mobility === 'ask_first'))
      if (blockers.length > 0) {
        // Collisions are checked before caps so that `day_cap_reached` only ever
        // means "the slot was genuinely free and a rule of your method refused
        // it" — otherwise the cap would mask every real obstacle behind it.
        if (blockers.every(b => b.mobility === 'ask_first')) sawAskFirstOnly = true
        else if (blockers.some(b => b.mobility === 'fixed')) sawFixed = true
        attempts.push({ start, end, blockers, capBlocked: false })
        continue
      }

      if (exceedsDayCap(ctx, windows, state, day, durationMinutes, opts.ignoreAskFirst ?? false)) {
        sawCap = true
        attempts.push({ start, end, blockers: [], capBlocked: true })
        continue
      }

      const scored = scoreCandidate({
        ctx,
        request,
        start,
        end,
        siblingDays: state.daysByRequest[requestIndex] ?? [],
        neighbours: neighboursOn(day, state.busy),
        isFrog: opts.isFrog ?? false,
        bufferMinutes: buffer,
      })
      survivors.push({
        start,
        end,
        total: scored.total,
        block: { requestIndex, title: request.title, start, end, score: scored.total, reasons: scored.reasons },
      })
    }
  }

  if (survivors.length === 0) {
    return { ok: false, code: collisionFailure(sawAskFirstOnly, sawCap, sawFixed), attempts }
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
 * repair could not move it" is the residual, which is a genuine lack of room.
 */
function collisionFailure(sawAskFirstOnly: boolean, sawCap: boolean, sawFixed: boolean): UnplacedCode {
  if (sawAskFirstOnly) return 'needs_user_approval'
  if (sawCap) return 'day_cap_reached'
  if (sawFixed) return 'blocked_by_fixed'
  return 'no_window'
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

/** Commitments sharing a day, for the buffer term. All-day blocks are never neighbours — they are the day. */
function neighboursOn(day: string, busy: BusyBlock[]): BusyBlock[] {
  return busy.filter(b => !b.isAllDay && localDateKey(b.start) === day)
}

function* candidateStarts(window: DayWindow, durationMinutes: number, pinnedStart?: LocalISO): Generator<LocalISO> {
  if (pinnedStart) {
    if (pinnedStart >= window.start && addMinutes(pinnedStart, durationMinutes) <= window.end) yield pinnedStart
    return
  }
  for (let start = ceilToGrid(window.start); addMinutes(start, durationMinutes) <= window.end; start = addMinutes(start, GRANULARITY_MINUTES)) {
    yield start
  }
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
