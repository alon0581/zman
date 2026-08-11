/**
 * repair.ts — making room by moving flexible work, within strict limits.
 *
 * When a request will not fit, the honest options are "tell the user" or "move
 * something". Moving something is only defensible if it is bounded, reversible
 * on paper, and reported — so:
 *
 *   - `fixed` is never moved. Not at any depth, not for any score.
 *   - `ask_first` is never moved either. It surfaces as a Relaxation with code
 *     `move_ask_first`, which is a question for the user, not a decision for us.
 *   - `flexible` may be moved, at most MAX_REPAIR_DEPTH levels deep, and every
 *     move lands in `displacements` with the reasons that justified its new home.
 *
 * Termination is guaranteed twice over, because one guarantee is easy to break
 * by accident: `depth` strictly decreases and stops the recursion at zero, and
 * `alreadyMoved` means a block that has been displaced once can never be chosen
 * as a blocker again, which forecloses A→B→A cycles independently of depth.
 */

import {
  blockMinutes, cloneState, PlaceOptions, PlaceResult, placeOne, PlacementState,
} from './place'
import { scoreCandidate } from './score'
import {
  BusyBlock, DayWindow, Displacement, PlacedBlock, PlacementRequest, SchedulingContext,
} from './types'

/** Two levels: "move the thing in my way", and "move the thing in *its* way". No further. */
export const MAX_REPAIR_DEPTH = 2

/** How many blocked candidates to try clearing per level. Caps the branching factor. */
const MAX_CANDIDATES_PER_LEVEL = 4
/** Clearing three or more commitments to seat one block is not a repair, it is a rewrite. */
const MAX_BLOCKERS_PER_CANDIDATE = 2
/**
 * Occupies the slot we are clearing so a displaced block cannot simply slide
 * into it. The span is part of the id because a depth-2 repair has two pins
 * alive at once, and removing the wrong one would re-open the slot the outer
 * level is still holding.
 */
const TARGET_PIN_PREFIX = '__repair_target__:'
/** Blocks re-homed on behalf of an existing event are not one of the caller's requests. */
const SYNTHETIC_REQUEST_INDEX = -1

export interface RepairResult {
  /** State with every displacement applied. The caller adopts it wholesale. */
  state: PlacementState
  /** The freshly scored placement the displacements made possible. */
  block: PlacedBlock
  displacements: Displacement[]
}

export function attemptRepair(
  ctx: SchedulingContext,
  request: PlacementRequest,
  requestIndex: number,
  durationMinutes: number,
  windows: DayWindow[],
  state: PlacementState,
  failure: Extract<PlaceResult, { ok: false }>,
  opts: PlaceOptions = {},
  depth: number = MAX_REPAIR_DEPTH,
  alreadyMoved: ReadonlySet<string> = new Set()
): RepairResult | null {
  if (depth <= 0) return null

  const candidates = failure.attempts
    .filter(a =>
      a.blockers.length > 0 &&
      a.blockers.length <= MAX_BLOCKERS_PER_CANDIDATE &&
      // Everything in the way must be movable, unmoved, and not an all-day block —
      // an all-day block has no other home inside a day it already fills.
      a.blockers.every(b => b.mobility === 'flexible' && !b.isAllDay && !alreadyMoved.has(b.id) && !b.id.startsWith(TARGET_PIN_PREFIX))
    )
    .map(a => ({
      attempt: a,
      // Rank by what the slot would have been worth, so repair spends its budget
      // clearing the best slot rather than the first one it happened to see.
      score: scoreCandidate({
        ctx,
        request,
        start: a.start,
        end: a.end,
        siblingDays: state.daysByRequest[requestIndex] ?? [],
        neighbours: [],
        isFrog: opts.isFrog ?? false,
        bufferMinutes: opts.bufferMinutes ?? ctx.profile.bufferMinutes,
      }).total,
    }))
    .sort((a, b) => (b.score - a.score) || (a.attempt.start < b.attempt.start ? -1 : 1))
    .slice(0, MAX_CANDIDATES_PER_LEVEL)

  for (const { attempt } of candidates) {
    const work = cloneState(state)
    const displacements: Displacement[] = []
    // Pin the slot we are freeing as immovable for the duration of the repair.
    const pin = pinFor(attempt.start, attempt.end)
    work.busy.push(pin)

    let cleared = true
    for (const blocker of attempt.blockers) {
      const rehomed = rehome(ctx, blocker, windows, work, opts, depth, alreadyMoved)
      if (!rehomed) { cleared = false; break }
      work.busy = rehomed.state.busy
      work.sessionsByDay = rehomed.state.sessionsByDay
      work.daysByRequest = rehomed.state.daysByRequest
      displacements.push(...rehomed.displacements)
    }
    if (!cleared) continue

    // Only this level's pin comes out — an enclosing level may still be holding one.
    work.busy = work.busy.filter(b => b.id !== pin.id)
    const placed = placeOne(ctx, request, requestIndex, durationMinutes, windows, work, {
      ...opts,
      pinnedStart: attempt.start,
    })
    if (!placed.ok) continue

    return { state: work, block: placed.block, displacements }
  }

  return null
}

