/**
 * types.ts — the projects layer's own vocabulary.
 *
 * Two tables live here, and the rule that governs both is the one methodRules.ts
 * states for itself: a number that already exists somewhere else is DERIVED, never
 * re-typed. That is not a style preference. `METHOD_SESSION_HOURS`
 * (ai/schedulerTools.ts) and `METHOD_RULES[m].sessionMinutes` are already two
 * tables for one number and they disagree on 10 of 18 methods. This file does not
 * become the third copy — which is why there is no `defaultTaskHours` and no
 * `wipMinutes` below.
 */

import { Category } from '@/lib/scheduling/types'
import { ProjectKind } from '@/types'

// ── Kind rules ──────────────────────────────────────────────────────────────

export interface KindRule {
  /**
   * Does this kind normally carry a hard date? Drives whether an absent deadline
   * is a gap worth prompting about (`deliverable`) or simply the nature of the
   * thing (`build`). Never used to invent one.
   */
  expectsDeadline: boolean
  /** Engine category for blocks this project generates. */
  category: Category
  /** Seeded on creation. Hours are a starting guess the user is expected to edit. */
  template: { title: string; hours?: number }[]
  emoji: string
  label: { he: string; en: string }
}

/**
 * Exhaustive over ProjectKind, so a fourth kind is a compile error until it has
 * been thought about. Same forcing function as METHOD_RULES.
 */
export const KIND_RULES: Record<ProjectKind, KindRule> = {
  course: {
    expectsDeadline: true,
    category: 'study',
    emoji: '📚',
    label: { he: 'קורס', en: 'Course' },
    template: [
      { title: 'לקרוא את החומר', hours: 3 },
      { title: 'לפתור תרגילים', hours: 4 },
      { title: 'לחזור למבחן', hours: 5 },
    ],
  },
  deliverable: {
    expectsDeadline: true,
    category: 'work',
    emoji: '📄',
    label: { he: 'מטלה להגשה', en: 'Deliverable' },
    template: [
      { title: 'אפיון', hours: 2 },
      { title: 'טיוטה', hours: 4 },
      { title: 'הגשה', hours: 1 },
    ],
  },
  build: {
    // The one that earns its place: no deadline means risk is 'na', never green.
    expectsDeadline: false,
    category: 'work',
    emoji: '🛠️',
    label: { he: 'פרויקט', en: 'Build' },
    template: [
      { title: 'אפיון', hours: 2 },
      { title: 'מימוש', hours: 6 },
      { title: 'בדיקות', hours: 2 },
    ],
  },
}

// ── Card signals ────────────────────────────────────────────────────────────

export type CardSignal = 'deadline' | 'progress' | 'next' | 'invested'

/**
 * `na` and `unknown` are NOT the same, and conflating them is how a card ends up
 * looking broken when it is merely finite:
 *   na      — there is nothing to know (no deadline exists). Drop the signal.
 *   unknown — there IS something to know and we don't. Render grey with a "?".
 */
export type SignalState = 'ok' | 'warn' | 'risk' | 'unknown' | 'na'

export type SignalUnknownCode =
  | 'no_estimates'
  | 'partial_estimates'
  | 'no_tasks'
  | 'plan_unavailable'
  | 'not_scheduled'

export interface ResolvedSignal {
  signal: CardSignal
  state: SignalState
  /** Bilingual and already rendered. The card does no arithmetic and no phrasing. */
  text: { he: string; en: string }
  /** Present iff state === 'unknown'. Drives the tappable "?" affordance. */
  code?: SignalUnknownCode
}

/**
 * Ranks states worst-first. The invariant this exists to enforce: missing data may
 * only ever make a state WORSE, never better. There is no path from absent data
 * to 'ok'.
 */
const SEVERITY: Record<SignalState, number> = {
  risk: 0, warn: 1, unknown: 2, ok: 3, na: 4,
}

export function worseOf(a: SignalState, b: SignalState): SignalState {
  return SEVERITY[a] <= SEVERITY[b] ? a : b
}

// ── Board rules ─────────────────────────────────────────────────────────────

export type BoardColumnSource =
  | 'status:pending'
  | 'status:in_progress'
  | 'status:done'
  | 'derived:blocked'
  | 'derived:urgent'

export interface BoardColumn {
  id: string
  source: BoardColumnSource
  label: { he: string; en: string }
  /**
   * Status columns accept a drop (which is a status write). Derived columns are
   * read-only lenses: you cannot drag a task INTO "urgent", you become urgent.
   * Saying so beats shipping a drop target that silently does nothing.
   */
  droppable: boolean
  /** Derived columns vanish when empty; status columns hold their place. */
  hideWhenEmpty: boolean
}

export type NextStepKind =
  | 'next_scheduled_block'
  | 'earliest_deadline'
  | 'top_ranked'
  | 'oldest_in_progress'
  | 'next_action'

export interface BoardRules {
  /** 2-4, ordered. */
  columns: BoardColumn[]
  /** Warn above this many in status:in_progress. null = the method has no opinion. */
  wipLimit: number | null
  /**
   * All four signals, most to least prominent. signalOrder[0] IS the headline —
   * there is deliberately no separate `headline` field, because two fields that
   * can disagree is how you ship a card whose big number contradicts its config.
   */
  signalOrder: [CardSignal, CardSignal, CardSignal, CardSignal]
  nextStep: NextStepKind
  /** Session length itself comes from getMethodRules() — never re-typed here. */
  investedUnit: 'hours' | 'sessions'
  /** Methods with a fixed rhythm supply a deadline when the project has none. */
  cycleDays: number | null
  boardTitle: { he: string; en: string }
  itemNoun: { he: string; en: string }
  addLabel: { he: string; en: string }
  emptyState: { he: string; en: string }
}
