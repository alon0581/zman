/**
 * plan.ts — the public entry point. Requests in, a PlanOutcome out.
 *
 * The strategy is greedy: order the requests most-constrained first, place each
 * one in its best surviving slot, and repair by bounded displacement only when a
 * request would otherwise fail. Not a CSP and not backtracking search — the
 * space is one horizon at quarter-hour resolution, so exhaustive scoring is
 * already cheap, and backtracking would trade the one thing this engine exists
 * to provide: a per-block answer to "why here". A block chosen by a search that
 * unwound three times cannot explain itself; a block that won its slot on a
 * scored comparison can.
 *
 * Determinism is a hard requirement, not a nicety: the same context must produce
 * the same plan byte for byte, which is what makes a fixture test able to assert
 * exact start times. So no `Date.now()`, no locale-sensitive comparisons (Hebrew
 * titles through localeCompare are ICU-version dependent), and every sort ends
 * in a total order.
 */

import { addMonths } from 'date-fns'
import { LocalISO, addMinutes, localDateKey, parseLocal, toLocalISO } from './clock'
import { topoOrder } from './depOrder'
import { classifyMobility } from './mobilityClassifier'
import {
  blockMinutes, cloneState, commitBlock, emptyState, ENGINE_BLOCK_PREFIX, PlaceOptions, PlaceResult,
  placeOne, PlacementState,
} from './place'
import { attemptRepair, MAX_REPAIR_DEPTH } from './repair'
import { overlaps } from './timeline'
import {
  BusyBlock, DayWindow, Displacement, Energy, MethodRules, PlacedBlock, PlacementRequest,
  PlanOutcome, Recurrence, Relaxation, RelaxationCode, SchedulingContext, Unplaced, UnplacedCode,
} from './types'
import { buildDayWindows, clipWindows, eachDayKey } from './windows'

/** How far a recurring request may run when the caller gives neither count nor endDate. */
const MAX_RECURRENCE_INSTANCES = 52
/** `shorten_sessions` proposes two thirds of the session, floored at the method's minimum. */
const SHORTEN_FACTOR = 2 / 3
/** `extend_day` proposes one hour at each end. */
const EXTEND_DAY_HOURS = 1
/**
 * `extend_horizon` proposes looking a week further out.
 *
 * A week, not a day, because the point is to answer "there isn't enough room" —
 * and a single extra day rarely changes that answer, so offering one would be
 * technically true and practically useless.
 */
const EXTEND_HORIZON_DAYS = 7
/**
 * How many failed sessions each relaxation probe will actually try to re-place.
 *
 * Every probe is a real placement pass, so the cost is (relaxation codes) x
 * (backlog). The bound keeps a pathological backlog from turning one chat reply
 * into a multi-second wait, and is why Relaxation.wouldPlace is a floor rather
 * than an exact count. Set well above any realistic backlog — the acceptance-gate
 * week has 16 — so in practice it does not bind and the number is exact.
 */
const MAX_RELAXATION_PROBE_SESSIONS = 24
/** Sorts a request with no deadline last: above every character an ISO date uses. */
const NO_DEADLINE = '￿'

/** A session that failed to place, kept so relaxations can be costed honestly. */
interface PendingSession {
  requestIndex: number
  request: PlacementRequest
  durationMinutes: number
  /** Set for recurrence instances, which are anchored to a specific day. */
  restrictToDay?: string
}