/**
 * Finds a new home for one flexible block, recursing at most once more when the
 * block's own move is itself obstructed.
 */
function rehome(
  ctx: SchedulingContext,
  blocker: BusyBlock,
  windows: DayWindow[],
  state: PlacementState,
  opts: PlaceOptions,
  depth: number,
  alreadyMoved: ReadonlySet<string>
): { state: PlacementState; displacements: Displacement[] } | null {
  const work = cloneState(state)
  work.busy = work.busy.filter(b => b.id !== blocker.id)

  const duration = blockMinutes(blocker)
  const asRequest: PlacementRequest = {
    ref: { kind: 'event', id: blocker.id },
    title: blocker.title,
    category: blocker.category,
    mobility: 'flexible',
  }
  // Repair moves existing commitments, which were never bound by the method's
  // block-length rules, so those rules must not veto putting one back.
  const relaxedRules = { ...ctx.rules, minBlock: Math.min(ctx.rules.minBlock, duration), maxBlock: Math.max(ctx.rules.maxBlock, duration) }
  const relaxedCtx: SchedulingContext = { ...ctx, rules: relaxedRules }

  const moveOpts: PlaceOptions = { bufferMinutes: opts.bufferMinutes, ignoreAskFirst: opts.ignoreAskFirst }
  let result = placeOne(relaxedCtx, asRequest, SYNTHETIC_REQUEST_INDEX, duration, windows, work, moveOpts)
  const nested: Displacement[] = []

  if (!result.ok) {
    const deeper = attemptRepair(
      relaxedCtx, asRequest, SYNTHETIC_REQUEST_INDEX, duration, windows, work, result, moveOpts,
      depth - 1,
      // The block being moved joins the frozen set, so no chain can move it back.
      new Set([...alreadyMoved, blocker.id])
    )
    if (!deeper) return null
    work.busy = deeper.state.busy
    work.sessionsByDay = deeper.state.sessionsByDay
    work.daysByRequest = deeper.state.daysByRequest
    nested.push(...deeper.displacements)
    result = { ok: true, block: deeper.block }
  }

  const moved: BusyBlock = { ...blocker, start: result.block.start, end: result.block.end }
  work.busy.push(moved)

  const displacements = [...nested]
  if (moved.start !== blocker.start) {
    displacements.push({
      eventId: blocker.id,
      title: blocker.title,
      from: blocker.start,
      to: moved.start,
      reasons: result.block.reasons,
    })
  }
  return { state: work, displacements }
}

function pinFor(start: string, end: string): BusyBlock {
  return {
    id: `${TARGET_PIN_PREFIX}${start}`,
    title: 'repair target',
    start,
    end,
    mobility: 'fixed',
    createdBy: 'ai',
    isAllDay: false,
  }
}
