import { describe, it, expect } from 'vitest'
import { emptyState, placeOne, PlaceResult, PlacementState } from './place'
import { attemptRepair, MAX_REPAIR_DEPTH } from './repair'
import { BusyBlock, MethodRules, Mobility, PlacementRequest, SchedulingContext, SchedulingProfile } from './types'
import { buildDayWindows } from './windows'

const profile: SchedulingProfile = {
  timezone: 'Asia/Jerusalem',
  dayStartHour: 9,
  dayEndHour: 17,
  peakStartHour: 9,
  peakEndHour: 12,
  bufferMinutes: 0,
}

const rules: MethodRules = {
  sessionMinutes: 60,
  minBlock: 30,
  maxBlock: 180,
  maxSessionsPerDay: 3,
  preferContiguous: false,
  hardestFirst: false,
  dailyCapMinutes: 480,
}

/** Mon 10 – Wed 12 Aug 2026. */
const HORIZON = { from: '2026-08-10T00:00:00', to: '2026-08-13T00:00:00' }

function ctxOf(busy: BusyBlock[], over: Partial<SchedulingContext> = {}): SchedulingContext {
  return {
    now: '2026-08-10T08:00:00',
    horizon: HORIZON,
    profile,
    method: { primary: 'time_blocking', secondary: [] },
    rules,
    busy,
    priors: { hourWeight: {}, dayWeight: {} },
    ...over,
  }
}

function block(id: string, start: string, end: string, mobility: Mobility): BusyBlock {
  return { id, title: id, start, end, mobility, createdBy: mobility === 'flexible' ? 'ai' : 'user', isAllDay: false }
}

/** Wall of immovable work, so only the slot under test is ever in play. */
function wall(day: string, from = '09:00:00', to = '16:00:00'): BusyBlock {
  return block(`wall-${day}-${from}`, `${day}T${from}`, `${day}T${to}`, 'fixed')
}

/** The request can only ever land on the 10th. */
const request: PlacementRequest = {
  ref: { kind: 'task' },
  title: 'לימוד',
  deadline: '2026-08-10T17:00:00',
}

function repairAfterFailure(
  ctx: SchedulingContext,
  depth = MAX_REPAIR_DEPTH,
  req: PlacementRequest = request,
  minutes = 60
): { state: PlacementState; failed: Extract<PlaceResult, { ok: false }>; result: ReturnType<typeof attemptRepair> } {
  const windows = buildDayWindows(profile, HORIZON)
  const state = emptyState(ctx)
  const failed = placeOne(ctx, req, 0, minutes, windows, state)
  if (failed.ok) throw new Error(`setup is wrong: it placed at ${failed.block.start} without needing repair`)
  return { state, failed, result: attemptRepair(ctx, req, 0, minutes, windows, state, failed, {}, depth) }
}

describe('displacing a flexible block', () => {
  // The 10th is walled off except 16:00–17:00, which a flexible workout holds.
  // The 11th is wide open, so the workout has somewhere to go.
  const busy = [wall('2026-08-10'), block('אימון', '2026-08-10T16:00:00', '2026-08-10T17:00:00', 'flexible')]

  it('clears the slot and reports the move', () => {
    const { result } = repairAfterFailure(ctxOf(busy))
    expect(result).not.toBeNull()
    expect(result!.block.start).toBe('2026-08-10T16:00:00')
    expect(result!.displacements).toHaveLength(1)
    expect(result!.displacements[0]).toMatchObject({
      eventId: 'אימון',
      from: '2026-08-10T16:00:00',
      to: '2026-08-11T09:00:00',
    })
  })

  it('justifies the new home with real reasons rather than a bare assertion', () => {
    const { result } = repairAfterFailure(ctxOf(busy))
    expect(result!.displacements[0].reasons.length).toBeGreaterThan(0)
    expect(result!.displacements[0].reasons.map(r => r.code)).toContain('PEAK_MATCH')
  })

  it('leaves the displaced block in the returned world at its new time, not both times', () => {
    const { result } = repairAfterFailure(ctxOf(busy))
    const moved = result!.state.busy.filter(b => b.id === 'אימון')
    expect(moved).toHaveLength(1)
    expect(moved[0].start).toBe('2026-08-11T09:00:00')
  })

  it('never leaves a repair pin behind in the world it hands back', () => {
    const { result } = repairAfterFailure(ctxOf(busy))
    expect(result!.state.busy.some(b => b.id.startsWith('__repair_target__'))).toBe(false)
  })
})