export function planSchedule(ctx: SchedulingContext, requests: PlacementRequest[]): PlanOutcome {
  const baseWindows = buildDayWindows(ctx.profile, ctx.horizon)
  const state = emptyState(ctx)
  const blocks: PlacedBlock[] = []
  const displacements: Displacement[] = []
  const unplaced: Unplaced[] = []
  const pending: PendingSession[] = []

  // Most-constrained-first, then reordered so nothing precedes its prerequisites.
  // With no dependsOn anywhere — which is every input the app produces today —
  // topoOrder returns the comparator's array unchanged, so this is a no-op.
  const preferred = orderRequests(requests, ctx.rules)
  const { order } = topoOrder(requests, preferred)
  // eat_the_frog's claim is about one item: the hardest one, earliest. Ordering
  // already put it first, so it is simply the head of the queue.
  const frogIndex = ctx.rules.hardestFirst && order.length > 0 ? order[0] : -1

  // Dependency bookkeeping, keyed by ref.id because that is what dependsOn names.
  const placedEndByRefId = new Map<string, LocalISO>()
  const failedRefIds = new Set<string>()

  for (const requestIndex of order) {
    const raw = requests[requestIndex]

    // A prerequisite that did not fit means this one cannot honestly be placed
    // either — scheduling step 2 when step 1 has no slot is a lie the caller
    // would have no way to see.
    if (raw.dependsOn?.some(id => failedRefIds.has(id))) {
      unplaced.push({ requestIndex, code: 'blocked_by_dependency', placedCount: 0 })
      if (raw.ref?.id) failedRefIds.add(raw.ref.id)
      continue
    }

    const request = withDependencyFloor(raw, placedEndByRefId)
    const windows = windowsFor(request, baseWindows, ctx)
    const opts: PlaceOptions = { isFrog: requestIndex === frogIndex }

    const blocksBefore = blocks.length
    if (request.recurrence) {
      placeRecurring(ctx, request, requestIndex, windows, state, opts, blocks, displacements, unplaced, pending)
    } else {
      placeSessions(ctx, request, requestIndex, windows, state, opts, blocks, displacements, unplaced, pending)
    }

    // Record where this request actually landed, so its dependents can start after
    // its LAST session rather than its first.
    const refId = raw.ref?.id
    if (refId) {
      let latest: LocalISO | undefined
      for (let i = blocksBefore; i < blocks.length; i++) {
        if (!latest || blocks[i].end > latest) latest = blocks[i].end
      }
      if (latest) placedEndByRefId.set(refId, latest)
      else failedRefIds.add(refId)
    }
  }

  blocks.sort(byStartThenTitle)

  if (unplaced.length === 0) return { status: 'ok', blocks, displacements }

  const relaxations = computeRelaxations(ctx, baseWindows, state, pending)
  if (blocks.length === 0) return { status: 'blocked', unplaced, relaxations }
  return { status: 'partial', blocks, displacements, unplaced, relaxations }
}

// ── Ordering ────────────────────────────────────────────────────────────────

const ENERGY_RANK: Record<Energy, number> = { high: 0, medium: 1, low: 2 }

/**
 * Most-constrained first. A request with a tight deadline has the fewest places
 * it can go, so it must choose before anything with a whole horizon to play
 * with; length breaks the next tie, because a long block is harder to fit than a
 * short one. Under eat_the_frog, energy outranks both — that is the method.
 */
export function orderRequests(requests: PlacementRequest[], rules: MethodRules): number[] {
  return requests
    .map((_, i) => i)
    .sort((a, b) => {
      const ra = requests[a]
      const rb = requests[b]
      if (rules.hardestFirst) {
        const byEnergy = ENERGY_RANK[ra.energy ?? 'medium'] - ENERGY_RANK[rb.energy ?? 'medium']
        if (byEnergy !== 0) return byEnergy
      }
      const da = ra.deadline ?? NO_DEADLINE
      const db = rb.deadline ?? NO_DEADLINE
      if (da !== db) return da < db ? -1 : 1
      const byLength = totalMinutesOf(rb, rules) - totalMinutesOf(ra, rules)
      if (byLength !== 0) return byLength
      // Code-unit comparison, never localeCompare — collation differs between ICU
      // versions, and a plan that depends on the Node build is not deterministic.
      if (ra.title !== rb.title) return ra.title < rb.title ? -1 : 1
      return a - b
    })
}

function totalMinutesOf(request: PlacementRequest, rules: MethodRules): number {
  if (request.totalMinutes) return request.totalMinutes
  return (request.sessionMinutes ?? rules.sessionMinutes) * (request.sessionCount ?? 1)
}

// ── Splitting ───────────────────────────────────────────────────────────────

/**
 * Turns a request into concrete session lengths.
 *
 * Every session is the same length, clamped into the method's block bounds, so
 * that what lands on the calendar matches what METHOD_LABELS promised the user.
 * The last session absorbs any remainder from an uneven split, but only while
 * that keeps it inside the bounds — a 20-minute stub tacked onto a Pomodoro plan
 * is worse than losing the twenty minutes.
 */
