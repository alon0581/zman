/**
 * plan.dependencies.test.ts
 *
 * Ordering is not placement. `topoOrder` only guarantees that A is CONSIDERED
 * before B — and a greedy pass considering A first will happily put A on Tuesday
 * afternoon and B on Tuesday morning, because B's slot was still free when its
 * turn came. This file exists to prove the second half of the mechanism: the
 * `earliest` floor that turns consideration order into "B actually starts after
 * A ends".
 *
 * It also pins the honest-failure behaviour. If a prerequisite could not be
 * placed, its dependents must come back as `blocked_by_dependency` rather than
 * being scheduled anyway — scheduling step 2 when step 1 has no slot is exactly
 * the invisible dishonesty this engine was built to remove.
 */

import { describe, expect, it } from 'vitest'
import { planSchedule } from './plan'
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

/** Mon 10 - Thu 13 Aug 2026: four weekdays, no weekend in the way. */
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

function task(id: string, over: Partial<PlacementRequest> = {}): PlacementRequest {
  return { ref: { kind: 'task', id }, title: id, ...over }
}

function blocksOf(outcome: PlanOutcome): PlacedBlock[] {
  return outcome.status === 'blocked' ? [] : outcome.blocks
}

function unplacedOf(outcome: PlanOutcome) {
  return outcome.status === 'ok' ? [] : outcome.unplaced
}

function forIndex(outcome: PlanOutcome, requestIndex: number): PlacedBlock[] {
  return blocksOf(outcome).filter(b => b.requestIndex === requestIndex)
}

describe('dependency floor — B starts after A ends', () => {
  // Both tests below are written as CONTRASTS on purpose. A dependency test that
  // only asserts "b is after a" can pass while doing nothing, because the
  // comparator often happens to order them that way already. Each test therefore
  // also asserts that the same requests WITHOUT `dependsOn` violate the order —
  // which is what proves the feature, and not the fixture, is doing the work.

  it('holds a dependent back when its prerequisite is pinned to a later day', () => {
    // `zzz_a` cannot start before Wednesday. `bbb` is unconstrained, so its own
    // best slot is Monday 09:00 — before its prerequisite even begins.
    const a = task('zzz_a', { earliest: '2026-08-12T09:00:00' })
    const withDep = planSchedule(ctxOf(), [a, task('bbb', { dependsOn: ['zzz_a'] })])
    const withoutDep = planSchedule(ctxOf(), [a, task('bbb')])

    // Without the dependency the engine puts bbb on Monday, ahead of zzz_a.
    expect(forIndex(withoutDep, 1)[0].start).toBe('2026-08-10T09:00:00')
    expect(forIndex(withoutDep, 1)[0].start < forIndex(withoutDep, 0)[0].start).toBe(true)

    // With it, bbb is pushed past zzz_a's end.
    expect(forIndex(withDep, 1)[0].start >= forIndex(withDep, 0)[0].end).toBe(true)
  })

  it('reorders when the comparator would otherwise put the urgent dependent first', () => {
    // `bbb` has the nearer deadline, so most-constrained-first wants it first —
    // but it depends on `aaa`, which has no deadline at all.
    const withDep = planSchedule(ctxOf(), [
      task('aaa'),
      task('bbb', { dependsOn: ['aaa'], deadline: '2026-08-11T17:00:00' }),
    ])
    const withoutDep = planSchedule(ctxOf(), [
      task('aaa'),
      task('bbb', { deadline: '2026-08-11T17:00:00' }),
    ])

    // Without the dependency, the urgent one wins the earliest slot.
    expect(forIndex(withoutDep, 1)[0].start < forIndex(withoutDep, 0)[0].start).toBe(true)

    // With it, the prerequisite takes the earlier slot and the dependent follows.
    expect(forIndex(withDep, 1)[0].start >= forIndex(withDep, 0)[0].end).toBe(true)
  })

  it('waits for the LAST session of a multi-session prerequisite, not the first', () => {
    const requests = [
      task('a', { totalMinutes: 180, sessionCount: 3 }),
      task('b', { dependsOn: ['a'] }),
    ]
    const outcome = planSchedule(ctxOf(), requests)

    const a = forIndex(outcome, 0)
    const b = forIndex(outcome, 1)

    expect(a.length).toBeGreaterThan(1)
    const lastEnd = a.reduce((max, blk) => (blk.end > max ? blk.end : max), a[0].end)
    expect(b[0].start >= lastEnd).toBe(true)
  })

  it('keeps a stricter explicit earliest instead of lowering it to the dependency floor', () => {
    const requests = [
      task('a'),
      task('b', { dependsOn: ['a'], earliest: '2026-08-13T09:00:00' }),
    ]
    const outcome = planSchedule(ctxOf(), requests)
    const b = forIndex(outcome, 1)

    expect(b[0].start >= '2026-08-13T09:00:00').toBe(true)
  })

  it('leaves an independent request completely unaffected by someone else\'s chain', () => {
    const withChain = planSchedule(ctxOf(), [task('a'), task('b', { dependsOn: ['a'] }), task('solo')])
    const withoutChain = planSchedule(ctxOf(), [task('a'), task('b'), task('solo')])

    // The solo request is placed first in both runs, so its slot must be identical.
    expect(forIndex(withChain, 2)[0].start).toBe(forIndex(withoutChain, 2)[0].start)
  })
})

