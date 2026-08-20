/**
 * placesFlag.test.ts
 *
 * The sibling of projectsFlag.test.ts and phasesFlag.test.ts, for the fourth
 * flag. Same claim, same standard of proof: with PLACES unset the model's
 * request must be byte-identical to what the app already ships — same tools,
 * same order, same JSON, and create_event with no place_id property at all.
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  PLACE_ONLY_TOOLS, calendarTools, getCalendarTools, getOnboardingTools, onboardingTools,
} from './tools'
import { placesEnabled } from './featureFlags'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nameOf = (t: any): string => t.function?.name
const names = (list: unknown[]) => list.map(nameOf)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toolNamed = (list: unknown[], n: string): any => list.find(t => nameOf(t) === n)

const ORIGINAL = process.env.PLACES
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PLACES
  else process.env.PLACES = ORIGINAL
})

describe('placesEnabled', () => {
  it('is OFF when the variable is unset — the default this ships with', () => {
    delete process.env.PLACES
    expect(placesEnabled()).toBe(false)
  })

  it('stays off for anything that is not "1" or "true"', () => {
    for (const value of ['', '0', 'false', 'yes', 'on', 'TRUE']) {
      process.env.PLACES = value
      expect(placesEnabled(), `PLACES=${JSON.stringify(value)}`).toBe(false)
    }
  })

  it('turns on for "1" and "true"', () => {
    process.env.PLACES = '1'
    expect(placesEnabled()).toBe(true)
    process.env.PLACES = 'true'
    expect(placesEnabled()).toBe(true)
  })
})

describe('flag off ⇒ the tool list is untouched', () => {
  it('returns the identical array object, not a copy', () => {
    expect(getCalendarTools(false, false, false, false)).toBe(calendarTools)
    expect(getOnboardingTools(false, false, false, false)).toBe(onboardingTools)
  })

  it('offers no place tool at all', () => {
    const offered = new Set(names(getCalendarTools(true, true, true, false)))
    for (const tool of PLACE_ONLY_TOOLS) expect(offered.has(tool)).toBe(false)
  })

  it('leaves create_event without a place_id parameter', () => {
    const createEvent = toolNamed(getCalendarTools(false, false, false, false), 'create_event')
    expect(createEvent.function.parameters.properties.place_id).toBeUndefined()
  })

  it('leaves create_event\'s description exactly as it was, even under v2', () => {
    const v1Off = toolNamed(getCalendarTools(false, false, false, false), 'create_event')
    const v2Off = toolNamed(getCalendarTools(true, false, false, false), 'create_event')
    expect(v1Off.function.description).not.toContain('place_id')
    expect(v2Off.function.description).not.toContain('place_id')
  })
})

describe('flag on ⇒ exactly the intended surface appears', () => {
  it('adds all three place tools', () => {
    const offered = new Set(names(getCalendarTools(false, false, false, true)))
    for (const t of ['save_place', 'list_places', 'delete_place']) {
      expect(offered.has(t)).toBe(true)
    }
  })

  it('gives create_event a place_id parameter', () => {
    const t = toolNamed(getCalendarTools(false, false, false, true), 'create_event')
    expect(t.function.parameters.properties.place_id).toBeTruthy()
  })

  it('mentions place_id in create_event\'s description, under v1 and v2 alike', () => {
    const v1On = toolNamed(getCalendarTools(false, false, false, true), 'create_event')
    const v2On = toolNamed(getCalendarTools(true, false, false, true), 'create_event')
    expect(v1On.function.description).toContain('place_id')
    expect(v2On.function.description).toContain('place_id')
    // The v2 redirect to schedule_item must still be intact underneath the suffix.
    expect(v2On.function.description).toContain('schedule_item')
  })

  it('keeps every original tool — places only adds', () => {
    const after = names(getCalendarTools(false, false, false, true))
    for (const n of names(calendarTools)) expect(after).toContain(n)
  })

  it('composes with the other three flags without losing their tools', () => {
    const all = names(getCalendarTools(true, true, true, true))
    expect(all).toContain('save_place')       // places
    expect(all).toContain('start_phase')      // phases
    expect(all).toContain('plan_project')     // projects + v2
    expect(all).toContain('apply_plan')       // v2
    expect(all).not.toContain('get_free_slots')
  })

  it('adds them to the onboarding list too', () => {
    expect(names(getOnboardingTools(false, false, false, true))).toContain('save_place')
    expect(names(getOnboardingTools(false, false, false, true))).toContain('complete_onboarding')
  })
})

describe('every combination stays well-formed', () => {
  const combos: [boolean, boolean, boolean, boolean][] = []
  for (let mask = 0; mask < 16; mask++) {
    combos.push([!!(mask & 1), !!(mask & 2), !!(mask & 4), !!(mask & 8)])
  }

  it('never produces a duplicate tool name in any of the sixteen combinations', () => {
    for (const [v2, p, ph, pl] of combos) {
      const list = names(getCalendarTools(v2, p, ph, pl))
      expect(new Set(list).size, `v2=${v2} projects=${p} phases=${ph} places=${pl}`).toBe(list.length)
    }
  })

  it('gives every tool a name, description and object schema in every combination', () => {
    for (const [v2, p, ph, pl] of combos) {
      for (const tool of getCalendarTools(v2, p, ph, pl)) {
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
    getCalendarTools(true, true, true, true)
    getCalendarTools(false, false, false, true)
    expect(names(calendarTools)).toEqual(before)
  })
})
