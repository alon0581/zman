/**
 * phasesFlag.test.ts
 *
 * The sibling of projectsFlag.test.ts, for the third flag. Same claim, same
 * standard of proof: with PHASES unset the model's request must be byte-identical
 * to what the app already shipped — same tools, same order, same JSON.
 *
 * It also pins the one thing a tool surface can get catastrophically wrong:
 * `update_profile` must never expose a field that would let the model widen its
 * own permissions or silently overwrite a control the user can see.
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  PHASE_ONLY_TOOLS, calendarTools, getCalendarTools, getOnboardingTools, onboardingTools,
} from './tools'
import { phasesEnabled } from './featureFlags'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nameOf = (t: any): string => t.function?.name
const names = (list: unknown[]) => list.map(nameOf)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toolNamed = (list: unknown[], n: string): any => list.find(t => nameOf(t) === n)

const ORIGINAL = process.env.PHASES
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PHASES
  else process.env.PHASES = ORIGINAL
})

describe('phasesEnabled', () => {
  it('is OFF when the variable is unset — the default this ships with', () => {
    delete process.env.PHASES
    expect(phasesEnabled()).toBe(false)
  })

  it('stays off for anything that is not "1" or "true"', () => {
    for (const v of ['', '0', 'false', 'yes', 'TRUE', 'on']) {
      process.env.PHASES = v
      expect(phasesEnabled(), `PHASES=${JSON.stringify(v)}`).toBe(false)
    }
  })

  it('turns on for "1" and "true"', () => {
    process.env.PHASES = '1'
    expect(phasesEnabled()).toBe(true)
    process.env.PHASES = 'true'
    expect(phasesEnabled()).toBe(true)
  })
})

describe('flag off ⇒ the tool list is untouched', () => {
  it('returns the identical array object, not a copy', () => {
    expect(getCalendarTools(false, false, false)).toBe(calendarTools)
    expect(getOnboardingTools(false, false, false)).toBe(onboardingTools)
  })

  it('offers no phase tool at all', () => {
    const offered = new Set(names(getCalendarTools(true, true, false)))
    for (const t of PHASE_ONLY_TOOLS) expect(offered.has(t)).toBe(false)
  })

  it('leaves save_memory without a scope parameter', () => {
    const t = toolNamed(getCalendarTools(false, false, false), 'save_memory')
    expect(t.function.parameters.properties.entries.items.properties.scope).toBeUndefined()
  })

  it('leaves delete_event\'s description exactly as it was', () => {
    const off = toolNamed(getCalendarTools(false, false, false), 'delete_event')
    expect(off.function.description).not.toContain('end_series')
  })
})

describe('flag on ⇒ exactly the intended surface appears', () => {
  it('adds all four phase tools', () => {
    const offered = new Set(names(getCalendarTools(false, false, true)))
    for (const t of ['start_phase', 'list_phases', 'update_profile', 'end_series']) {
      expect(offered.has(t)).toBe(true)
    }
  })

  it('redirects delete_event to end_series, where the model actually chooses', () => {
    // Prose in the prompt lost to a more specific tool description once already in
    // this repo. The routing has to sit in the description.
    const t = toolNamed(getCalendarTools(false, false, true), 'delete_event')
    expect(t.function.description).toContain('end_series')
    expect(t.function.description).toMatch(/past/i)
  })

  it('teaches save_memory about scope', () => {
    const t = toolNamed(getCalendarTools(false, false, true), 'save_memory')
    const scope = t.function.parameters.properties.scope
    expect(scope).toBeTruthy()
    expect(scope.enum).toEqual(['phase', 'always'])
  })

  it('keeps every original tool — phases only adds', () => {
    const after = names(getCalendarTools(false, false, true))
    for (const n of names(calendarTools)) expect(after).toContain(n)
  })

  it('composes with the other two flags without losing their tools', () => {
    const all = names(getCalendarTools(true, true, true))
    expect(all).toContain('start_phase')     // phases
    expect(all).toContain('plan_project')    // projects + v2
    expect(all).toContain('apply_plan')      // v2
    expect(all).not.toContain('get_free_slots')
  })

  it('adds them to the onboarding list too', () => {
    expect(names(getOnboardingTools(false, false, true))).toContain('start_phase')
    expect(names(getOnboardingTools(false, false, true))).toContain('complete_onboarding')
  })
})

describe('update_profile cannot be used to widen the model\'s own reach', () => {
  const denied = [
    'autonomy_mode',        // the user's consent setting
    'scheduling_method',    // has a Settings control and drives the projects board
    'secondary_methods',
    'language', 'theme', 'mic_position',
    'preferred_hours',      // vestigial; reintroducing a writer would revive the ghost
    'ai_api_key_encrypted', 'ai_model', 'push_subscription', 'fcm_token',
    'onboarding_completed', 'user_id',
  ]

  it.each(denied)('never exposes %s', (field) => {
    const t = toolNamed(getCalendarTools(false, false, true), 'update_profile')
    expect(Object.keys(t.function.parameters.properties)).not.toContain(field)
  })

  it('exposes exactly the rhythm fields and nothing else', () => {
    const t = toolNamed(getCalendarTools(false, false, true), 'update_profile')
    expect(Object.keys(t.function.parameters.properties).sort()).toEqual([
      'day_structure', 'occupation', 'productivity_peak', 'schedule_weekend', 'sleep_time', 'wake_time',
    ])
  })
})

describe('every combination stays well-formed', () => {
  const combos: [boolean, boolean, boolean][] = [
    [false, false, false], [true, false, false], [false, true, false], [false, false, true],
    [true, true, false], [true, false, true], [false, true, true], [true, true, true],
  ]

  it('never produces a duplicate tool name', () => {
    for (const [v2, p, ph] of combos) {
      const list = names(getCalendarTools(v2, p, ph))
      expect(new Set(list).size, `v2=${v2} projects=${p} phases=${ph}`).toBe(list.length)
    }
  })

  it('gives every tool a name, description and object schema', () => {
    for (const [v2, p, ph] of combos) {
      for (const tool of getCalendarTools(v2, p, ph)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fn = (tool as any).function
        expect(fn.name).toBeTruthy()
        expect(fn.description).toBeTruthy()
        expect(fn.parameters.type).toBe('object')
      }
    }
  })

  it('does not mutate the base arrays while building the variants', () => {
    const before = names(calendarTools)
    getCalendarTools(true, true, true)
    getCalendarTools(false, false, true)
    expect(names(calendarTools)).toEqual(before)
  })
})
