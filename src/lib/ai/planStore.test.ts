import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_PLANS_PER_USER, PLAN_TTL_MS, StoredPlanBlock, __resetPlanStore, consumePlan, getPlan, savePlan,
} from './planStore'
import { PlanToolResult } from '@/lib/scheduling/adapter'

const VIEW: PlanToolResult = { status: 'ok', blocks: [], summary: 'test' }

function block(start: string): StoredPlanBlock {
  return { title: 'לימוד', start, end: start.replace('T09', 'T10'), color: '#6366F1', mobility: 'flexible', why: ['כי כן'] }
}

afterEach(() => __resetPlanStore())

describe('planStore', () => {
  it('round-trips the exact blocks that were proposed', () => {
    const blocks = [block('2026-08-17T09:00:00'), block('2026-08-18T09:00:00')]
    const plan = savePlan('u1', blocks, VIEW)
    expect(getPlan('u1', plan.planId)?.blocks).toEqual(blocks)
  })

  it('scopes plans to their user — another user\'s id must not resolve', () => {
    const plan = savePlan('u1', [block('2026-08-17T09:00:00')], VIEW)
    expect(getPlan('u2', plan.planId)).toBeNull()
    expect(consumePlan('u2', plan.planId)).toBeNull()
    // …and the real owner still has it.
    expect(getPlan('u1', plan.planId)).not.toBeNull()
  })

  it('consumes a plan, so a double-tap cannot write the same events twice', () => {
    const plan = savePlan('u1', [block('2026-08-17T09:00:00')], VIEW)
    expect(consumePlan('u1', plan.planId)).not.toBeNull()
    expect(consumePlan('u1', plan.planId)).toBeNull()
    expect(getPlan('u1', plan.planId)).toBeNull()
  })

  it('expires a stale proposal rather than applying times the user last saw ten minutes ago', () => {
    const t0 = 1_000_000
    const plan = savePlan('u1', [block('2026-08-17T09:00:00')], VIEW, t0)
    expect(getPlan('u1', plan.planId, t0 + PLAN_TTL_MS - 1)).not.toBeNull()
    expect(getPlan('u1', plan.planId, t0 + PLAN_TTL_MS + 1)).toBeNull()
  })

  it('keeps memory bounded, dropping the oldest proposals first', () => {
    const ids: string[] = []
    for (let i = 0; i < MAX_PLANS_PER_USER + 3; i++) {
      ids.push(savePlan('u1', [block('2026-08-17T09:00:00')], VIEW, 1_000_000 + i).planId)
    }
    const kept = ids.filter(id => getPlan('u1', id, 1_000_100) !== null)
    expect(kept.length).toBeLessThanOrEqual(MAX_PLANS_PER_USER)
    // The most recent proposal is the one a user is about to confirm.
    expect(kept).toContain(ids[ids.length - 1])
    expect(kept).not.toContain(ids[0])
  })

  it('mints distinct ids even for identical plans saved in the same millisecond', () => {
    const a = savePlan('u1', [block('2026-08-17T09:00:00')], VIEW, 1_000_000)
    const b = savePlan('u1', [block('2026-08-17T09:00:00')], VIEW, 1_000_000)
    expect(a.planId).not.toBe(b.planId)
  })

  it('returns null for an id that was never issued', () => {
    expect(getPlan('u1', 'plan_made_up')).toBeNull()
  })
})