export function splitSessions(request: PlacementRequest, rules: MethodRules): number[] {
  const count = sessionCountOf(request, rules)
  const total = request.totalMinutes
  // A caller who named a session count is dividing the work N ways; a caller who
  // named only a total wants sessions of the method's own length, however many
  // that takes. Deriving the length from the count in the second case would
  // quietly rewrite "four Pomodoros" into "three 33-minute blocks".
  const nominal = request.sessionMinutes
    ?? (total && request.sessionCount ? Math.round(total / count) : rules.sessionMinutes)
  const per = clampBlock(roundToQuarter(nominal), rules)

  // `totalMinutes` is the commitment; `sessionCount` is only a preference for how
  // to spread it. When the method's block ceiling means the requested count cannot
  // hold the total — "12 hours in 6 sessions" against Pomodoro's 25-minute cap —
  // honouring the count silently delivers 2.5 hours and calls it done. That is the
  // exact dishonesty this engine exists to remove, so the count gives way instead.
  // If the extra sessions then don't fit the days, placement reports that honestly.
  const sessions = total && per * count < total ? Math.ceil(total / per) : count

  const lengths = Array<number>(sessions).fill(per)
  if (total) {
    const remainder = total - per * sessions
    const last = clampBlock(per + remainder, rules)
    if (remainder !== 0 && last >= rules.minBlock && last <= rules.maxBlock) {
      lengths[lengths.length - 1] = last
    }
  }
  return lengths
}

function sessionCountOf(request: PlacementRequest, rules: MethodRules): number {
  if (request.sessionCount && request.sessionCount > 0) return request.sessionCount
  if (request.totalMinutes) {
    const per = clampBlock(roundToQuarter(request.sessionMinutes ?? rules.sessionMinutes), rules)
    return Math.max(1, Math.ceil(request.totalMinutes / per))
  }
  return 1
}

function clampBlock(minutes: number, rules: MethodRules): number {
  return Math.max(rules.minBlock, Math.min(rules.maxBlock, minutes))
}

function roundToQuarter(minutes: number): number {
  return Math.max(15, Math.round(minutes / 15) * 15)
}

// ── Placement passes ────────────────────────────────────────────────────────

function placeSessions(
  ctx: SchedulingContext,
  request: PlacementRequest,
  requestIndex: number,
  windows: DayWindow[],
  state: PlacementState,
  opts: PlaceOptions,
  blocks: PlacedBlock[],
  displacements: Displacement[],
  unplaced: Unplaced[],
  pending: PendingSession[]
): void {
  const lengths = splitSessions(request, ctx.rules)
  /** The session this one would follow, for a method whose rhythm is a cycle. */
  let previous: PlacedBlock | undefined

  for (let i = 0; i < lengths.length; i++) {
    const outcome = placeCycled(ctx, request, requestIndex, lengths[i], windows, state, opts, previous)
    if (outcome.ok) {
      adopt(state, requestIndex, request, outcome.block, outcome.displacements, blocks, displacements)
      previous = outcome.block
      continue
    }
    // The first failure ends the request: later sessions face a strictly tighter
    // world, and reporting one honest Unplaced beats N copies of the same news.
    unplaced.push({
      requestIndex,
      code: outcome.code,
      placedCount: i,
      detail: { ...outcome.detail, sessions: lengths.length },
    })
    for (let j = i; j < lengths.length; j++) {
      pending.push({ requestIndex, request, durationMinutes: lengths[j] })
    }
    return
  }
}

/**
 * A recurring request becomes concrete instances, and every one of them goes
 * through the full hard filter. The old create_event skipped conflict checks for
 * recurring events outright, which is how a weekly series quietly double-booked
 * itself from week three onward.
 */
