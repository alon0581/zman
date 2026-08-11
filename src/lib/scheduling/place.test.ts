import { describe, it, expect } from 'vitest'
import { ceilToGrid, emptyState, placeOne, PlaceResult } from './place'
import { MIN_ACCEPTABLE_SCORE } from './score'
import { toBusyBlocks } from './timeline'
import { CalendarEvent } from '@/types'
import { BusyBlock, MethodRules, PlacementRequest, SchedulingContext, SchedulingProfile } from './types'
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

/** Mon 10 Aug 2026 through Thu 13 Aug — four clean weekdays. */
const HORIZON = { from: '2026-08-10T00:00:00', to: '2026-08-14T00:00:00' }

function ctxOf(over: Partial<SchedulingContext> = {}): SchedulingContext {
  return {
    now: '2026-08-10T08:00:00',
    horizon: HORIZON,
    profile,
    method: { primary: 'time_blocking', secondary: [] },
    rules,
    busy: [],
    priors: { hourWeight: {}, dayWeight: {} },
    ...over,
  }
}

function busyOf(over: Partial<BusyBlock> = {}): BusyBlock {
  return {
    id: 'b1',
    title: 'תפוס',
    start: '2026-08-10T09:00:00',
    end: '2026-08-10T10:00:00',
    mobility: 'fixed',
    createdBy: 'user',
    isAllDay: false,
    ...over,
  }
}

const request: PlacementRequest = { ref: { kind: 'task' }, title: 'לימוד' }

function place(ctx: SchedulingContext, req: PlacementRequest = request, minutes = 60): PlaceResult {
  return placeOne(ctx, req, 0, minutes, buildDayWindows(ctx.profile, ctx.horizon), emptyState(ctx))
}

function failure(result: PlaceResult) {
  if (result.ok) throw new Error(`expected a failure, got a placement at ${result.block.start}`)
  return result
}

function placed(result: PlaceResult) {
  if (!result.ok) throw new Error(`expected a placement, got ${result.code}`)
  return result.block
}

describe('picking a slot', () => {
  it('takes the first peak-hour slot of the first available day', () => {
    const result = place(ctxOf())
    expect(placed(result).start).toBe('2026-08-10T09:00:00')
    expect(placed(result).end).toBe('2026-08-10T10:00:00')
  })

  it('snaps candidate starts to the quarter hour so plans read like plans', () => {
    expect(ceilToGrid('2026-08-10T09:07:00')).toBe('2026-08-10T09:15:00')
    expect(ceilToGrid('2026-08-10T09:15:00')).toBe('2026-08-10T09:15:00')
    expect(placed(place(ctxOf({ now: '2026-08-10T09:07:00' }))).start).toBe('2026-08-10T09:15:00')
  })

  it('never starts before now', () => {
    // Peak flattened so nothing pulls the choice to another day; the only floor
    // left in play is `now`, and the first legal quarter hour after it wins.
    const ctx = ctxOf({ now: '2026-08-10T13:20:00', profile: { ...profile, peakStartHour: 0, peakEndHour: 0 } })
    expect(placed(place(ctx)).start).toBe('2026-08-10T13:30:00')
  })

  it('prefers a peak slot tomorrow over a leftover slot today', () => {
    // Not a bug: PEAK_MATCH outweighs EARLIEST_AVAILABLE, and the reason list
    // says so out loud rather than the choice looking arbitrary.
    const block = placed(place(ctxOf({ now: '2026-08-10T13:20:00' })))
    expect(block.start).toBe('2026-08-11T09:00:00')
    expect(block.reasons[0].code).toBe('PEAK_MATCH')
  })

  it('honours `earliest` as a floor, then still picks the best slot after it', () => {
    const result = place(ctxOf(), { ...request, earliest: '2026-08-11T14:00:00' })
    expect(placed(result).start).toBe('2026-08-12T09:00:00')
  })

  it('places at an exact pinned start when asked, which is how a series keeps its time', () => {
    const ctx = ctxOf()
    const result = placeOne(ctx, request, 0, 60, buildDayWindows(profile, HORIZON), emptyState(ctx), {
      pinnedStart: '2026-08-12T14:00:00',
    })
    expect(placed(result).start).toBe('2026-08-12T14:00:00')
  })
})

