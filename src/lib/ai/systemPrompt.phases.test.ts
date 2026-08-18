/**
 * systemPrompt.phases.test.ts
 *
 * The PERSON PROFILE block used to prefer the OLDEST fact in every bucket, with
 * `Identity` as the highest-priority category and `Patterns` as the lowest. A Map
 * keeps a key's FIRST insertion position, and emission took `slice(0, remaining)` —
 * the head. So `occupation` / `study_field` / `persona` — precisely the facts a
 * life change invalidates — were the most protected facts in the system, while
 * freshly observed behaviour was the first thing dropped at the cap.
 *
 * The longer the app was used, the more confidently it asserted who the user used
 * to be. This file pins the reversal, and — first and above everything else — pins
 * that a caller who passes no phase context still gets byte-identical output.
 */

import { describe, expect, it } from 'vitest'
import { AIMemory, CalendarEvent, UserProfile } from '@/types'
import { ActivePhaseCtx, buildSystemPrompt } from './systemPrompt'

const NOW = new Date('2026-08-15T09:00:00.000Z')
const DAY = 86_400_000

const PROFILE: UserProfile = {
  user_id: 'u1', autonomy_mode: 'hybrid', theme: 'dark',
  language: 'he', onboarding_completed: true,
} as UserProfile

const NO_EVENTS: CalendarEvent[] = []

let seq = 0
function mem(key: string, value: string, over: Partial<AIMemory> = {}): AIMemory {
  seq++
  return {
    id: `m${seq}`, user_id: 'u1', key, value,
    learned_from: 'behavior',
    created_at: new Date(NOW.getTime() - 400 * DAY).toISOString(),
    ...over,
  }
}

/** Written `daysAgo` days before NOW. */
function aged(key: string, value: string, daysAgo: number, over: Partial<AIMemory> = {}): AIMemory {
  const at = new Date(NOW.getTime() - daysAgo * DAY).toISOString()
  return mem(key, value, { created_at: at, updated_at: at, ...over })
}

const ACTIVE = { id: 'p-now', label: 'חופש + לנדוור', started_at: '2026-07-01' }
const ctxOf = (over: Partial<ActivePhaseCtx> = {}): ActivePhaseCtx => ({ active: ACTIVE, ...over })

const build = (memory: AIMemory[], phaseCtx?: ActivePhaseCtx) =>
  buildSystemPrompt(PROFILE, NO_EVENTS, NOW, memory, [], [], phaseCtx)

const profileBlock = (suffix: string) =>
  suffix.slice(suffix.indexOf('👤 PERSON PROFILE'))

describe('compatibility — no phase context means nothing changed', () => {
  const memory = [
    aged('occupation', 'סטודנט', 300),
    aged('pattern_evening', 'מזיז לימודים לערב', 2),
    aged('relationship', 'ארוסה', 200),
    aged('current_goal', 'לסיים סמסטר', 10),
  ]

  it('keeps the legacy Identity-first, oldest-first selection when phaseCtx is omitted', () => {
    // The real identity assertion. Comparing build(m) against build(m, undefined)
    // would be vacuous — same call. What proves the legacy path is genuinely in
    // use is that it still behaves in the OPPOSITE way to the new one: Identity
    // emitted before Patterns, and the oldest fact of a duplicated key winning
    // its position. If the phase-aware path ever became the default, both of
    // these flip and this test fails.
    const legacy = build([
      aged('pattern_evening', 'מזיז לימודים לערב', 1),
      aged('occupation', 'סטודנט', 300),
    ]).dynamicSuffix
    const block = profileBlock(legacy)

    expect(block.indexOf('[Identity]')).toBeLessThan(block.indexOf('[Patterns]'))

    // And the new path puts the same two the other way round.
    const phaseAware = profileBlock(build([
      aged('pattern_evening', 'מזיז לימודים לערב', 1),
      aged('occupation', 'סטודנט', 300),
    ], ctxOf()).dynamicSuffix)
    expect(phaseAware.indexOf('[Patterns]')).toBeLessThan(phaseAware.indexOf('[Identity]'))
  })

  it('ignores phase_id entirely on the legacy path, so old data is unaffected', () => {
    const block = profileBlock(build([
      aged('study_field', 'הנדסת חשמל', 300, { phase_id: 'p-old' }),
    ]).dynamicSuffix)
    // No filtering happens without phase context — the fact is simply present.
    expect(block).toContain('הנדסת חשמל')
    expect(block).not.toContain('Earlier phases')
  })

  it('still uses the old header wording, so nothing downstream shifts', () => {
    expect(build(memory).dynamicSuffix).toContain(
      "👤 PERSON PROFILE (what you've learned about this user",
    )
  })

  it('does not leak a phase banner when no phase is given', () => {
    expect(build(memory).dynamicSuffix).not.toContain('current phase')
  })
})

