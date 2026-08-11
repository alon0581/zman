import { describe, it, expect } from 'vitest'
import { CalendarEvent } from '@/types'
import { orderRequests, planSchedule, splitSessions } from './plan'
import { MIN_ACCEPTABLE_SCORE } from './score'
import { overlaps, toBusyBlocks } from './timeline'
import {
  BusyBlock, MethodRules, Mobility, PlacedBlock, PlacementRequest, PlanOutcome,
  SchedulingContext, SchedulingProfile,
} from './types'

const profile: SchedulingProfile = {
  timezone: 'Asia/Jerusalem',
  dayStartHour: 9,
  dayEndHour: 17,
  peakStartHour: 9,
  peakEndHour: 12,
  bufferMinutes: 0,
  weekendDays: [5, 6],
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

/** Mon 10 – Thu 13 Aug 2026: four weekdays, no weekend in the way. */
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

function block(id: string, start: string, end: string, mobility: Mobility): BusyBlock {
  return { id, title: id, start, end, mobility, createdBy: mobility === 'flexible' ? 'ai' : 'user', isAllDay: false }
}

function wall(day: string, from = '09:00:00', to = '17:00:00'): BusyBlock {
  return block(`wall-${day}`, `${day}T${from}`, `${day}T${to}`, 'fixed')
}

function requestOf(over: Partial<PlacementRequest> = {}): PlacementRequest {
  return { ref: { kind: 'task' }, title: 'לימוד', ...over }
}

function blocksOf(outcome: PlanOutcome): PlacedBlock[] {
  return outcome.status === 'blocked' ? [] : outcome.blocks
}

function days(blocks: PlacedBlock[]): string[] {
  return blocks.map(b => b.start.slice(0, 10))
}

describe('splitting work into sessions', () => {
  it('derives the session length from total and count', () => {
    expect(splitSessions(requestOf({ totalMinutes: 180, sessionCount: 3 }), rules)).toEqual([60, 60, 60])
  })

  it('keeps the method session length when only the total is known, and lets the count follow', () => {
    expect(splitSessions(requestOf({ totalMinutes: 150 }), rules)).toEqual([60, 60, 30])
  })

  it('keeps every session inside the method block bounds, whatever was asked for', () => {
    const tight = { ...rules, minBlock: 25, maxBlock: 25, sessionMinutes: 25 }
    expect(splitSessions(requestOf({ totalMinutes: 100 }), tight)).toEqual([25, 25, 25, 25])
  })

  it('is a single session by default', () => {
    expect(splitSessions(requestOf(), rules)).toEqual([60])
  })
})

describe('ordering', () => {
  it('puts the tightest deadline first, then the longest job', () => {
    const requests = [
      requestOf({ title: 'no deadline' }),
      requestOf({ title: 'thursday', deadline: '2026-08-13T17:00:00' }),
      requestOf({ title: 'tuesday', deadline: '2026-08-11T17:00:00' }),
      requestOf({ title: 'tuesday too', deadline: '2026-08-11T17:00:00', totalMinutes: 240 }),
    ]
    expect(orderRequests(requests, rules).map(i => requests[i].title))
      .toEqual(['tuesday too', 'tuesday', 'thursday', 'no deadline'])
  })

  it('lets eat_the_frog override the deadline order with energy', () => {
    const requests = [
      requestOf({ title: 'easy', energy: 'low', deadline: '2026-08-10T17:00:00' }),
      requestOf({ title: 'hard', energy: 'high', deadline: '2026-08-13T17:00:00' }),
    ]
    expect(orderRequests(requests, { ...rules, hardestFirst: true }).map(i => requests[i].title))
      .toEqual(['hard', 'easy'])
  })

  it('gives the frog the earliest viable slot, and says why', () => {
    const outcome = planSchedule(ctxOf({ rules: { ...rules, hardestFirst: true } }), [
      requestOf({ title: 'קל', energy: 'low' }),
      requestOf({ title: 'קשה', energy: 'high' }),
    ])
    const frog = blocksOf(outcome).find(b => b.title === 'קשה')!
    expect(frog.start).toBe('2026-08-10T09:00:00')
    expect(frog.reasons.map(r => r.code)).toContain('FROG_FIRST')
  })
})

describe('multi-session work', () => {
  it('spreads sessions over separate days instead of stacking them', () => {
    const outcome = planSchedule(ctxOf(), [requestOf({ totalMinutes: 180, sessionCount: 3 })])
    const placed = blocksOf(outcome)
    expect(outcome.status).toBe('ok')
    expect(placed).toHaveLength(3)
    expect(new Set(days(placed)).size).toBe(3)
  })

  it('re-scores after each session, so the spread reason cites the sessions already placed', () => {
    const outcome = planSchedule(ctxOf(), [requestOf({ totalMinutes: 120, sessionCount: 2 })])
    const [, second] = blocksOf(outcome)
    expect(second.reasons.find(r => r.code === 'SPREAD')?.weight).toBeGreaterThan(0)
  })

  it('never places two blocks on top of each other', () => {
    const outcome = planSchedule(ctxOf(), [
      requestOf({ title: 'א', totalMinutes: 180, sessionCount: 3 }),
      requestOf({ title: 'ב', totalMinutes: 120, sessionCount: 2 }),
      requestOf({ title: 'ג' }),
    ])
    const placed = blocksOf(outcome)
    for (const a of placed) {
      for (const b of placed) {
        if (a === b) continue
        expect(overlaps(a, b)).toBe(false)
      }
    }
  })
})

describe('recurrence', () => {
  const longHorizon = { from: '2026-08-10T00:00:00', to: '2026-08-31T00:00:00' }

  it('keeps the series on the same weekday at the same time', () => {
    const outcome = planSchedule(
      ctxOf({ horizon: longHorizon }),
      [requestOf({ recurrence: { frequency: 'weekly', count: 3 } })]
    )
    expect(blocksOf(outcome).map(b => b.start)).toEqual([
      '2026-08-10T09:00:00',
      '2026-08-17T09:00:00',
      '2026-08-24T09:00:00',
    ])
  })

  it('conflict-checks EVERY instance, not just the first', () => {
    // The old create_event skipped conflict checks for recurring events outright.
    const busy = [block('בחינה', '2026-08-17T09:00:00', '2026-08-17T10:00:00', 'fixed')]
    const outcome = planSchedule(ctxOf({ horizon: longHorizon, busy }), [
      requestOf({ recurrence: { frequency: 'weekly', count: 3 } }),
    ])
    const placed = blocksOf(outcome)
    expect(placed).toHaveLength(3)
    // Week two moved off the anchor hour rather than double-booking it.
    expect(placed[1].start.slice(0, 10)).toBe('2026-08-17')
    expect(placed[1].start).not.toBe('2026-08-17T09:00:00')
    expect(placed.some(b => overlaps(b, busy[0]))).toBe(false)
  })

  it('reports the instance that could not be placed instead of dropping it', () => {
    const busy = [wall('2026-08-24')]
    const outcome = planSchedule(ctxOf({ horizon: longHorizon, busy }), [
      requestOf({ recurrence: { frequency: 'weekly', count: 3 } }),
    ])
    expect(outcome.status).toBe('partial')
    if (outcome.status !== 'partial') return
    expect(outcome.blocks).toHaveLength(2)
    expect(outcome.unplaced).toHaveLength(1)
    expect(outcome.unplaced[0]).toMatchObject({ code: 'blocked_by_fixed', placedCount: 2 })
    expect(outcome.unplaced[0].detail).toMatchObject({ instance: 2, day: '2026-08-24' })
  })

  it('strides fortnightly and monthly series correctly', () => {
    const fortnightly = planSchedule(ctxOf({ horizon: longHorizon }), [
      requestOf({ recurrence: { frequency: 'biweekly', count: 2 } }),
    ])
    expect(days(blocksOf(fortnightly))).toEqual(['2026-08-10', '2026-08-24'])

    // 10 Oct 2026 is a Saturday, so the third monthly instance has no window and
    // is reported rather than silently slid onto a different date.
    const monthly = planSchedule(
      ctxOf({ horizon: { from: '2026-08-10T00:00:00', to: '2026-10-31T00:00:00' } }),
      [requestOf({ recurrence: { frequency: 'monthly', count: 3 } })]
    )
    expect(days(blocksOf(monthly))).toEqual(['2026-08-10', '2026-09-10'])
    expect(monthly.status).toBe('partial')
    if (monthly.status !== 'partial') return
    expect(monthly.unplaced[0].detail).toMatchObject({ day: '2026-10-10' })
    expect(monthly.relaxations.map(r => r.code)).toContain('use_weekend')
  })

  it('anchors early enough that the whole series fits inside the horizon', () => {
    const outcome = planSchedule(ctxOf({ horizon: longHorizon }), [
      requestOf({ recurrence: { frequency: 'weekly', count: 3 } }),
    ])
    expect(days(blocksOf(outcome))[0]).toBe('2026-08-10')
    expect(outcome.status).toBe('ok')
  })

  it('stops at the horizon rather than inventing instances beyond it', () => {
    const outcome = planSchedule(ctxOf(), [requestOf({ recurrence: { frequency: 'weekly', count: 5 } })])
    expect(blocksOf(outcome)).toHaveLength(1)
  })
})

describe('all-day events, end to end', () => {
  it('will not schedule inside one', () => {
    const busy = toBusyBlocks([{
      id: 'a', user_id: 'u', title: 'מילואים',
      start_time: '2026-08-10T00:00:00', end_time: '2026-08-11T23:59:59',
      is_all_day: true, source: 'zman', created_by: 'user', status: 'confirmed',
      created_at: '2026-08-01T00:00:00',
    } as CalendarEvent])
    const outcome = planSchedule(ctxOf({ busy }), [requestOf()])
    expect(blocksOf(outcome)[0].start).toBe('2026-08-12T09:00:00')
  })
})

describe('repair, seen from the outside', () => {
  it('reports every displacement it made', () => {
    const busy = [
      block('wall', '2026-08-10T09:00:00', '2026-08-10T16:00:00', 'fixed'),
      block('אימון', '2026-08-10T16:00:00', '2026-08-10T17:00:00', 'flexible'),
    ]
    const outcome = planSchedule(ctxOf({ busy }), [requestOf({ deadline: '2026-08-10T17:00:00' })])
    expect(outcome.status).toBe('ok')
    if (outcome.status !== 'ok') return
    expect(outcome.blocks[0].start).toBe('2026-08-10T16:00:00')
    expect(outcome.displacements).toHaveLength(1)
    expect(outcome.displacements[0].eventId).toBe('אימון')
  })
})

describe('the quality floor, end to end', () => {
  const oneDay = { from: '2026-08-10T00:00:00', to: '2026-08-11T00:00:00' }
  const roomy = { ...rules, maxSessionsPerDay: 10, dailyCapMinutes: 600 }

  it('stops stacking a day once the slots left are worse than nothing', () => {
    const outcome = planSchedule(
      ctxOf({ horizon: oneDay, rules: roomy }),
      [requestOf({ totalMinutes: 6 * 60, sessionCount: 6 })]
    )
    expect(outcome.status).toBe('partial')
    if (outcome.status !== 'partial') return
    expect(outcome.unplaced[0].code).toBe('below_quality_floor')
    // Nothing it did place is a block the user would delete on sight.
    for (const b of outcome.blocks) expect(b.score).toBeGreaterThanOrEqual(MIN_ACCEPTABLE_SCORE)
    expect(outcome.blocks.length).toBeGreaterThan(0)
  })

  it('explains the refusal with relaxations when one would actually help', () => {
    // Thu 13th plus the weekend. The floor stops the Thursday stack, and the two
    // sessions it turned down are exactly what opening Fri–Sat would absorb.
    const outcome = planSchedule(
      ctxOf({
        now: '2026-08-13T08:00:00',
        horizon: { from: '2026-08-13T00:00:00', to: '2026-08-16T00:00:00' },
        rules: roomy,
      }),
      [requestOf({ totalMinutes: 6 * 60, sessionCount: 6 })]
    )
    expect(outcome.status).toBe('partial')
    if (outcome.status !== 'partial') return
    expect(outcome.unplaced[0].code).toBe('below_quality_floor')
    expect(outcome.relaxations.find(r => r.code === 'use_weekend'))
      .toEqual({ code: 'use_weekend', delta: 'Fri–Sat', wouldPlace: 6 - outcome.blocks.length, requestIndex: 0 })
  })

  it('offers nothing when the real constraint is "one day is not enough days"', () => {
    // Honest emptiness, not a missing feature: no relaxation in the contract
    // says "give me more days", and inventing a payoff here would be a guess.
    const outcome = planSchedule(
      ctxOf({ horizon: oneDay, rules: roomy }),
      [requestOf({ totalMinutes: 6 * 60, sessionCount: 6 })]
    )
    if (outcome.status !== 'partial') return
    expect(outcome.relaxations).toEqual([])
  })
})

describe('the engine never displaces its own blocks', () => {
  it('leaves an earlier request where it put it, and reports the later one unplaced', () => {
    // Only 16:00–17:00 is free, and the first request takes it. Displacing that
    // block would have left it listed in `blocks` at a time the engine had just
    // vacated — a plan contradicting itself.
    const outcome = planSchedule(
      ctxOf({
        horizon: { from: '2026-08-10T00:00:00', to: '2026-08-11T00:00:00' },
        busy: [block('wall', '2026-08-10T09:00:00', '2026-08-10T16:00:00', 'fixed')],
      }),
      [requestOf({ title: 'א' }), requestOf({ title: 'ב' })]
    )
    expect(outcome.status).toBe('partial')
    if (outcome.status !== 'partial') return
    expect(outcome.blocks).toHaveLength(1)
    expect(outcome.blocks[0]).toMatchObject({ title: 'א', start: '2026-08-10T16:00:00' })
    expect(outcome.displacements).toEqual([])
    expect(outcome.unplaced[0].requestIndex).toBe(1)
  })
})

describe('relaxations name the request they would help', () => {
  it('reports a payoff per request, not one anonymous total', () => {
    // Friday and Saturday only: the engine keeps the weekend clear, so both
    // requests are stuck for the same reason and both would be freed by it.
    const outcome = planSchedule(
      ctxOf({ now: '2026-08-14T07:00:00', horizon: { from: '2026-08-14T00:00:00', to: '2026-08-16T00:00:00' } }),
      [requestOf({ title: 'א' }), requestOf({ title: 'ב' })]
    )
    expect(outcome.status).toBe('blocked')
    if (outcome.status !== 'blocked') return
    const weekend = outcome.relaxations.filter(r => r.code === 'use_weekend')
    expect(weekend.map(r => r.requestIndex).sort()).toEqual([0, 1])
    expect(weekend.every(r => r.wouldPlace === 1)).toBe(true)
  })

  it('skips a relaxation that provably changes nothing instead of probing it', () => {
    // Buffer is already zero, so "drop the buffer" is not an offer worth making.
    const busy = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13'].map(d => wall(d))
    const outcome = planSchedule(ctxOf({ busy }), [requestOf()])
    if (outcome.status !== 'blocked') return
    expect(outcome.relaxations.map(r => r.code)).not.toContain('drop_buffer')
  })
})

describe('when it cannot be done', () => {
  it('reports blocked, with a code, when nothing landed at all', () => {
    const busy = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13'].map(d => wall(d))
    const outcome = planSchedule(ctxOf({ busy }), [requestOf()])
    expect(outcome.status).toBe('blocked')
    if (outcome.status !== 'blocked') return
    expect(outcome.unplaced[0].code).toBe('blocked_by_fixed')
  })

  it('reports partial when some sessions landed and some did not', () => {
    const oneDay = { from: '2026-08-10T00:00:00', to: '2026-08-11T00:00:00' }
    const outcome = planSchedule(
      ctxOf({ horizon: oneDay, rules: { ...rules, maxSessionsPerDay: 2 } }),
      [requestOf({ totalMinutes: 180, sessionCount: 3 })]
    )
    expect(outcome.status).toBe('partial')
    if (outcome.status !== 'partial') return
    expect(outcome.blocks).toHaveLength(2)
    expect(outcome.unplaced[0]).toMatchObject({ code: 'day_cap_reached', placedCount: 2 })
  })
})

describe('relaxations are computed, never guessed', () => {
  it('offers the weekend when the horizon holds nothing else', () => {
    // Fri 14th and Sat 15th only — the engine keeps those clear by default.
    const outcome = planSchedule(
      ctxOf({ now: '2026-08-14T07:00:00', horizon: { from: '2026-08-14T00:00:00', to: '2026-08-16T00:00:00' } }),
      [requestOf()]
    )
    expect(outcome.status).toBe('blocked')
    if (outcome.status !== 'blocked') return
    expect(outcome.relaxations).toContainEqual({ code: 'use_weekend', delta: 'Fri–Sat', wouldPlace: 1, requestIndex: 0 })
  })

  it('offers a shorter session when the only hole is smaller than one', () => {
    const outcome = planSchedule(
      ctxOf({
        horizon: { from: '2026-08-10T00:00:00', to: '2026-08-11T00:00:00' },
        busy: [block('wall', '2026-08-10T09:45:00', '2026-08-10T17:00:00', 'fixed')],
      }),
      [requestOf()]
    )
    expect(outcome.status).toBe('blocked')
    if (outcome.status !== 'blocked') return
    expect(outcome.relaxations.find(r => r.code === 'shorten_sessions'))
      .toEqual({ code: 'shorten_sessions', delta: '60 → 45', wouldPlace: 1, requestIndex: 0 })
  })

  it('offers to drop the buffer when the buffer is what is in the way', () => {
    const outcome = planSchedule(
      ctxOf({
        profile: { ...profile, bufferMinutes: 60 },
        horizon: { from: '2026-08-10T00:00:00', to: '2026-08-11T00:00:00' },
        busy: [block('wall', '2026-08-10T10:00:00', '2026-08-10T16:00:00', 'fixed')],
      }),
      [requestOf()]
    )
    expect(outcome.status).toBe('blocked')
    if (outcome.status !== 'blocked') return
    expect(outcome.relaxations.find(r => r.code === 'drop_buffer'))
      .toEqual({ code: 'drop_buffer', delta: '60 → 0', wouldPlace: 1, requestIndex: 0 })
  })

  it('counts what each relaxation would really place, session by session', () => {
    const outcome = planSchedule(
      ctxOf({
        horizon: { from: '2026-08-10T00:00:00', to: '2026-08-12T00:00:00' },
        busy: [
          block('a1', '2026-08-10T09:00:00', '2026-08-10T17:00:00', 'ask_first'),
          block('a2', '2026-08-11T09:00:00', '2026-08-11T17:00:00', 'ask_first'),
        ],
      }),
      [requestOf({ totalMinutes: 120, sessionCount: 2 })]
    )
    expect(outcome.status).toBe('blocked')
    if (outcome.status !== 'blocked') return
    // Both sessions become placeable, one per day — not "some", not "all six".
    expect(outcome.relaxations.find(r => r.code === 'move_ask_first'))
      .toEqual({ code: 'move_ask_first', delta: '2', wouldPlace: 2, requestIndex: 0 })
  })

  it('offers nothing when nothing would help', () => {
    const busy = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13'].map(d => wall(d, '00:00:00', '23:59:59'))
    const outcome = planSchedule(ctxOf({ busy }), [requestOf()])
    expect(outcome.status).toBe('blocked')
    if (outcome.status !== 'blocked') return
    expect(outcome.relaxations).toEqual([])
  })
})

describe('determinism', () => {
  it('produces byte-identical plans from the same context, twice', () => {
    const ctx = ctxOf({
      busy: [
        block('פגישה', '2026-08-11T10:00:00', '2026-08-11T11:30:00', 'ask_first'),
        block('אימון', '2026-08-12T09:00:00', '2026-08-12T10:00:00', 'flexible'),
      ],
      priors: { hourWeight: { 9: -1 }, dayWeight: { Tue: 0.5 } },
    })
    const requests = [
      requestOf({ title: 'ב', totalMinutes: 180, sessionCount: 3, energy: 'high' }),
      requestOf({ title: 'א', deadline: '2026-08-12T17:00:00' }),
      requestOf({ title: 'ג', recurrence: { frequency: 'weekly', count: 2 } }),
    ]
    expect(JSON.stringify(planSchedule(ctx, requests))).toBe(JSON.stringify(planSchedule(ctx, requests)))
  })

  it('does not mutate the context it was handed', () => {
    const ctx = ctxOf({ busy: [block('אימון', '2026-08-10T09:00:00', '2026-08-10T10:00:00', 'flexible')] })
    const before = JSON.stringify(ctx)
    planSchedule(ctx, [requestOf({ totalMinutes: 120, sessionCount: 2 })])
    expect(JSON.stringify(ctx)).toBe(before)
  })
})

describe('hard windows', () => {
  it('override the profile day entirely — "only in the evening" means only', () => {
    const outcome = planSchedule(ctxOf(), [requestOf({
      hardWindows: [{ day: '2026-08-12', start: '2026-08-12T20:00:00', end: '2026-08-12T22:00:00' }],
    })])
    expect(blocksOf(outcome)[0].start).toBe('2026-08-12T20:00:00')
  })
})
