/**
 * projectsFlag.test.ts
 *
 * The sibling of tools.test.ts, for the second flag. Same claim, same standard of
 * proof: with PROJECTS unset the model's request must be byte-identical to what
 * the app has always shipped — same tools, in the same order, with the same JSON.
 *
 * The extra thing this file pins is the interaction between the two flags.
 * `plan_project` returns a plan_id that only `apply_plan` can commit, and
 * `apply_plan` is V2-only, so offering plan_project without SCHEDULER_V2 would
 * hand the model a proposal it can never apply.
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  PROJECT_ONLY_TOOLS, calendarTools, getCalendarTools, getOnboardingTools, onboardingTools,
} from './tools'
import { projectsEnabled } from './featureFlags'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nameOf = (t: any): string => t.function?.name
const names = (list: unknown[]) => list.map(nameOf)

const ORIGINAL = process.env.PROJECTS
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PROJECTS
  else process.env.PROJECTS = ORIGINAL
})

describe('projectsEnabled', () => {
  it('is OFF when the variable is unset — the default this ships with', () => {
    delete process.env.PROJECTS
    expect(projectsEnabled()).toBe(false)
  })

  it('stays off for anything that is not "1" or "true"', () => {
    for (const value of ['', '0', 'false', 'yes', 'on', 'TRUE']) {
      process.env.PROJECTS = value
      expect(projectsEnabled(), `PROJECTS=${JSON.stringify(value)}`).toBe(false)
    }
  })

  it('turns on for "1" and "true"', () => {
    process.env.PROJECTS = '1'
    expect(projectsEnabled()).toBe(true)
    process.env.PROJECTS = 'true'
    expect(projectsEnabled()).toBe(true)
  })
})

describe('flag off ⇒ the tool list is untouched', () => {
  it('returns the identical array object, not a copy', () => {
    expect(getCalendarTools(false, false)).toBe(calendarTools)
    expect(getOnboardingTools(false, false)).toBe(onboardingTools)
  })

  it('offers no projects tool at all', () => {
    const offered = new Set(names(getCalendarTools(false, false)))
    for (const tool of PROJECT_ONLY_TOOLS) expect(offered.has(tool)).toBe(false)
  })

  it('leaves create_task and update_task without project parameters', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createTask = getCalendarTools(false, false).find(t => nameOf(t) === 'create_task') as any
    expect(createTask.function.parameters.properties.project_id).toBeUndefined()
    expect(createTask.function.parameters.properties.depends_on).toBeUndefined()
  })
})

describe('flag on ⇒ exactly the intended surface appears', () => {
  it('adds the four always-available projects tools', () => {
    const offered = new Set(names(getCalendarTools(false, true)))
    for (const tool of ['create_project', 'list_projects', 'update_project', 'delete_project']) {
      expect(offered.has(tool)).toBe(true)
    }
  })

  it('withholds plan_project unless the engine path is on too', () => {
    // It returns a plan_id only apply_plan can commit, and apply_plan is V2-only.
    expect(names(getCalendarTools(false, true))).not.toContain('plan_project')
    expect(names(getCalendarTools(true, true))).toContain('plan_project')
  })

  it('keeps apply_plan available wherever plan_project is', () => {
    const withBoth = names(getCalendarTools(true, true))
    expect(withBoth).toContain('plan_project')
    expect(withBoth).toContain('apply_plan')
  })

  it('teaches create_task and update_task about projects', () => {
    for (const name of ['create_task', 'update_task']) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tool = getCalendarTools(false, true).find(t => nameOf(t) === name) as any
      expect(tool.function.parameters.properties.project_id).toBeTruthy()
      expect(tool.function.parameters.properties.depends_on).toBeTruthy()
    }
  })

  it('keeps every original tool — the projects surface only adds', () => {
    const before = names(calendarTools)
    const after = names(getCalendarTools(false, true))
    for (const name of before) expect(after).toContain(name)
  })

  it('adds the tools to the onboarding list too', () => {
    expect(names(getOnboardingTools(false, true))).toContain('create_project')
    expect(names(getOnboardingTools(true, true))).toContain('complete_onboarding')
  })
})

describe('the four flag combinations stay well-formed', () => {
  const combos: [boolean, boolean][] = [[false, false], [true, false], [false, true], [true, true]]

  it('never produces a duplicate tool name in any combination', () => {
    for (const [v2, projects] of combos) {
      const list = names(getCalendarTools(v2, projects))
      expect(new Set(list).size, `v2=${v2} projects=${projects}`).toBe(list.length)
    }
  })

  it('gives every tool a name, a description and an object schema', () => {
    for (const [v2, projects] of combos) {
      for (const tool of getCalendarTools(v2, projects)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fn = (tool as any).function
        expect(fn.name).toBeTruthy()
        expect(fn.description).toBeTruthy()
        expect(fn.parameters.type).toBe('object')
      }
    }
  })

  it('does not mutate the v1 arrays while building the projects ones', () => {
    const before = names(calendarTools)
    getCalendarTools(true, true)
    getCalendarTools(false, true)
    expect(names(calendarTools)).toEqual(before)
  })

  it('drops get_free_slots in every v2 combination, projects or not', () => {
    expect(names(getCalendarTools(true, false))).not.toContain('get_free_slots')
    expect(names(getCalendarTools(true, true))).not.toContain('get_free_slots')
  })
})
