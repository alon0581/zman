/**
 * capacity.test.ts
 *
 * The reason this module exists at all is that a board must never disagree with
 * the calendar, so the headline test here is the agreement test: the number the
 * badge shows IS the number `planSchedule` actually places, asserted by calling
 * both rather than by re-deriving it.
 *
 * The second theme is why the probe is batched. Run per-project, two projects
 * competing for the same free Tuesday each get a fresh placement state and BOTH
 * come back green, while together they do not fit. That is a silent double-book,
 * and it is the exact class of bug the engine was written to make impossible.
 */

import { describe, expect, it } from 'vitest'
import { CAPACITY_SLACK, MAX_PROBED_PROJECTS, probeCapacity, ProjectProbeInput } from './capacity'
import { planSchedule } from '@/lib/scheduling/plan'
import { BusyBlock, MethodRules, SchedulingContext, SchedulingProfile } from '@/lib/scheduling/types'

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

/** Mon 10 - Thu 13 Aug 2026. */
const HORIZON = { from: '2026-08-10T00:00:00', to: '2026-08-14T00:00:00' }

function ctxOf(busy: BusyBlock[] = []): SchedulingContext {
  return {
    now: '2026-08-10T08:00:00',
    horizon: HORIZON,
    profile,
    method: { primary: 'time_blocking', secondary: [] },
    rules,
    busy,
    priors: { hourWeight: {}, dayWeight: {} },
  }
}

function input(over: Partial<ProjectProbeInput> & Pick<ProjectProbeInput, 'projectId'>): ProjectProbeInput {
  return {
    title: over.projectId,
    remainingMinutes: 120,
    deadline: '2026-08-13T17:00:00',
    category: 'study',
    ...over,
  }
}

/** One weekday walled off completely. */
function wall(day: string): BusyBlock {
  return {
    id: `wall-${day}`, title: 'wall',
    start: `${day}T09:00:00`, end: `${day}T17:00:00`,
    mobility: 'fixed', createdBy: 'user', isAllDay: false,
  }
}

describe('the badge agrees with the planner', () => {
  it('reports exactly the minutes planSchedule actually places', () => {
    const ctx = ctxOf()
    const probe = probeCapacity(ctx, [input({ projectId: 'p1', remainingMinutes: 180 })], true)

    // The probe pads the ask by CAPACITY_SLACK, so the equivalent direct call must
    // ask for the same padded amount — otherwise this asserts against a different
    // question than the one the probe posed.
    const direct = planSchedule(ctx, [{
      ref: { kind: 'project', id: 'p1' },
      title: 'p1',
      totalMinutes: Math.ceil(180 * CAPACITY_SLACK),
      deadline: '2026-08-13T17:00:00',
      category: 'study',
      mobility: 'flexible',
    }])
    const directMinutes = ('blocks' in direct ? direct.blocks : [])
      .reduce((s, b) => s + (Date.parse(`${b.end}Z`) - Date.parse(`${b.start}Z`)) / 60000, 0)

    expect(probe.get('p1')!.placedMinutes).toBe(directMinutes)
  })

  it('reports ok and a last end when everything fits', () => {
    const result = probeCapacity(ctxOf(), [input({ projectId: 'p1' })], true).get('p1')!
    expect(result.status).toBe('ok')
    expect(result.lastEnd).toBeTruthy()
  })

  it('never claims more capacity than it placed, even when blocked', () => {
    const busy = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13'].map(wall)
    const result = probeCapacity(ctxOf(busy), [input({ projectId: 'p1' })], true).get('p1')!

    expect(result.status).toBe('blocked')
    expect(result.placedMinutes).toBe(0)
  })

  it('explains a failure with the engine\'s own Hebrew sentence, not an invented one', () => {
    const busy = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13'].map(wall)
    const result = probeCapacity(ctxOf(busy), [input({ projectId: 'p1' })], true).get('p1')!

    expect(result.reason).toBeTruthy()
    expect(result.reason).toMatch(/[֐-׿]/)
  })
})

describe('batching — two projects cannot both claim the same hours', () => {
  it('does not report both projects as fitting when together they exceed the free time', () => {
    // Only Monday is open, and only 09:00-12:00 of it: 180 free minutes total.
    // Each project wants 180. One can fit; both cannot.
    const busy: BusyBlock[] = [
      {
        id: 'mon-pm', title: 'blocked', start: '2026-08-10T12:00:00', end: '2026-08-10T17:00:00',
        mobility: 'fixed', createdBy: 'user', isAllDay: false,
      },
      wall('2026-08-11'), wall('2026-08-12'), wall('2026-08-13'),
    ]
    const probe = probeCapacity(ctxOf(busy), [
      input({ projectId: 'p1', remainingMinutes: 180, deadline: '2026-08-10T17:00:00' }),
      input({ projectId: 'p2', remainingMinutes: 180, deadline: '2026-08-11T17:00:00' }),
    ], true)

    const both = [probe.get('p1')!, probe.get('p2')!]
    const totalPlaced = both.reduce((s, r) => s + r.placedMinutes, 0)

    // The engine cannot have placed more than actually existed.
    expect(totalPlaced).toBeLessThanOrEqual(180)
    // And at least one of them must be honest about not fitting.
    expect(both.some(r => r.status !== 'ok')).toBe(true)
  })

  it('lets the earlier deadline claim the contested capacity first', () => {
    const busy: BusyBlock[] = [
      {
        id: 'mon-pm', title: 'blocked', start: '2026-08-10T12:00:00', end: '2026-08-10T17:00:00',
        mobility: 'fixed', createdBy: 'user', isAllDay: false,
      },
      wall('2026-08-11'), wall('2026-08-12'), wall('2026-08-13'),
    ]
    const probe = probeCapacity(ctxOf(busy), [
      input({ projectId: 'later', remainingMinutes: 180, deadline: '2026-08-11T17:00:00' }),
      input({ projectId: 'sooner', remainingMinutes: 180, deadline: '2026-08-10T12:00:00' }),
    ], true)

    expect(probe.get('sooner')!.placedMinutes).toBeGreaterThan(probe.get('later')!.placedMinutes)
  })
})

describe('bounds and edges', () => {
  it('skips projects with no work left rather than probing them', () => {
    const probe = probeCapacity(ctxOf(), [input({ projectId: 'p1', remainingMinutes: 0 })], true)
    expect(probe.has('p1')).toBe(false)
  })

  it('returns an empty map for an empty batch instead of running the engine', () => {
    expect(probeCapacity(ctxOf(), [], true).size).toBe(0)
  })

  it('marks overflow beyond the cap as unscored rather than silently omitting it', () => {
    const many = Array.from({ length: MAX_PROBED_PROJECTS + 3 }, (_, i) =>
      input({ projectId: `p${i}`, deadline: `2026-08-1${(i % 3) + 1}T17:00:00` }))
    const probe = probeCapacity(ctxOf(), many, true)

    // Everything is accounted for; nothing quietly disappears.
    expect(probe.size).toBe(many.length)
    const unscored = [...probe.values()].filter(r => r.status === 'blocked' && r.placedMinutes === 0)
    expect(unscored.length).toBeGreaterThanOrEqual(3)
  })

  it('is deterministic across runs', () => {
    const inputs = [input({ projectId: 'a' }), input({ projectId: 'b', deadline: '2026-08-12T17:00:00' })]
    const first = probeCapacity(ctxOf(), inputs, true)
    const second = probeCapacity(ctxOf(), inputs, true)

    expect([...first.entries()]).toEqual([...second.entries()])
  })
})