describe('the hard filter', () => {
  it('will not schedule inside an all-day event — it moves to the next day', () => {
    const busy = toBusyBlocks([{
      id: 'a', user_id: 'u', title: 'מילואים',
      start_time: '2026-08-10T00:00:00', end_time: '2026-08-10T23:59:59',
      is_all_day: true, source: 'zman', created_by: 'user', status: 'confirmed',
      created_at: '2026-08-01T00:00:00',
    } as CalendarEvent])
    expect(placed(place(ctxOf({ busy }))).start).toBe('2026-08-11T09:00:00')
  })

  it('leaves the buffer clear on both sides of an existing commitment', () => {
    const ctx = ctxOf({ profile: { ...profile, bufferMinutes: 30 }, busy: [busyOf()] })
    const windows = buildDayWindows(ctx.profile, HORIZON)
    // 09:00–10:00 is taken, so a 30-minute buffer makes 10:00 illegal and 10:30
    // the first legal start. Pinning both is what proves the boundary exactly.
    expect(placeOne(ctx, request, 0, 60, windows, emptyState(ctx), { pinnedStart: '2026-08-10T10:00:00' }).ok).toBe(false)
    expect(placeOne(ctx, request, 0, 60, windows, emptyState(ctx), { pinnedStart: '2026-08-10T10:30:00' }).ok).toBe(true)
    expect(placed(place(ctx)).start >= '2026-08-10T10:30:00').toBe(true)
  })

  it('reports blocked_by_fixed when only immovable events stood in the way', () => {
    const busy = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13'].map(day => busyOf({
      id: `f-${day}`, title: 'בחינה', start: `${day}T09:00:00`, end: `${day}T17:00:00`, mobility: 'fixed',
    }))
    expect(failure(place(ctxOf({ busy }))).code).toBe('blocked_by_fixed')
  })

  it('reports needs_user_approval when an ask_first event is the only thing to move', () => {
    const busy = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13'].map(day => busyOf({
      id: `a-${day}`, title: 'ארוחה עם ההורים', start: `${day}T09:00:00`, end: `${day}T17:00:00`, mobility: 'ask_first',
    }))
    expect(failure(place(ctxOf({ busy }))).code).toBe('needs_user_approval')
  })

  it('prefers the question it can ask over the wall it cannot move', () => {
    const busy = [
      ...['2026-08-10', '2026-08-11', '2026-08-12'].map(day => busyOf({
        id: `f-${day}`, start: `${day}T09:00:00`, end: `${day}T17:00:00`, mobility: 'fixed',
      })),
      busyOf({ id: 'a', start: '2026-08-13T09:00:00', end: '2026-08-13T17:00:00', mobility: 'ask_first' }),
    ]
    expect(failure(place(ctxOf({ busy }))).code).toBe('needs_user_approval')
  })

  it('lets the move_ask_first relaxation see through an ask_first event', () => {
    const ctx = ctxOf({
      busy: ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13'].map(day => busyOf({
        id: `a-${day}`, start: `${day}T09:00:00`, end: `${day}T17:00:00`, mobility: 'ask_first',
      })),
    })
    const relaxed = placeOne(ctx, request, 0, 60, buildDayWindows(profile, HORIZON), emptyState(ctx), { ignoreAskFirst: true })
    expect(placed(relaxed).start).toBe('2026-08-10T09:00:00')
  })

  it('reports deadline_too_close when the deadline lands before any window', () => {
    const result = failure(place(ctxOf(), { ...request, deadline: '2026-08-10T08:30:00' }))
    expect(result.code).toBe('deadline_too_close')
  })

  it('reports horizon_exhausted when now has run past every window', () => {
    expect(failure(place(ctxOf({ now: '2026-08-14T00:00:00' }))).code).toBe('horizon_exhausted')
  })

  it('reports no_free_space when only unmovable flexible work occupied every slot', () => {
    // Not blocked_by_fixed and not a cap: the room is simply taken. Repair gets
    // first refusal on these; this is what is left when it cannot help.
    const busy = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13'].map(day => busyOf({
      id: `x-${day}`, title: 'בלוק עבודה', start: `${day}T09:00:00`, end: `${day}T17:00:00`, mobility: 'flexible',
    }))
    expect(failure(place(ctxOf({ busy }))).code).toBe('no_free_space')
  })

  it('reports no_window for a block no window is long enough to hold', () => {
    const ctx = ctxOf({ rules: { ...rules, maxBlock: 600 } })
    const result = failure(place(ctx, request, 600))
    expect(result.code).toBe('no_window')
  })

  it('reports no_window, naming the bound, for a block outside the method length limits', () => {
    const result = failure(place(ctxOf(), request, 200))
    expect(result.code).toBe('no_window')
    expect(result.detail).toMatchObject({ reason: 'block_length', maxBlock: 180 })
  })
})

