import { describe, expect, it } from 'vitest'
import { FOLLOWUP_MIN_CHARS, followupPrompt, needsFollowup } from './followup'

/**
 * The regression these tests exist for: the Anthropic path only re-prompted on a
 * *completely empty* reply, while the OpenAI path also caught short-but-nonempty.
 * Anthropic is the default provider, so "בוצע!" after three tool calls reached
 * the user unchallenged. There is now one rule, and these are its cases.
 */
describe('needsFollowup', () => {
  it('catches the empty reply after tool calls (the old Anthropic-only case)', () => {
    expect(needsFollowup('', 1)).toBe(true)
    expect(needsFollowup(null, 2)).toBe(true)
    expect(needsFollowup(undefined, 2)).toBe(true)
  })

  it('catches the short reply after tool calls (the case Anthropic used to miss)', () => {
    expect(needsFollowup('בוצע!', 1)).toBe(true)
    expect(needsFollowup('Done!', 3)).toBe(true)
    expect(needsFollowup('✓', 1)).toBe(true)
  })

  it('counts whitespace as nothing, so " " is still too thin', () => {
    expect(needsFollowup('   \n  ', 1)).toBe(true)
  })

  it('leaves a real answer alone', () => {
    expect(needsFollowup('קבעתי שלוש ישיבות לימוד בשעות הבוקר, לפני הבחינה ביום חמישי.', 2)).toBe(false)
  })

  it('never fires on a turn that used no tools — a short chat reply is fine', () => {
    // This is why the gate is toolCallsMade and not iteration count: "כן" is a
    // complete answer to "רוצה שאזכיר לך?" and must not trigger a second call.
    expect(needsFollowup('כן', 0)).toBe(false)
    expect(needsFollowup('', 0)).toBe(false)
    expect(needsFollowup('Sure.', 0)).toBe(false)
  })

  it('uses one threshold for both providers', () => {
    const justUnder = 'x'.repeat(FOLLOWUP_MIN_CHARS - 1)
    const exactly = 'x'.repeat(FOLLOWUP_MIN_CHARS)
    expect(needsFollowup(justUnder, 1)).toBe(true)
    expect(needsFollowup(exactly, 1)).toBe(false)
  })
})

describe('followupPrompt', () => {
  it('asks in the user\'s language and demands honesty about failures', () => {
    expect(followupPrompt(true)).toMatch(/[֐-׿]/)
    expect(followupPrompt(true)).toMatch(/לא הצליח/)
    expect(followupPrompt(false)).not.toMatch(/[֐-׿]/)
    expect(followupPrompt(false)).toMatch(/failed/)
  })
})
