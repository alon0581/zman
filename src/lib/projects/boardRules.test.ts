/**
 * boardRules.test.ts
 *
 * BOARD_RULES is the app's second exhaustive method table, after METHOD_RULES.
 * The point of these tests is the same as that file's runtime tripwire: catch the
 * moment the table and the methods fall out of step, rather than discovering it
 * when a user picks a method whose board is `undefined`.
 *
 * The second theme is the anti-drift rule. This app already carries one defect of
 * exactly the kind being guarded against here — METHOD_SESSION_HOURS and
 * METHOD_RULES[m].sessionMinutes are two tables for one number and they disagree
 * on 10 of 18 methods. So these tests also assert that BOARD_RULES never grew a
 * copy of a number that lives somewhere else.
 */

import { describe, expect, it } from 'vitest'
import { METHOD_LABELS, SchedulingMethod } from '@/lib/scheduling/methodMapper'
import { BOARD_RULES, boardRulesFor, signalOrderFor } from './boardRules'
import { CardSignal } from './types'

const ALL_METHODS = Object.keys(METHOD_LABELS) as SchedulingMethod[]
const ALL_SIGNALS: CardSignal[] = ['deadline', 'progress', 'next', 'invested']

describe('BOARD_RULES covers every method', () => {
  it('has a board for all 18 methods, with none left over', () => {
    expect(Object.keys(BOARD_RULES).sort()).toEqual([...ALL_METHODS].sort())
  })

  it('stays in step with METHOD_LABELS, the same tripwire methodRules.ts uses', () => {
    expect(Object.keys(BOARD_RULES)).toHaveLength(Object.keys(METHOD_LABELS).length)
  })
})

describe('every row is structurally sane', () => {
  it.each(ALL_METHODS)('%s has 2-4 columns with unique ids', (method) => {
    const { columns } = BOARD_RULES[method]
    expect(columns.length).toBeGreaterThanOrEqual(2)
    expect(columns.length).toBeLessThanOrEqual(4)
    expect(new Set(columns.map(c => c.id)).size).toBe(columns.length)
  })

  it.each(ALL_METHODS)('%s orders all four signals exactly once', (method) => {
    const order = BOARD_RULES[method].signalOrder
    expect([...order].sort()).toEqual([...ALL_SIGNALS].sort())
  })

  it.each(ALL_METHODS)('%s always offers somewhere to finish work', (method) => {
    // A board with no done column can never show completion, which breaks progress.
    expect(BOARD_RULES[method].columns.some(c => c.source === 'status:done')).toBe(true)
  })

  it.each(ALL_METHODS)('%s has non-empty copy in both languages', (method) => {
    const r = BOARD_RULES[method]
    for (const field of [r.boardTitle, r.itemNoun, r.addLabel, r.emptyState]) {
      expect(field.he.trim().length).toBeGreaterThan(0)
      expect(field.en.trim().length).toBeGreaterThan(0)
    }
  })

  it.each(ALL_METHODS)('%s writes its Hebrew copy in actual Hebrew', (method) => {
    expect(BOARD_RULES[method].emptyState.he).toMatch(/[֐-׿]/)
  })
})

describe('derived columns are read-only lenses, never drop targets', () => {
  it('never marks a derived column droppable — you become urgent, you do not get dragged there', () => {
    for (const method of ALL_METHODS) {
      for (const c of BOARD_RULES[method].columns) {
        if (c.source.startsWith('derived:')) expect(c.droppable).toBe(false)
      }
    }
  })

  it('hides derived columns when empty and keeps status columns in place', () => {
    for (const method of ALL_METHODS) {
      for (const c of BOARD_RULES[method].columns) {
        expect(c.hideWhenEmpty).toBe(c.source.startsWith('derived:'))
      }
    }
  })

  it('makes every status column droppable, since dropping is just a status write', () => {
    for (const method of ALL_METHODS) {
      for (const c of BOARD_RULES[method].columns) {
        if (c.source.startsWith('status:')) expect(c.droppable).toBe(true)
      }
    }
  })
})

describe('rows keep the promise their method label makes on screen', () => {
  it('gives the_one_thing a WIP of 1 and no backlog column', () => {
    const r = BOARD_RULES.the_one_thing
    expect(r.wipLimit).toBe(1)
    expect(r.columns.some(c => c.source === 'status:pending')).toBe(false)
  })

  it('gives deep_work a WIP of 1, because "uninterrupted" and "two at once" contradict', () => {
    expect(BOARD_RULES.deep_work.wipLimit).toBe(1)
  })

  it('counts pomodoro in sessions, not hours — the calendar already says "פומודורו"', () => {
    expect(BOARD_RULES.pomodoro.investedUnit).toBe('sessions')
  })

  it('leads kanban with progress and caps work in flight, which is the method itself', () => {
    expect(BOARD_RULES.kanban.signalOrder[0]).toBe('progress')
    expect(BOARD_RULES.kanban.wipLimit).toBeGreaterThan(0)
  })

  it('leads gtd with the next action, which is literally its question', () => {
    expect(BOARD_RULES.gtd.signalOrder[0]).toBe('next')
    expect(BOARD_RULES.gtd.nextStep).toBe('next_action')
  })

  it('gives the cyclic methods a cycle length and everyone else none', () => {
    expect(BOARD_RULES.okr.cycleDays).toBe(90)
    expect(BOARD_RULES.twelve_week_year.cycleDays).toBe(84)
    expect(BOARD_RULES.scrum.cycleDays).toBe(14)
    expect(BOARD_RULES.weekly_review.cycleDays).toBe(7)
    expect(BOARD_RULES.pomodoro.cycleDays).toBeNull()
  })
})

describe('boardRulesFor degrades instead of throwing', () => {
  it('falls back for a method string the live volume might still contain', () => {
    expect(boardRulesFor('minimax_method_from_2024')).toBe(BOARD_RULES.time_blocking)
  })

  it('falls back for undefined rather than returning an undefined row', () => {
    expect(boardRulesFor(undefined)).toBe(BOARD_RULES.time_blocking)
  })

  it('never lets a prototype key masquerade as a method', () => {
    // 'constructor' is in every object; `method in BOARD_RULES` must not accept it.
    const rules = boardRulesFor('constructor')
    expect(rules).toBe(BOARD_RULES.time_blocking)
  })

  it('returns a fresh signal array so a caller cannot mutate the table', () => {
    const order = signalOrderFor('kanban')
    order.reverse()
    expect(BOARD_RULES.kanban.signalOrder[0]).toBe('progress')
  })
})

describe('the anti-drift rule', () => {
  it('stores no session length, so this cannot become the third copy of that number', () => {
    for (const method of ALL_METHODS) {
      const row = BOARD_RULES[method] as unknown as Record<string, unknown>
      expect(row.sessionMinutes).toBeUndefined()
      expect(row.defaultTaskHours).toBeUndefined()
    }
  })
})