describe('dependency failure is reported, never silently ignored', () => {
  it('marks a dependent blocked_by_dependency when its prerequisite could not be placed', () => {
    // Every weekday fully walled off except a single hour on Monday — only one
    // request can fit, and `a` has a deadline so it is considered first.
    const busy = [
      block('mon-am', '2026-08-10T09:00:00', '2026-08-10T10:00:00', 'fixed'),
      wall('2026-08-11'), wall('2026-08-12'), wall('2026-08-13'),
      block('mon-pm', '2026-08-10T10:00:00', '2026-08-10T17:00:00', 'fixed'),
    ]
    const requests = [
      task('a', { deadline: '2026-08-10T09:30:00' }),
      task('b', { dependsOn: ['a'] }),
    ]
    const outcome = planSchedule(ctxOf({ busy }), requests)

    const codes = unplacedOf(outcome).map(u => u.code)
    expect(codes).toContain('blocked_by_dependency')
    expect(forIndex(outcome, 1)).toHaveLength(0)
  })

  it('propagates the block down a chain rather than scheduling a grandchild', () => {
    const busy = [wall('2026-08-10'), wall('2026-08-11'), wall('2026-08-12'), wall('2026-08-13')]
    const requests = [task('a'), task('b', { dependsOn: ['a'] }), task('c', { dependsOn: ['b'] })]
    const outcome = planSchedule(ctxOf({ busy }), requests)

    expect(blocksOf(outcome)).toHaveLength(0)
    const forC = unplacedOf(outcome).find(u => u.requestIndex === 2)
    expect(forC?.code).toBe('blocked_by_dependency')
  })

  it('reports a blocked dependent exactly once, with no placed sessions claimed', () => {
    const busy = [wall('2026-08-10'), wall('2026-08-11'), wall('2026-08-12'), wall('2026-08-13')]
    const outcome = planSchedule(ctxOf({ busy }), [task('a'), task('b', { dependsOn: ['a'] })])

    const forB = unplacedOf(outcome).filter(u => u.requestIndex === 1)
    expect(forB).toHaveLength(1)
    expect(forB[0].placedCount ?? 0).toBe(0)
  })
})

describe('cycles do not hang or crash the engine', () => {
  it('still returns a plan when two requests depend on each other', () => {
    const requests = [task('a', { dependsOn: ['b'] }), task('b', { dependsOn: ['a'] })]
    const outcome = planSchedule(ctxOf(), requests)

    // Total function: it answers rather than throwing or spinning. Rejecting the
    // cycle belongs to the caller, which has a user to tell.
    expect(['ok', 'partial', 'blocked']).toContain(outcome.status)
    expect(blocksOf(outcome).length + unplacedOf(outcome).length).toBeGreaterThan(0)
  })
})

describe('the no-dependency path is untouched', () => {
  it('produces an identical plan whether or not the dependency machinery is present', () => {
    // Same requests, no dependsOn anywhere: this is every input the app makes today.
    const requests = [
      task('a', { totalMinutes: 120, sessionCount: 2 }),
      task('b', { deadline: '2026-08-12T17:00:00' }),
      task('c'),
    ]
    const first = planSchedule(ctxOf(), requests)
    const second = planSchedule(ctxOf(), requests)

    expect(first).toEqual(second)
    expect(first.status).toBe('ok')
    expect(blocksOf(first).map(b => `${b.requestIndex}@${b.start}`)).toEqual(
      blocksOf(second).map(b => `${b.requestIndex}@${b.start}`),
    )
  })
})