function placeRecurring(
  ctx: SchedulingContext,
  request: PlacementRequest,
  requestIndex: number,
  windows: DayWindow[],
  state: PlacementState,
  opts: PlaceOptions,
  blocks: PlacedBlock[],
  displacements: Displacement[],
  unplaced: Unplaced[],
  pending: PendingSession[]
): void {
  const duration = splitSessions(request, ctx.rules)[0]

  // The anchor decides where every later instance lands, so it must not be free
  // to settle in the last week of the horizon and strand the rest of the series.
  // Best-effort: if holding the whole series inside the horizon leaves nowhere at
  // all to start, take what we can get and report the overflow instance by
  // instance rather than refusing to place anything.
  const ceiling = anchorCeiling(request.recurrence!, ctx.horizon.to)
  const anchorWindows = ceiling ? preferNonEmpty(clipWindows(windows, undefined, ceiling, duration), windows) : windows

  const first = placeWithRepair(ctx, request, requestIndex, duration, anchorWindows, state, opts)
  if (!first.ok) {
    unplaced.push({ requestIndex, code: first.code, placedCount: 0, detail: { ...first.detail, instance: 0 } })
    pending.push({ requestIndex, request, durationMinutes: duration })
    return
  }
  adopt(state, requestIndex, request, first.block, first.displacements, blocks, displacements)

  const anchorDay = localDateKey(first.block.start)
  const anchorTime = first.block.start.slice(11)
  let placedCount = 1

  for (const { index, day } of instanceDays(request.recurrence!, anchorDay, ctx.horizon.to)) {
    // A series wants to keep its time, so the anchor's hour is tried first — but
    // only if it is genuinely free. Displacing someone's work to defend a habit
    // is a worse trade than moving the instance an hour later, so repair is left
    // to the full-day search that follows.
    const pinned = placeOne(ctx, request, requestIndex, duration, windows, state, {
      ...opts, restrictToDay: day, pinnedStart: `${day}T${anchorTime}`,
    })
    const outcome: Attempted = pinned.ok
      ? { ok: true, block: pinned.block, displacements: [] }
      : placeWithRepair(ctx, request, requestIndex, duration, windows, state, { ...opts, restrictToDay: day })

    if (outcome.ok) {
      adopt(state, requestIndex, request, outcome.block, outcome.displacements, blocks, displacements)
      placedCount++
      continue
    }
    // Per-instance failure, reported rather than swallowed.
    unplaced.push({ requestIndex, code: outcome.code, placedCount, detail: { ...outcome.detail, instance: index, day } })
    pending.push({ requestIndex, request, durationMinutes: duration, restrictToDay: day })
  }
}

type Attempted =
  | { ok: true; block: PlacedBlock; displacements: Displacement[] }
  | { ok: false; code: UnplacedCode; detail?: Record<string, string | number> }

/**
 * One session, tried first at exactly one break after the previous one ended.
 *
 * place.ts's `spacingAround` makes the break room EXIST — nothing may be booked
 * into it. That alone does not make it happen: scoring, not the hard filter,
 * picks where a block goes, and BUFFER_RESPECTED rewards distance, so the second
 * pomodoro of the day drifted 35 minutes out and the user got "25 minutes of
 * work, then a hole" rather than the cycle METHOD_LABELS sold them. So a method
 * that promises a break gets its cadence offered first.
 *
 * This is the same move `placeRecurring` already makes one function below — a
 * series is tried at its anchor's time before the open search — for the same
 * reason: some shapes are the user's promise rather than the scorer's opinion. It
 * reuses `pinnedStart`, so nothing about attribution changes. The pinned attempt
 * is an ordinary `placeOne`: it faces the same hard filter, the same day caps and
 * the same MIN_ACCEPTABLE_SCORE, and the block it returns carries the reasons it
 * actually scored. When it does not survive any of those, we simply fall through
 * to the normal search — a failed cadence costs the plan nothing and hides no
 * rejection, because the fallback is the exact call that ran here before.
 *
 * Deliberately NOT applied through repair: displacing someone's real commitment
 * to defend a rhythm is the same bad trade `placeRecurring` refuses for a habit.
 * And deliberately not applied to recurrence instances, which are anchored to
 * separate days, where a five-minute break means nothing.
 */
function placeCycled(
  ctx: SchedulingContext,
  request: PlacementRequest,
  requestIndex: number,
  durationMinutes: number,
  windows: DayWindow[],
  state: PlacementState,
  opts: PlaceOptions,
  previous: PlacedBlock | undefined
): Attempted {
  const cadence = nextCycleStart(ctx.rules, previous)
  if (cadence) {
    const pinned = placeOne(ctx, request, requestIndex, durationMinutes, windows, state, {
      ...opts, pinnedStart: cadence,
    })
    if (pinned.ok) return { ok: true, block: pinned.block, displacements: [] }
  }
  return placeWithRepair(ctx, request, requestIndex, durationMinutes, windows, state, opts)
}

/**
 * Where the next session of a cycle starts: the previous end plus the break.
 *
 * Undefined for the sixteen methods that configure no break, and for a session
 * that did not run long enough to have earned one — `breakAfterMinutes` is the
 * amount of continuous work that triggers the break, and a block shorter than it
 * is not the end of a cycle.
 */
