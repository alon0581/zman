import { describe, expect, it } from 'vitest'
import { defaultScopeFor, isRestoreDenied } from './scope'

/**
 * The regression these tests exist for: a memory key with no explicit scope
 * must never silently vanish. Phases hide phase-scoped facts once they close,
 * so scoping a *timeless* fact ("I have a fiancée") as phase-bound by mistake
 * deletes it from the user's profile with no trace and no undo the moment
 * some unrelated phase ends. The fallback direction is therefore load-bearing,
 * not an afterthought — these cases pin it down key by key.
 */
describe('defaultScopeFor', () => {
  it('scopes identity/role facts to the phase — the canonical phase example', () => {
    expect(defaultScopeFor('occupation')).toBe('phase')
    expect(defaultScopeFor('study_field')).toBe('phase')
    expect(defaultScopeFor('university')).toBe('phase')
    expect(defaultScopeFor('year_of_study')).toBe('phase')
    expect(defaultScopeFor('role')).toBe('phase')
    expect(defaultScopeFor('persona')).toBe('phase')
  })

  it('keeps relationship timeless while occupation is phase-scoped — the canonical pair from the product brief', () => {
    expect(defaultScopeFor('relationship')).toBe('always')
    expect(defaultScopeFor('occupation')).toBe('phase')
  })

  it('scopes fixed-commitment and goal facts to the phase', () => {
    expect(defaultScopeFor('work_hours')).toBe('phase')
    expect(defaultScopeFor('free_days')).toBe('phase')
    expect(defaultScopeFor('weekly_free')).toBe('phase')
    expect(defaultScopeFor('current_goal')).toBe('phase')
    expect(defaultScopeFor('goal')).toBe('phase')
    expect(defaultScopeFor('upcoming_focus')).toBe('phase')
  })

  it('keeps identity/relationship/life facts timeless — facts true no matter what phase is open', () => {
    expect(defaultScopeFor('name')).toBe('always')
    expect(defaultScopeFor('personal_name')).toBe('always')
    expect(defaultScopeFor('birthday')).toBe('always')
    expect(defaultScopeFor('location')).toBe('always')
    expect(defaultScopeFor('social')).toBe('always')
  })

  it('matches pattern_* and recurring_* by prefix, not just the bare exact key', () => {
    expect(defaultScopeFor('pattern_reject_early')).toBe('phase')
    expect(defaultScopeFor('pattern_morning_study')).toBe('phase')
    expect(defaultScopeFor('recurring_gym_mon')).toBe('phase')
    expect(defaultScopeFor('recurring_class_algebra')).toBe('phase')
  })

  it('matches family/hobby/volunteer facts by prefix as timeless — Hebrew value, English key', () => {
    expect(defaultScopeFor('family_commitment')).toBe('always')
    expect(defaultScopeFor('hobbies')).toBe('always')
    expect(defaultScopeFor('volunteering')).toBe('always')
    // The value itself may be Hebrew; scoping only looks at the key.
    void 'מתנדב בבית חולים ילדים'
  })

  it('an unmatched key stays timeless, because vanishing beats lingering as a failure mode', () => {
    // wake_time is a real taxonomy key (Rhythm, from PROFILE_CATEGORIES) that
    // this feature's phase/always lists never mention — exactly the case the
    // fallback exists for, not a made-up string.
    expect(defaultScopeFor('wake_time')).toBe('always')
    expect(defaultScopeFor('productivity_peak')).toBe('always')
    expect(defaultScopeFor('totally_made_up_key_xyz')).toBe('always')
  })

  it('does not throw on an empty string or a weird key, and still returns a scope', () => {
    expect(defaultScopeFor('')).toBe('always')
    expect(defaultScopeFor('   ')).toBe('always')
    expect(defaultScopeFor('🎉_not_a_real_key!!')).toBe('always')
    expect(defaultScopeFor('CURRENT_GOAL')).toBe('always') // case-sensitive on purpose: keys are snake_case
  })
})

/**
 * The regression these tests exist for: resuming a closed phase must not
 * resurrect a stale in-flight snapshot ("current_goal" from four months ago
 * reappearing as if it were still current). That is this feature's single
 * worst failure mode, so every member of the family gets its own assertion —
 * a passing test on three of four would still ship the bug.
 */
describe('isRestoreDenied', () => {
  it('denies restore for all four in-flight families: current_goal, goal, ongoing_*, upcoming_focus', () => {
    expect(isRestoreDenied('current_goal')).toBe(true)
    expect(isRestoreDenied('goal')).toBe(true)
    expect(isRestoreDenied('ongoing_task')).toBe(true)
    expect(isRestoreDenied('ongoing_project_thesis')).toBe(true)
    expect(isRestoreDenied('upcoming_focus')).toBe(true)
  })

  it('rejects the goal-adjacent lookalike "goals_summary" — a near-miss must not be swept in by a loose prefix', () => {
    // Pinned behaviour: 'goal' matches exactly, not as a prefix, so a key
    // that merely starts with "goal" does not count as an in-flight snapshot.
    expect(isRestoreDenied('goals_summary')).toBe(false)
  })

  it('does not deny restore for phase-scoped keys outside the in-flight family', () => {
    expect(isRestoreDenied('occupation')).toBe(false)
    expect(isRestoreDenied('pattern_reject_early')).toBe(false)
    expect(isRestoreDenied('recurring_gym_mon')).toBe(false)
  })

  it('does not throw on an empty string or a weird key, and still returns a boolean', () => {
    expect(isRestoreDenied('')).toBe(false)
    expect(isRestoreDenied('   ')).toBe(false)
    expect(isRestoreDenied('🎉_not_a_real_key!!')).toBe(false)
  })
})