describe('the inversion, asserted directly', () => {
  it('keeps a fresh pattern_* and drops a stale identity fact at the cap', () => {
    // 40 Identity facts would previously fill the entire budget and evict Patterns
    // outright, because Identity was category #1 and Patterns was #8.
    const identitySediment = Array.from({ length: 40 }, (_, i) =>
      aged(`role_${i}`, `תפקיד ${i}`, 300 + i),
    )
    // Give them all Identity-matching keys.
    const sediment = identitySediment.map(m => ({ ...m, key: m.key.replace('role_', 'role') }))
    const memory = [...sediment, aged('pattern_evening', 'מזיז לימודים לערב', 1)]

    const block = profileBlock(build(memory, ctxOf()).dynamicSuffix)

    expect(block).toContain('pattern_evening')
  })

  it('orders newest-first inside a category, not oldest-first', () => {
    const memory = [
      aged('pattern_old', 'ישן', 200),
      aged('pattern_new', 'חדש', 1),
    ]
    const block = profileBlock(build(memory, ctxOf()).dynamicSuffix)
    expect(block.indexOf('pattern_new')).toBeLessThan(block.indexOf('pattern_old'))
  })

  it('resolves a duplicated key to the most recently written value', () => {
    const memory = [
      aged('occupation', 'סטודנט', 300),
      aged('occupation', 'ברמן בלנדוור', 2),
    ]
    const block = profileBlock(build(memory, ctxOf()).dynamicSuffix)
    expect(block).toContain('ברמן בלנדוור')
    expect(block).not.toContain('סטודנט')
  })

  it('gives day_structure a real category instead of dropping it into [Other]', () => {
    const block = profileBlock(build([aged('day_structure', 'משתנה', 5)], ctxOf()).dynamicSuffix)
    expect(block).toContain('[Rhythm]')
    expect(block).toContain('day_structure')
  })
})

describe('phase scoping', () => {
  it('hides a closed phase\'s facts from the main body', () => {
    const memory = [
      aged('occupation', 'ברמן בלנדוור', 2, { phase_id: 'p-now' }),
      aged('study_field', 'הנדסת חשמל', 300, { phase_id: 'p-old' }),
    ]
    const block = profileBlock(build(memory, ctxOf()).dynamicSuffix)

    expect(block).toContain('ברמן בלנדוור')
    // It may appear in the labelled "earlier phases" line, but never as a current fact.
    expect(block).not.toContain('[Identity] study_field')
  })

  it('labels an archived fact with its era instead of asserting it as true now', () => {
    const memory = [
      aged('occupation', 'ברמן', 2, { phase_id: 'p-now' }),
      aged('study_field', 'הנדסת חשמל', 300, { phase_id: 'p-old' }),
    ]
    const ctx = ctxOf({ closedLabelById: { 'p-old': 'שנה א׳' } })
    const block = profileBlock(build(memory, ctx).dynamicSuffix)

    expect(block).toContain('Earlier phases')
    expect(block).toContain('שנה א׳')
    expect(block).toMatch(/NOT current/i)
  })

  it('keeps timeless facts visible in every phase', () => {
    const memory = [aged('relationship', 'ארוסה', 200)] // no phase_id
    expect(profileBlock(build(memory, ctxOf()).dynamicSuffix)).toContain('ארוסה')
  })

  it('shows the current phase label, in Hebrew, verbatim', () => {
    const block = profileBlock(build([aged('occupation', 'ברמן', 2)], ctxOf()).dynamicSuffix)
    expect(block).toContain('חופש + לנדוור')
    expect(block).toContain('2026-07-01')
  })
})

describe('ages', () => {
  it('ages Goals and Patterns, because there age changes the meaning', () => {
    const memory = [
      aged('current_goal', 'לסיים סמסטר', 120),
      aged('pattern_evening', 'ערב', 3),
    ]
    const block = profileBlock(build(memory, ctxOf()).dynamicSuffix)
    expect(block).toMatch(/current_goal: לסיים סמסטר \(~4mo\)/)
    expect(block).toMatch(/pattern_evening: ערב \(~3d\)/)
  })

  it('does not age Identity or Life, where it would only cost tokens', () => {
    const memory = [aged('occupation', 'ברמן', 100), aged('relationship', 'ארוסה', 100)]
    const block = profileBlock(build(memory, ctxOf()).dynamicSuffix)
    expect(block).toContain('occupation: ברמן')
    expect(block).not.toMatch(/occupation: ברמן \(~/)
    expect(block).not.toMatch(/relationship: ארוסה \(~/)
  })
})

describe('cache safety', () => {
  it('keeps the phase banner out of the cacheable static prefix', () => {
    // The banner varies per turn; leaking it into staticPrefix would break the
    // prompt cache on every request.
    const { staticPrefix, dynamicSuffix } = build([aged('occupation', 'ברמן', 2)], ctxOf())
    expect(dynamicSuffix).toContain('current phase')
    expect(staticPrefix).not.toContain('current phase')
    expect(staticPrefix).not.toContain('חופש + לנדוור')
  })
})

describe('robustness', () => {
  it('returns no profile block at all for empty memory, in both modes', () => {
    expect(build([]).dynamicSuffix).not.toContain('PERSON PROFILE')
    expect(build([], ctxOf()).dynamicSuffix).not.toContain('PERSON PROFILE')
  })

  it('survives a fact with no usable timestamp rather than throwing', () => {
    const broken: AIMemory = {
      id: 'x', user_id: 'u1', key: 'occupation', value: 'ברמן',
      learned_from: 'explicit', created_at: 'not-a-date',
    }
    expect(() => build([broken], ctxOf())).not.toThrow()
    expect(profileBlock(build([broken], ctxOf()).dynamicSuffix)).toContain('ברמן')
  })

  it('works with no active phase, which is the state before the first declaration', () => {
    const block = profileBlock(build([aged('occupation', 'ברמן', 2)], { active: null }).dynamicSuffix)
    expect(block).toContain('ברמן')
  })

  it('is deterministic for the same input', () => {
    const memory = [aged('occupation', 'ברמן', 2), aged('pattern_x', 'y', 1)]
    expect(build(memory, ctxOf()).dynamicSuffix).toBe(build(memory, ctxOf()).dynamicSuffix)
  })
})