function nextCycleStart(rules: MethodRules, previous: PlacedBlock | undefined): LocalISO | undefined {
  if (!previous) return undefined
  const { breakMinutes, breakAfterMinutes } = rules
  if (breakMinutes === undefined || breakAfterMinutes === undefined) return undefined
  if (blockMinutes(previous) < breakAfterMinutes) return undefined
  return addMinutes(previous.end, breakMinutes)
}

function placeWithRepair(
  ctx: SchedulingContext,
  request: PlacementRequest,
  requestIndex: number,
  durationMinutes: number,
  windows: DayWindow[],
  state: PlacementState,
  opts: PlaceOptions
): Attempted {
  const result: PlaceResult = placeOne(ctx, request, requestIndex, durationMinutes, windows, state, opts)
  if (result.ok) return { ok: true, block: result.block, displacements: [] }

  const repaired = attemptRepair(
    ctx, request, requestIndex, durationMinutes, windows, state, result, opts, MAX_REPAIR_DEPTH
  )
  if (repaired) {
    // Adopt the repaired world: displaced blocks now sit at their new times.
    state.busy = repaired.state.busy
    state.sessionsByDay = repaired.state.sessionsByDay
    state.daysByRequest = repaired.state.daysByRequest
    return { ok: true, block: repaired.block, displacements: repaired.displacements }
  }
  return { ok: false, code: result.code, detail: result.detail }
}

function adopt(
  state: PlacementState,
  requestIndex: number,
  request: PlacementRequest,
  block: PlacedBlock,
  fromRepair: Displacement[],
  blocks: PlacedBlock[],
  displacements: Displacement[]
): void {
  commitBlock(state, requestIndex, block, asBusy(request, block, requestIndex))
  blocks.push(block)
  displacements.push(...fromRepair)
}

function asBusy(request: PlacementRequest, block: PlacedBlock, requestIndex: number): BusyBlock {
  return {
    id: `${ENGINE_BLOCK_PREFIX}${requestIndex}:${block.start}`,
    title: block.title,
    start: block.start,
    end: block.end,
    // The engine is the AI, so an unspecified mobility gets the same answer the
    // rest of the app would give an AI-created event.
    mobility: request.mobility ?? classifyMobility(block.title, 'ai'),
    createdBy: 'ai',
    isAllDay: false,
    category: request.category,
  }
}

// ── Recurrence ──────────────────────────────────────────────────────────────

/**
 * The latest day instance 0 may start on and still leave room for the whole
 * series: the last permissible day, walked back by the same stride.
 */
function anchorCeiling(recurrence: Recurrence, horizonTo: LocalISO): LocalISO | undefined {
  if (!recurrence.count || recurrence.count <= 1) return undefined
  const steps = Math.min(recurrence.count, MAX_RECURRENCE_INSTANCES) - 1
  const lastAllowed = recurrence.endDate
    ? minDay(localDateKey(recurrence.endDate), localDateKey(horizonTo))
    : localDateKey(horizonTo)
  return `${shiftDay(lastAllowed, -steps, recurrence.frequency)}T23:59:59`
}

function preferNonEmpty(clipped: DayWindow[], fallback: DayWindow[]): DayWindow[] {
  return clipped.length > 0 ? clipped : fallback
}

/** The concrete days instances 1..n-1 fall on, clipped to the horizon. */
function instanceDays(recurrence: Recurrence, anchorDay: string, horizonTo: LocalISO): { index: number; day: string }[] {
  const limit = recurrence.count && recurrence.count > 0
    ? Math.min(recurrence.count, MAX_RECURRENCE_INSTANCES)
    : MAX_RECURRENCE_INSTANCES
  const lastDay = recurrence.endDate
    ? minDay(localDateKey(recurrence.endDate), localDateKey(horizonTo))
    : localDateKey(horizonTo)

  const out: { index: number; day: string }[] = []
  for (let index = 1; index < limit; index++) {
    const day = shiftDay(anchorDay, index, recurrence.frequency)
    if (day > lastDay) break
    out.push({ index, day })
  }
  return out
}

function shiftDay(day: string, steps: number, frequency: Recurrence['frequency']): string {
  if (frequency === 'monthly') {
    // Anchored at noon so month arithmetic can never be nudged across a day
    // boundary by a DST transition at midnight.
    return localDateKey(toLocalISO(addMonths(parseLocal(`${day}T12:00:00`), steps)))
  }
  const stride = frequency === 'biweekly' ? 14 : 7
  return localDateKey(addMinutes(`${day}T00:00:00`, steps * stride * 24 * 60))
}