describe('the quality floor', () => {
  /**
   * SPREAD costs WEIGHTS.SPREAD per session already on the day, so piling
   * sessions onto one day is what drives a score through the floor — exactly the
   * run of -62 / -108 / -162 blocks the acceptance-gate week produced.
   */
  function stackedState(ctx: SchedulingContext, sessions: number) {
    const state = emptyState(ctx)
    state.daysByRequest[0] = Array.from({ length: sessions }, () => '2026-08-10')
    return state
  }

  const oneDay = { from: '2026-08-10T00:00:00', to: '2026-08-11T00:00:00' }

  it('still places a mildly negative slot — "not your peak, but it fits" is a real answer', () => {
    const ctx = ctxOf({ horizon: oneDay })
    const result = placeOne(ctx, request, 0, 60, buildDayWindows(profile, oneDay), stackedState(ctx, 3))
    expect(result.ok).toBe(true)
    expect(placed(result).score).toBeLessThan(0)
    expect(placed(result).score).toBeGreaterThan(MIN_ACCEPTABLE_SCORE)
  })

  it('refuses a slot below the floor rather than handing over something to delete', () => {
    const ctx = ctxOf({ horizon: oneDay })
    const result = failure(placeOne(ctx, request, 0, 60, buildDayWindows(profile, oneDay), stackedState(ctx, 5)))
    expect(result.code).toBe('below_quality_floor')
    expect(result.detail).toMatchObject({ floor: MIN_ACCEPTABLE_SCORE })
    expect(Number(result.detail!.bestScore)).toBeLessThan(MIN_ACCEPTABLE_SCORE)
  })

  it('reports the best slot it turned down, so the refusal is auditable', () => {
    const ctx = ctxOf({ horizon: oneDay })
    const result = failure(placeOne(ctx, request, 0, 60, buildDayWindows(profile, oneDay), stackedState(ctx, 8)))
    const worse = failure(placeOne(ctx, request, 0, 60, buildDayWindows(profile, oneDay), stackedState(ctx, 12)))
    expect(Number(result.detail!.bestScore)).toBeGreaterThan(Number(worse.detail!.bestScore))
  })
})

describe('the daily cap', () => {
  const oneDay = { from: '2026-08-10T00:00:00', to: '2026-08-11T00:00:00' }

  it('counts existing commitments, because the cap is "across everything"', () => {
    const ctx = ctxOf({
      horizon: oneDay,
      rules: { ...rules, dailyCapMinutes: 120 },
      busy: [busyOf({ start: '2026-08-10T09:00:00', end: '2026-08-10T11:00:00' })],
    })
    expect(failure(place(ctx)).code).toBe('day_cap_reached')
  })

  it('lets the day fill right up to the cap and no further', () => {
    const ctx = ctxOf({
      horizon: oneDay,
      rules: { ...rules, dailyCapMinutes: 120 },
      busy: [busyOf({ start: '2026-08-10T09:00:00', end: '2026-08-10T10:00:00' })],
    })
    expect(place(ctx).ok).toBe(true)
  })

  it('enforces maxSessionsPerDay separately from the minute cap', () => {
    const ctx = ctxOf({ horizon: oneDay, rules: { ...rules, maxSessionsPerDay: 1 } })
    const state = emptyState(ctx)
    state.sessionsByDay['2026-08-10'] = 1
    const result = placeOne(ctx, request, 0, 60, buildDayWindows(profile, oneDay), state)
    expect(failure(result).code).toBe('day_cap_reached')
  })

  it('only blames the cap when the slot was otherwise free', () => {
    // A fixed wall AND a tiny cap: the wall is the more useful answer, and it is
    // the one reported, because collisions are checked before caps.
    const ctx = ctxOf({
      horizon: oneDay,
      rules: { ...rules, dailyCapMinutes: 30 },
      busy: [busyOf({ start: '2026-08-10T09:00:00', end: '2026-08-10T17:00:00', mobility: 'fixed' })],
    })
    expect(failure(place(ctx)).code).toBe('blocked_by_fixed')
  })
})

describe('determinism', () => {
  it('returns byte-identical results for the same context', () => {
    const ctx = ctxOf({ busy: [busyOf({ start: '2026-08-10T09:30:00', end: '2026-08-10T10:30:00' })] })
    expect(JSON.stringify(place(ctx))).toBe(JSON.stringify(place(ctx)))
  })

  it('breaks a score tie on the earlier start', () => {
    // Outside the peak every candidate on a day scores alike but for earliness,
    // so the tie-break is what makes the answer stable.
    const ctx = ctxOf({ profile: { ...profile, peakStartHour: 0, peakEndHour: 0 } })
    expect(placed(place(ctx)).start).toBe('2026-08-10T09:00:00')
  })
})