describe('what repair refuses to touch', () => {
  it('never moves a fixed block, however badly the slot is wanted', () => {
    const busy = [wall('2026-08-10'), block('בחינה', '2026-08-10T16:00:00', '2026-08-10T17:00:00', 'fixed')]
    expect(repairAfterFailure(ctxOf(busy)).result).toBeNull()
  })

  it('never moves an ask_first block — that is a question, not a decision', () => {
    const busy = [wall('2026-08-10'), block('ארוחה', '2026-08-10T16:00:00', '2026-08-10T17:00:00', 'ask_first')]
    expect(repairAfterFailure(ctxOf(busy)).result).toBeNull()
  })

  it('never moves an all-day block, which has no other home inside its own day', () => {
    const busy = [
      wall('2026-08-10'),
      { ...block('חופש', '2026-08-10T00:00:00', '2026-08-11T00:00:00', 'flexible'), isAllDay: true },
    ]
    expect(repairAfterFailure(ctxOf(busy)).result).toBeNull()
  })
})

describe('the depth bound', () => {
  /**
   * A chain that needs exactly two levels: the request needs A's slot, A only
   * fits where B sits, and B fits in a 30-minute hole on the 12th.
   */
  const chain = [
    wall('2026-08-10'),
    block('A', '2026-08-10T16:00:00', '2026-08-10T17:00:00', 'flexible'),
    wall('2026-08-11'),
    block('B', '2026-08-11T16:00:00', '2026-08-11T16:30:00', 'flexible'),
    wall('2026-08-12', '09:00:00', '16:30:00'),
  ]

  it('solves a two-level chain and reports both moves', () => {
    const { result } = repairAfterFailure(ctxOf(chain))
    expect(result).not.toBeNull()
    expect(result!.block.start).toBe('2026-08-10T16:00:00')
    expect(result!.displacements.map(d => d.eventId).sort()).toEqual(['A', 'B'])
  })

  it('refuses the same chain when only one level is allowed', () => {
    expect(repairAfterFailure(ctxOf(chain), 1).result).toBeNull()
  })

  it('does nothing at all at depth zero', () => {
    expect(repairAfterFailure(ctxOf(chain), 0).result).toBeNull()
  })
})

describe('termination', () => {
  it('gives up on a mutually-blocking pair instead of swapping them forever', () => {
    // A can only go where B is; B can only go where A was. Two guarantees stop
    // this: depth runs out, and a block already displaced is frozen thereafter.
    const deadlock = [
      wall('2026-08-10'),
      block('A', '2026-08-10T16:00:00', '2026-08-10T17:00:00', 'flexible'),
      wall('2026-08-11'),
      block('B', '2026-08-11T16:00:00', '2026-08-11T17:00:00', 'flexible'),
      wall('2026-08-12', '09:00:00', '17:00:00'),
    ]
    expect(repairAfterFailure(ctxOf(deadlock)).result).toBeNull()
  })

  it('leaves the caller\'s state untouched when it fails', () => {
    const busy = [wall('2026-08-10'), block('בחינה', '2026-08-10T16:00:00', '2026-08-10T17:00:00', 'fixed')]
    const ctx = ctxOf(busy)
    const { state, result } = repairAfterFailure(ctx)
    expect(result).toBeNull()
    expect(state.busy).toEqual(busy)
  })
})
