/**
 * scope.ts — the default life-phase scope for a memory key.
 *
 * `AIMemory.phase_id` is optional: present means "only true while that phase is
 * open", absent means timeless. The AI can set `phase_id` explicitly on any
 * entry it saves, but for the common case it doesn't think about scope at all —
 * it just calls save_memory with a key. This module is what fills in the
 * default for that common case, so it has to get the *default* right for keys
 * nobody thought hard about at save time.
 *
 * The key taxonomy below is not invented here — it mirrors two existing
 * sources of truth and must be kept in sync with both:
 *   - `PROFILE_CATEGORIES` in `src/lib/ai/systemPrompt.ts` (how keys are
 *     grouped for display in the injected Person Profile)
 *   - the `save_memory` tool description in `src/lib/ai/tools.ts` (how the
 *     taxonomy is explained to the model)
 *
 * ── THE MOST IMPORTANT RULE ────────────────────────────────────────────────
 * When a key matches neither the phase-scoped list nor the always list, the
 * default is 'always' (timeless). This is deliberate and must not be "fixed"
 * to phase-scope-by-default later.
 *
 * Reason: mis-scoping a timeless fact as phase-bound makes it VANISH the
 * moment the phase closes — the memory silently disappears from every future
 * prompt with no trace and no undo. That is exactly the failure phases exist
 * to prevent. Mis-scoping the other way (an actually-phase-bound fact
 * defaulting to 'always') just makes it LINGER — it stays visible in the
 * injected profile after the phase closes, which is a stale-but-visible
 * annoyance the user can remove with the × that already exists in Settings.
 * One failure is invisible and unrecoverable; the other is visible and
 * trivially correctable. When unsure, prefer the correctable one.
 *
 * This DELIBERATELY INVERTS the rule in `src/lib/projects/health.ts`
 * ("missing data may only ever make a state worse"). There the safe default
 * pushes a project's health signal toward pessimism (na/unknown never read as
 * 'ok'). Here the safe default pushes a memory toward retention (an unclassed
 * key never silently disappears). Both rules are the same principle — "never
 * claim more confidence than the data supports" — pointed in the direction
 * that makes THAT feature's failure mode recoverable. They will look like
 * contradictory advice side by side; they are not. Each is calibrated to what
 * "wrong" costs in its own feature.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Pure module: no fs, no fetch, no `new Date()`, no app imports beyond types.
 */

export type MemoryScope = 'phase' | 'always'

// ── Phase-scoped: true only while the phase that produced them is open. ─────
// Bare words are EXACT matches. Entries ending in the underscore are PREFIX
// matches (covers e.g. pattern_reject_early, recurring_gym_mon).
const PHASE_EXACT = new Set([
  'occupation', 'study_field', 'university', 'year_of_study', 'role', 'persona',
  'work_hours', 'free_days', 'weekly_free',
  'current_goal', 'goal', 'upcoming_focus',
  'day_structure', 'main_challenge', 'method_feedback',
  'scheduling_method', 'secondary_methods',
])
const PHASE_PREFIXES = ['recurring_', 'ongoing_', 'pattern_', 'pref_', 'prefers_', 'shift_']

// ── Always (timeless): true regardless of which phase, if any, is open. ─────
const ALWAYS_EXACT = new Set([
  'name', 'personal_name', 'relationship', 'birthday', 'location', 'social',
])
// Prefixes without a trailing underscore on purpose: 'hobby' must also catch
// the plural 'hobbies', 'family' must also catch bare 'family' and
// 'family_commitment', 'volunteer' must also catch 'volunteering'.
const ALWAYS_PREFIXES = ['family', 'hobby', 'health_', 'allergy', 'likes_', 'dislikes_', 'volunteer']

function startsWithAny(key: string, prefixes: string[]): boolean {
  return prefixes.some(p => key.startsWith(p))
}

/**
 * Default scope for a memory key. The AI may override per entry; this is what
 * applies when it doesn't. See the file header for why an unmatched key
 * resolves to 'always', not 'phase'.
 */
export function defaultScopeFor(key: string): MemoryScope {
  if (!key) return 'always'
  if (PHASE_EXACT.has(key)) return 'phase'
  if (ALWAYS_EXACT.has(key)) return 'always'
  if (startsWithAny(key, PHASE_PREFIXES)) return 'phase'
  if (startsWithAny(key, ALWAYS_PREFIXES)) return 'always'
  return 'always' // THE MOST IMPORTANT RULE — see file header.
}

// ── Restore-denied: phase-scoped keys that hide on close but must NEVER come
// back just because the same phase (or a same-named one) reopens. ──────────
// These are snapshots of what was in flight, not durable facts about the
// phase — a `current_goal` from four months ago is not "current" again just
// because the phase resumed. Exact words only, plus the one explicit prefix
// (`ongoing_`); no broad prefix on 'goal' itself, so a merely goal-*adjacent*
// key (e.g. 'goals_summary') is NOT swept in here by accident. That key still
// hides while its phase is closed (if defaultScopeFor puts it in 'phase' at
// all) — it is just allowed to come back on resume, which is the safe side
// for a key this module doesn't recognize as a snapshot-of-the-moment.
const RESTORE_DENIED_EXACT = new Set(['current_goal', 'goal', 'upcoming_focus'])
const RESTORE_DENIED_PREFIX = 'ongoing_'

/**
 * True for the "was in flight, do not resurrect" family: current_goal, goal,
 * ongoing_*, upcoming_focus. A phase-scoped memory in this family disappears
 * on close like any other, but reopening/resuming the phase must not bring it
 * back — see the doc comment above for why a near-miss like 'goals_summary'
 * is deliberately excluded.
 */
export function isRestoreDenied(key: string): boolean {
  if (!key) return false
  return RESTORE_DENIED_EXACT.has(key) || key.startsWith(RESTORE_DENIED_PREFIX)
}
