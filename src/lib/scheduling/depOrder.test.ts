/**
 * depOrder.test.ts
 *
 * This file exists for one regression above all others: `topoOrder` sits in the
 * engine's hot path, and every input the app produces today has no `dependsOn` at
 * all. If it ever reorders those, every existing fixture — and every plan a real
 * user sees — changes silently. So the first test here asserts identity, not
 * equivalence: the same array, values in the same positions.
 *
 * The second reason is cycles. A user's own task graph can point in a circle, and
 * the engine must stay total: it breaks the cycle deterministically and reports
 * it, rather than throwing or spinning. Refusing a cycle is the caller's job.
 */

import { describe, expect, it } from 'vitest'
import { topoOrder } from './depOrder'
import { PlacementRequest } from './types'

function req(id: string, dependsOn?: string[]): PlacementRequest {
  return { ref: { kind: 'task', id }, title: id, ...(dependsOn ? { dependsOn } : {}) }
}

/** The comparator order the engine would hand in — deliberately not 0..n-1. */
const PREFERRED = [2, 0, 3, 1]

describe('topoOrder — no dependencies', () => {
  it('returns the comparator array untouched when nothing declares a dependency', () => {
    const requests = [req('a'), req('b'), req('c'), req('d')]
    const result = topoOrder(requests, PREFERRED)

    expect(result.order).toEqual(PREFERRED)
    expect(result.cycle).toEqual([])
  })

  it('returns the very same array reference, so the no-dependency path cannot drift', () => {
    const requests = [req('a'), req('b'), req('c'), req('d')]
    expect(topoOrder(requests, PREFERRED).order).toBe(PREFERRED)
  })

  it('ignores a dependency on an id that is not in this batch, rather than stalling', () => {
    // "already finished" or "belongs to another project" imposes no ordering.
    const requests = [req('a', ['not-in-batch']), req('b'), req('c'), req('d')]
    const result = topoOrder(requests, PREFERRED)

    expect(result.order).toEqual(PREFERRED)
    expect(result.cycle).toEqual([])
  })

  it('treats requests with no ref.id as un-referenceable instead of crashing', () => {
    const requests: PlacementRequest[] = [
      { ref: { kind: 'task' }, title: 'anonymous' },
      req('b', ['a']),
    ]
    const result = topoOrder(requests, [0, 1])
    expect(result.order).toHaveLength(2)
    expect(result.cycle).toEqual([])
  })
})

describe('topoOrder — real dependencies', () => {
  it('puts a prerequisite before its dependent even when the comparator disagrees', () => {
    // b depends on a, but the comparator wants b first.
    const requests = [req('a'), req('b', ['a'])]
    const { order } = topoOrder(requests, [1, 0])

    expect(order).toEqual([0, 1])
  })

  it('orders a three-step chain correctly regardless of the input order', () => {
    const requests = [req('c', ['b']), req('b', ['a']), req('a')]
    const { order } = topoOrder(requests, [0, 1, 2])

    // indices: 2 = a, 1 = b, 0 = c
    expect(order).toEqual([2, 1, 0])
  })

  it('resolves a diamond so both middles follow the root and the join follows both', () => {
    const requests = [req('root'), req('left', ['root']), req('right', ['root']), req('join', ['left', 'right'])]
    const { order } = topoOrder(requests, [3, 2, 1, 0])

    expect(order[0]).toBe(0)
    expect(order.indexOf(3)).toBe(3)
    expect(order.indexOf(1)).toBeLessThan(order.indexOf(3))
    expect(order.indexOf(2)).toBeLessThan(order.indexOf(3))
  })

  it('still lets the comparator decide between two requests that are both unblocked', () => {
    // c and d are free; the comparator prefers d. That preference must survive.
    const requests = [req('a'), req('b', ['a']), req('c'), req('d')]
    const { order } = topoOrder(requests, [3, 2, 0, 1])

    expect(order.indexOf(3)).toBeLessThan(order.indexOf(2))
    expect(order.indexOf(0)).toBeLessThan(order.indexOf(1))
  })

  it('produces the same output for the same graph however the input array is shuffled', () => {
    const a = topoOrder([req('a'), req('b', ['a']), req('c', ['b'])], [0, 1, 2])
    const b = topoOrder([req('a'), req('b', ['a']), req('c', ['b'])], [0, 1, 2])
    expect(a.order).toEqual(b.order)
  })
})

describe('topoOrder — cycles stay total', () => {
  it('breaks a two-node cycle and reports it instead of throwing', () => {
    const requests = [req('a', ['b']), req('b', ['a'])]
    const result = topoOrder(requests, [0, 1])

    expect(result.order.slice().sort()).toEqual([0, 1])
    expect(result.cycle.slice().sort()).toEqual([0, 1])
  })

  it('breaks a three-node cycle and still returns every index exactly once', () => {
    const requests = [req('a', ['c']), req('b', ['a']), req('c', ['b'])]
    const result = topoOrder(requests, [0, 1, 2])

    expect(result.order.slice().sort()).toEqual([0, 1, 2])
    expect(result.cycle).toHaveLength(3)
  })

  it('keeps the acyclic part in dependency order and appends only the cycle', () => {
    // d is free; a<->b are a cycle; c depends on d.
    const requests = [req('a', ['b']), req('b', ['a']), req('c', ['d']), req('d')]
    const result = topoOrder(requests, [0, 1, 2, 3])

    expect(result.order.indexOf(3)).toBeLessThan(result.order.indexOf(2))
    expect(result.cycle.slice().sort()).toEqual([0, 1])
  })

  it('drops a self-dependency rather than deadlocking the whole graph on it', () => {
    const requests = [req('a', ['a']), req('b')]
    const result = topoOrder(requests, [0, 1])

    expect(result.cycle).toEqual([])
    expect(result.order).toEqual([0, 1])
  })

  it('never loses or duplicates an index, cycle or not', () => {
    const requests = [req('a', ['b']), req('b', ['a']), req('c'), req('d', ['c'])]
    const { order } = topoOrder(requests, [3, 2, 1, 0])

    expect(new Set(order).size).toBe(4)
    expect(order).toHaveLength(4)
  })
})