function minDay(a: string, b: string): string {
  return a < b ? a : b
}

// ── Relaxations ─────────────────────────────────────────────────────────────

/**
 * What the user could give up, and what it would buy them.
 *
 * `wouldPlace` is computed, never estimated: each relaxation re-runs the real
 * filter over the sessions that actually failed, on a throwaway copy of the
 * state. A guessed number here would be exactly the kind of confident-sounding
 * fiction the engine exists to eliminate.
 *
 * A trial that cannot possibly change anything is skipped rather than probed —
 * offering to drop a buffer of zero is both a lie and a wasted search.
 */
function computeRelaxations(
  ctx: SchedulingContext,
  baseWindows: DayWindow[],
  state: PlacementState,
  pending: PendingSession[]
): Relaxation[] {
  if (pending.length === 0) return []

  const shortest = Math.min(...pending.map(p => p.durationMinutes))
  const shortened = Math.max(ctx.rules.minBlock, roundToQuarter(shortest * SHORTEN_FACTOR))
  const weekendWindows = buildDayWindows(ctx.profile, ctx.horizon, { includeWeekend: true })
  const extendedHorizon = { from: ctx.horizon.from, to: addMinutes(ctx.horizon.to, EXTEND_HORIZON_DAYS * 24 * 60) }
  const extendedWindows = buildDayWindows(ctx.profile, extendedHorizon)
  const askFirstInTheWay = state.busy.filter(b =>
    b.mobility === 'ask_first' && baseWindows.some(w => overlaps(b, w))
  ).length

  const trials: {
    code: RelaxationCode
    delta: string
    windows: DayWindow[]
    opts: PlaceOptions
    /** False when this relaxation provably changes nothing for this context. */
    applicable: boolean
    duration?: (p: PendingSession) => number
  }[] = [
    {
      code: 'shorten_sessions',
      delta: `${shortest} → ${shortened}`,
      windows: baseWindows,
      opts: {},
      applicable: shortened < shortest,
      duration: p => Math.max(ctx.rules.minBlock, roundToQuarter(p.durationMinutes * SHORTEN_FACTOR)),
    },
    {
      code: 'extend_day',
      delta: `+${EXTEND_DAY_HOURS}h ${ctx.profile.dayStartHour - EXTEND_DAY_HOURS}:00–${ctx.profile.dayEndHour + EXTEND_DAY_HOURS}:00`,
      windows: buildDayWindows(ctx.profile, ctx.horizon, {
        dayStartHour: ctx.profile.dayStartHour - EXTEND_DAY_HOURS,
        dayEndHour: ctx.profile.dayEndHour + EXTEND_DAY_HOURS,
      }),
      opts: {},
      applicable: ctx.profile.dayStartHour > 0 || ctx.profile.dayEndHour < 24,
    },
    {
      code: 'use_weekend',
      delta: 'Fri–Sat',
      windows: weekendWindows,
      opts: {},
      applicable: weekendWindows.length > baseWindows.length,
    },
    {
      code: 'move_ask_first',
      // Only the ones actually sitting inside the user's available hours — the
      // delta is a number they will read as "events I'd have to touch".
      delta: String(askFirstInTheWay),
      windows: baseWindows,
      opts: { ignoreAskFirst: true },
      applicable: askFirstInTheWay > 0,
    },
    {
      code: 'drop_buffer',
      delta: `${ctx.profile.bufferMinutes} → 0`,
      windows: baseWindows,
      opts: { bufferMinutes: 0 },
      applicable: ctx.profile.bufferMinutes > 0,
    },
    {
      // Deadlines are still enforced inside placement, so this reports 0 for a
      // session that has to happen before a fixed date — which is the honest
      // answer. It only ever helps open-ended work.
      code: 'extend_horizon',
      delta: `+${EXTEND_HORIZON_DAYS}d`,
      windows: extendedWindows,
      opts: {},
      applicable: extendedWindows.length > baseWindows.length,
    },
  ]

  const relaxations: Relaxation[] = []
  for (const trial of trials) {
    if (!trial.applicable) continue
    for (const [requestIndex, wouldPlace] of countPlaceable(ctx, trial.windows, state, pending, trial.opts, trial.duration)) {
      if (wouldPlace > 0) relaxations.push({ code: trial.code, delta: trial.delta, wouldPlace, requestIndex })
    }
  }

  relaxations.sort((a, b) =>
    (b.wouldPlace - a.wouldPlace) ||
    (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
    ((a.requestIndex ?? 0) - (b.requestIndex ?? 0))
  )
  return relaxations
}

/**
 * How many of the pending sessions this relaxation would place, per request.
 *
 * Bounded: past MAX_RELAXATION_PROBE_SESSIONS the probe stops, which is why
 * Relaxation.wouldPlace is documented as a floor. A backlog that long is already
 * being told "this does not fit" — the exact size of the shortfall is not what
 * makes the advice useful, and probing all of it turns a chat reply into a wait.
 */
function countPlaceable(
  ctx: SchedulingContext,
  windows: DayWindow[],
  state: PlacementState,
  pending: PendingSession[],
  opts: PlaceOptions,
  duration?: (p: PendingSession) => number
): Map<number, number> {
  // A throwaway world, so counting one relaxation cannot bias the next.
  const trial: PlacementState = cloneState(state)
  const placed = new Map<number, number>()
  for (const p of pending.slice(0, MAX_RELAXATION_PROBE_SESSIONS)) {
    const minutes = duration ? duration(p) : p.durationMinutes
    const scoped = p.request.hardWindows ? windowsFor(p.request, windows, ctx) : windows
    const result = placeOne(ctx, p.request, p.requestIndex, minutes, scoped, trial, {
      ...opts,
      restrictToDay: p.restrictToDay,
    })
    if (!result.ok) continue
    placed.set(p.requestIndex, (placed.get(p.requestIndex) ?? 0) + 1)
    commitBlock(trial, p.requestIndex, result.block, {
      id: `${ENGINE_BLOCK_PREFIX}relax:${p.requestIndex}:${result.block.start}`,
      title: result.block.title,
      start: result.block.start,
      end: result.block.end,
      mobility: 'flexible',
      createdBy: 'ai',
      isAllDay: false,
    })
  }
  return placed
}

// ── Shared helpers ──────────────────────────────────────────────────────────

/** hardWindows are a user constraint ("only in the evening") and replace the profile's. */
/**
 * Raises a request's `earliest` to the latest end among its prerequisites.
 *
 * Ordering alone only guarantees "A is CONSIDERED before B" — the greedy pass puts
 * A in its best slot, which may be Monday afternoon while B lands Monday morning.
 * This is what turns consideration order into actual "B starts after A ends".
 *
 * Nothing in place.ts, score.ts or repair.ts changes for this, because
 * `place.ts` already does the right thing with the field:
 *     const floor = maxISO(ctx.now, request.earliest)
 *     const admissible = clipWindows(dayScoped, floor, request.deadline, ...)
 * That is the whole payoff for `earliest` having existed from day one.
 *
 * LocalISO is naive and fixed-width, so string comparison IS chronological order —
 * the same assumption byStartThenTitle below already relies on.
 */
function withDependencyFloor(
  request: PlacementRequest,
  placedEndByRefId: Map<string, LocalISO>,
): PlacementRequest {
  if (!request.dependsOn?.length) return request

  let floor: LocalISO | undefined
  for (const depId of request.dependsOn) {
    const end = placedEndByRefId.get(depId)
    if (end && (!floor || end > floor)) floor = end
  }
  if (!floor) return request
  if (request.earliest && request.earliest >= floor) return request

  return { ...request, earliest: floor }
}

function windowsFor(request: PlacementRequest, baseWindows: DayWindow[], ctx: SchedulingContext): DayWindow[] {
  if (!request.hardWindows || request.hardWindows.length === 0) return baseWindows
  const horizonDays = new Set(eachDayKey(ctx.horizon.from, ctx.horizon.to))
  return clipWindows(
    request.hardWindows.filter(w => horizonDays.has(w.day)),
    ctx.horizon.from,
    ctx.horizon.to
  )
}

function byStartThenTitle(a: PlacedBlock, b: PlacedBlock): number {
  if (a.start !== b.start) return a.start < b.start ? -1 : 1
  if (a.title !== b.title) return a.title < b.title ? -1 : 1
  return a.requestIndex - b.requestIndex
}
