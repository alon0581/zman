/**
 * systemPrompt.methods.test.ts
 *
 * The prompt and the engine used to disagree about what the user's method does,
 * so the assistant described one week and the calendar produced another. Three
 * concrete divergences, all now closed by DERIVING the numbers from METHOD_RULES
 * instead of restating them:
 *
 *   theme_days   the prompt listed Sun=focus / Mon=meetings / Tue=ops /
 *                Wed=projects / Thu=learning / Fri=review; `themeDays` maps
 *                Sun+Tue to study, Mon+Wed to work, Thu to admin, Fri–Sat to
 *                nothing. Not one day agreed.
 *   time_boxing  the prompt offered 30/60/90-minute boxes; the rules clamp every
 *                box to exactly 45 (minBlock === maxBlock === 45).
 *   kanban       the prompt said "max 3" twice; the rules say 4.
 *
 * In all three the engine is the source of truth — it is what actually writes to
 * the calendar — so these tests assert the prompt against METHOD_RULES, in that
 * direction. They are written to fail if either side is edited alone.
 */

import { describe, expect, it } from 'vitest'
import { CalendarEvent, UserProfile } from '@/types'
import { buildSystemPrompt } from './systemPrompt'
import { calendarTools, getCalendarTools } from './tools'
import { METHOD_RULES } from '@/lib/scheduling/methodRules'
import { SchedulingMethod } from '@/lib/scheduling/methodMapper'
import { Weekday } from '@/lib/scheduling/types'

const NOW = new Date('2026-08-16T09:00:00.000Z')
const NO_EVENTS: CalendarEvent[] = []

function promptFor(method: SchedulingMethod): string {
  const profile = {
    user_id: 'u1', autonomy_mode: 'hybrid', theme: 'dark',
    language: 'he', onboarding_completed: true,
    scheduling_method: method,
  } as UserProfile
  return buildSystemPrompt(profile, NO_EVENTS, NOW).staticPrefix
}

/** The single METHOD: line the prompt emits for the user's primary method. */
function methodLine(method: SchedulingMethod): string {
  const line = promptFor(method).split('\n').find(l => l.startsWith('METHOD:'))
  expect(line, `no METHOD line for ${method}`).toBeDefined()
  return line!
}

describe('theme_days: the prompt states the engine\'s theme map, not its own', () => {
  const line = methodLine('theme_days')
  const themes = METHOD_RULES.theme_days.themeDays ?? {}
  const NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  it('names every themed weekday with the category the engine will score against', () => {
    for (let day = 0; day < 7; day++) {
      const theme = themes[day as Weekday]
      if (!theme) continue
      expect(line, `${NAMES[day]} missing or wrong in the prompt`).toContain(`${NAMES[day]}=${theme}`)
    }
  })

  it('claims no theme for the days the engine leaves themeless', () => {
    for (let day = 0; day < 7; day++) {
      if (themes[day as Weekday]) continue
      expect(line).not.toContain(`${NAMES[day]}=`)
    }
  })

  it('no longer carries the old invented map', () => {
    for (const stale of ['Sun=focus', 'Mon=meetings', 'Tue=ops', 'Wed=projects', 'Thu=learning', 'Fri=review']) {
      expect(line).not.toContain(stale)
    }
  })
})

describe('time_boxing: the prompt offers the one box the engine can deliver', () => {
  const line = methodLine('time_boxing')

  it('states the configured box length', () => {
    expect(line).toContain(`${METHOD_RULES.time_boxing.sessionMinutes} min`)
  })

  it('does not offer sizes the rules clamp away', () => {
    // minBlock === maxBlock, so "small/medium/large" was never deliverable.
    expect(METHOD_RULES.time_boxing.minBlock).toBe(METHOD_RULES.time_boxing.maxBlock)
    for (const stale of ['30min(small)', '60min(medium)', '90min(large max)']) {
      expect(line).not.toContain(stale)
    }
  })
})

describe('kanban: one WIP limit, in all three places that state it', () => {
  const wip = METHOD_RULES.kanban.maxSessionsPerDay

  it('the prompt states the engine\'s number', () => {
    const line = methodLine('kanban')
    expect(line).toContain(`max ${wip} in-progress`)
    expect(line).not.toContain('max 3 in-progress')
  })

  it('the complementary hint states it too', () => {
    // Reached via a different method's prompt, where kanban is secondary.
    const profile = {
      user_id: 'u1', autonomy_mode: 'hybrid', theme: 'dark', language: 'he',
      onboarding_completed: true,
      scheduling_method: 'pomodoro', secondary_methods: ['kanban'],
    } as UserProfile
    const prefix = buildSystemPrompt(profile, NO_EVENTS, NOW).staticPrefix
    expect(prefix).toContain(`max ${wip} WIP`)
    expect(prefix).not.toContain('max 3 WIP')
  })
})

describe('pomodoro and 52/17: the prompt describes the break the engine schedules', () => {
  it('states each method\'s own work and break lengths', () => {
    for (const method of ['pomodoro', 'rule_5217'] as const) {
      const rules = METHOD_RULES[method]
      const line = methodLine(method)
      expect(line).toContain(`${rules.sessionMinutes}-min focus + ${rules.breakMinutes}-min break`)
      // The cycle length is arithmetic on those two, not a third number: the
      // prompt used to claim a 70-minute 52/17 cycle, which is 69.
      expect(line).toContain(`one cycle = ${rules.sessionMinutes + rules.breakMinutes!} min`)
    }
  })

  it('tells the model the break is a gap, since that is what lands on the calendar', () => {
    expect(methodLine('pomodoro')).toContain('not an event on the calendar')
  })

  it('promises no long break, because no rule configures one', () => {
    // "After 4 → long 15-30 min break" and "After 3 cycles→longer 30+ min rest"
    // were numbers with no home in METHOD_RULES and no effect on any plan.
    expect(methodLine('pomodoro')).not.toMatch(/long 15-30 min break/)
    expect(methodLine('rule_5217')).not.toMatch(/longer 30\+ min rest/)
  })
})

describe('no tool sends the model to a table that does not exist', () => {
  it('the phantom METHOD SESSION SIZES table is referenced nowhere', () => {
    for (const [v2, projects, phases] of [
      [false, false, false], [true, false, false], [true, true, false], [true, true, true],
    ] as const) {
      const json = JSON.stringify(getCalendarTools(v2, projects, phases))
      expect(json, `v2=${v2} projects=${projects} phases=${phases}`).not.toContain('METHOD SESSION SIZES')
    }
    expect(JSON.stringify(calendarTools)).not.toContain('METHOD SESSION SIZES')
  })

  it('and neither does the system prompt, which never had one', () => {
    expect(promptFor('pomodoro')).not.toContain('METHOD SESSION SIZES')
  })

  it('break_down_task tells the model to omit the length instead of guessing one', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool = calendarTools.find(t => (t as any).function?.name === 'break_down_task') as any
    expect(tool.function.description).toContain('OMIT session_length_hours')
  })
})
