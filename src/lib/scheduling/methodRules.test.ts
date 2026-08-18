import { describe, it, expect } from 'vitest'
import { METHOD_RULES, getMethodRules } from './methodRules'
import { SchedulingMethod, METHOD_LABELS } from './methodMapper'
import { splitSessions } from './plan'

const ALL_METHODS = Object.keys(METHOD_LABELS) as SchedulingMethod[]

describe('METHOD_RULES is exhaustive', () => {
  it('has an entry for every SchedulingMethod in METHOD_LABELS', () => {
    for (const method of ALL_METHODS) {
      expect(METHOD_RULES[method], `missing rules for "${method}"`).toBeDefined()
    }
  })

  it('getMethodRules returns the same object as the map', () => {
    for (const method of ALL_METHODS) {
      expect(getMethodRules(method)).toBe(METHOD_RULES[method])
    }
  })
})

describe('every rule set is internally consistent', () => {
  for (const method of ALL_METHODS) {
    const rules = METHOD_RULES[method]

    it(`${method}: minBlock <= sessionMinutes <= maxBlock`, () => {
      expect(rules.minBlock).toBeLessThanOrEqual(rules.sessionMinutes)
      expect(rules.sessionMinutes).toBeLessThanOrEqual(rules.maxBlock)
    })

    it(`${method}: has a positive dailyCapMinutes`, () => {
      expect(rules.dailyCapMinutes).toBeGreaterThan(0)
    })

    it(`${method}: allows at least one session per day`, () => {
      expect(rules.maxSessionsPerDay).toBeGreaterThanOrEqual(1)
    })
  }
})

describe('rules match their METHOD_LABELS description exactly', () => {
  it('pomodoro: 25-min sessions with 5-min breaks (description_en/he say so)', () => {
    const rules = METHOD_RULES.pomodoro
    expect(rules.sessionMinutes).toBe(25)
    expect(rules.breakAfterMinutes).toBe(25)
    expect(rules.breakMinutes).toBe(5)
  })

  it('deep_work: 2-3 hour uninterrupted focus blocks', () => {
    const rules = METHOD_RULES.deep_work
    expect(rules.minBlock).toBe(120) // 2h
    expect(rules.maxBlock).toBe(180) // 3h
    expect(rules.preferContiguous).toBe(true) // "uninterrupted"
  })

  it('rule_5217: 52 min work + 17 min break', () => {
    const rules = METHOD_RULES.rule_5217
    expect(rules.sessionMinutes).toBe(52)
    expect(rules.breakAfterMinutes).toBe(52)
    expect(rules.breakMinutes).toBe(17)
  })

  it('eat_the_frog: hardestFirst is set, matching "hardest task first thing"', () => {
    expect(METHOD_RULES.eat_the_frog.hardestFirst).toBe(true)
  })

  it('theme_days: populates themeDays over the Sun-Thu work week, skipping the weekend', () => {
    const themeDays = METHOD_RULES.theme_days.themeDays
    expect(themeDays).toBeDefined()
    // Sunday (0) through Thursday (4) are workdays in Israel.
    for (const day of [0, 1, 2, 3, 4] as const) {
      expect(themeDays?.[day]).toBeDefined()
    }
    // Friday (5) and Saturday (6) are the weekend / Shabbat — no theme.
    expect(themeDays?.[5]).toBeUndefined()
    expect(themeDays?.[6]).toBeUndefined()
  })

  it('the_one_thing: at most one session per day, matching "the ONE thing"', () => {
    expect(METHOD_RULES.the_one_thing.maxSessionsPerDay).toBe(1)
  })

  it('time_boxing: strict boxes — min equals max, no drift', () => {
    const rules = METHOD_RULES.time_boxing
    expect(rules.minBlock).toBe(rules.maxBlock)
  })
})

describe('every configured sessionMinutes is a length the engine can actually deliver', () => {
  // A number in this table that placement can never produce is decoration, and
  // this is not hypothetical: eisenhower/gtd/okr/moscow were configured at 50,
  // but plan.ts snaps a nominal length with roundToQuarter before clampBlock and
  // roundToQuarter(50) is 45 — so those four methods could never once schedule
  // the block they claimed. The table now says 45, and this is the test that
  // stops a future edit from re-introducing an undeliverable number anywhere.
  for (const method of ALL_METHODS) {
    it(`${method}: a one-session request lands on exactly sessionMinutes`, () => {
      const rules = METHOD_RULES[method]
      const [only] = splitSessions({ ref: { kind: 'task' }, title: 'x' }, rules)
      expect(only).toBe(rules.sessionMinutes)
    })
  }
})

describe('prioritisation frameworks get documented neutral defaults', () => {
  // eisenhower, gtd, moscow, okr say nothing about block shape in their
  // METHOD_LABELS description — they should share the same neutral numbers,
  // not diverge for no documented reason.
  it('eisenhower, gtd, moscow, okr share the same neutral block shape', () => {
    const { sessionMinutes, minBlock, maxBlock, dailyCapMinutes } = METHOD_RULES.eisenhower
    for (const method of ['gtd', 'moscow', 'okr'] as const) {
      expect(METHOD_RULES[method].sessionMinutes).toBe(sessionMinutes)
      expect(METHOD_RULES[method].minBlock).toBe(minBlock)
      expect(METHOD_RULES[method].maxBlock).toBe(maxBlock)
      expect(METHOD_RULES[method].dailyCapMinutes).toBe(dailyCapMinutes)
    }
  })
})
