import { afterEach, describe, expect, it } from 'vitest'
import {
  V2_ONLY_TOOLS, calendarTools, getCalendarTools, getOnboardingTools, onboardingTools,
} from './tools'
import { schedulerV2Enabled } from './featureFlags'

/**
 * This file is the proof that SCHEDULER_V2 is inert when unset.
 *
 * The tool list is one of exactly two things the flag changes (the other is the
 * `sched?.enabled` branches inside the dispatcher). If `getCalendarTools(false)`
 * returns the identical array the app has always shipped, the model's request is
 * byte-identical — same tools, same order, same descriptions, same JSON — and
 * therefore so is its behaviour.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nameOf = (t: any): string => t.function?.name

const ORIGINAL_SCHEDULER_V2 = process.env.SCHEDULER_V2
afterEach(() => {
  if (ORIGINAL_SCHEDULER_V2 === undefined) delete process.env.SCHEDULER_V2
  else process.env.SCHEDULER_V2 = ORIGINAL_SCHEDULER_V2
})

describe('schedulerV2Enabled', () => {
  it('is OFF when the variable is unset — the default this change ships with', () => {
    delete process.env.SCHEDULER_V2
    expect(schedulerV2Enabled()).toBe(false)
  })

  it('is OFF for anything that is not an explicit opt-in', () => {
    for (const value of ['', '0', 'false', 'no', 'off', 'yes', 'TRUE', '2']) {
      process.env.SCHEDULER_V2 = value
      expect(schedulerV2Enabled(), `SCHEDULER_V2=${JSON.stringify(value)}`).toBe(false)
    }
  })

  it('is ON only for an explicit 1 / true', () => {
    process.env.SCHEDULER_V2 = '1'
    expect(schedulerV2Enabled()).toBe(true)
    process.env.SCHEDULER_V2 = 'true'
    expect(schedulerV2Enabled()).toBe(true)
  })
})

describe('tool list with the flag OFF', () => {
  it('returns the very same array object the app has always used', () => {
    // Identity, not deep-equality: nothing was rebuilt, copied, or re-ordered.
    expect(getCalendarTools(false)).toBe(calendarTools)
    expect(getOnboardingTools(false)).toBe(onboardingTools)
  })

  it('still offers get_free_slots', () => {
    expect(getCalendarTools(false).map(nameOf)).toContain('get_free_slots')
  })

  it('does not leak the v2 tools into the model\'s view', () => {
    const names = getCalendarTools(false).map(nameOf)
    for (const v2Tool of V2_ONLY_TOOLS) expect(names).not.toContain(v2Tool)
    expect(getOnboardingTools(false).map(nameOf)).not.toContain('schedule_item')
  })

  it('serialises identically to the shipped array', () => {
    // The strongest form of the claim: the JSON that reaches the provider.
    expect(JSON.stringify(getCalendarTools(false))).toBe(JSON.stringify(calendarTools))
  })
})

describe('tool list with the flag ON', () => {
  const v2 = getCalendarTools(true)
  const names = v2.map(nameOf)

  it('removes get_free_slots entirely — an unoffered tool cannot be called', () => {
    expect(names).not.toContain('get_free_slots')
  })

  it('adds schedule_item and apply_plan', () => {
    expect(names).toContain('schedule_item')
    expect(names).toContain('apply_plan')
  })

  it('keeps every other v1 tool', () => {
    const v1Names = calendarTools.map(nameOf).filter(n => n !== 'get_free_slots')
    for (const n of v1Names) expect(names).toContain(n)
  })

  it('does not mutate the v1 arrays while building the v2 ones', () => {
    // Rebuilding must not have reached into the shared array — otherwise
    // turning the flag on for one request would change every later one.
    expect(calendarTools.map(nameOf)).toContain('get_free_slots')
    expect(calendarTools.map(nameOf)).not.toContain('schedule_item')
  })

  it('makes move_event\'s times optional, since choosing them is the engine\'s job', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const move = v2.find(t => nameOf(t) === 'move_event') as any
    expect(move.function.parameters.required).toEqual(['event_id'])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v1Move = calendarTools.find(t => nameOf(t) === 'move_event') as any
    expect(v1Move.function.parameters.required).toEqual(['event_id', 'new_start_time', 'new_end_time'])
  })

  it('redirects break_down_task and create_event at the engine in their descriptions', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const desc = (n: string) => (v2.find(t => nameOf(t) === n) as any).function.description as string
    expect(desc('break_down_task')).toMatch(/plan_id/)
    expect(desc('break_down_task')).toMatch(/writes nothing|PROPOSAL/)
    expect(desc('create_event')).toMatch(/schedule_item/)
  })

  it('keeps onboarding\'s own tool alongside the engine tools', () => {
    const onboardingNames = getOnboardingTools(true).map(nameOf)
    expect(onboardingNames).toContain('complete_onboarding')
    expect(onboardingNames).toContain('schedule_item')
    expect(onboardingNames).not.toContain('get_free_slots')
  })

  it('every tool still has a name, a description and a schema', () => {
    for (const tool of v2) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fn = (tool as any).function
      expect(fn.name).toBeTruthy()
      expect(fn.description?.length ?? 0).toBeGreaterThan(10)
      expect(fn.parameters?.type).toBe('object')
    }
  })

  it('has no duplicate tool names', () => {
    expect(new Set(names).size).toBe(names.length)
  })
})
