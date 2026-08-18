/**
 * profileMirror.test.ts
 *
 * This exists for one bug: `memory.json` contradicting `profile.json` forever.
 *
 * The mirroring used to run only on the one-time transition to
 * `onboarding_completed`, so every later Settings save wrote the profile alone.
 * Change `productivity_peak` from morning to evening and the profile said evening
 * while a `productivity_peak: morning` row kept being injected into every prompt —
 * and since AIMemory carries no readable timestamp, the model had nothing to
 * arbitrate with. It believed whichever it read last.
 *
 * These tests are filesystem-backed because that is what the function is: the
 * whole point is the write actually landing. DATA_DIR is redirected to a temp dir
 * before the module under test is imported, since it reads the env at load.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { AIMemory, UserProfile } from '@/types'

const TMP = path.join(os.tmpdir(), `zman-mirror-test-${process.pid}`)
const USER = 'mirror-test-user'

// DATA_DIR is read at module load, so it must be set before the dynamic import.
process.env.DATA_DIR = TMP

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mirrorProfileToMemory: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let MIRRORED_KEYS: any

beforeAll(async () => {
  fs.mkdirSync(path.join(TMP, 'users', USER), { recursive: true })
  const mod = await import('./profileMirror')
  mirrorProfileToMemory = mod.mirrorProfileToMemory
  MIRRORED_KEYS = mod.MIRRORED_KEYS
})

afterEach(() => {
  const f = memFile()
  if (fs.existsSync(f)) fs.rmSync(f)
})

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

function memFile(): string {
  return path.join(TMP, 'users', USER, 'memory.json')
}

function readMem(): AIMemory[] {
  if (!fs.existsSync(memFile())) return []
  return JSON.parse(fs.readFileSync(memFile(), 'utf-8'))
}

function writeMem(rows: AIMemory[]): void {
  fs.writeFileSync(memFile(), JSON.stringify(rows, null, 2))
}

function profile(over: Partial<UserProfile> = {}): UserProfile {
  return {
    user_id: USER,
    autonomy_mode: 'hybrid',
    theme: 'dark',
    language: 'he',
    onboarding_completed: true,
    ...over,
  } as UserProfile
}

const valueOf = (key: string) => readMem().find(m => m.key === key)?.value

describe('the divergence this exists to close', () => {
  it('overwrites a stale row instead of leaving both values in memory', () => {
    writeMem([{
      id: 'old', user_id: USER, key: 'productivity_peak', value: 'morning',
      learned_from: 'onboarding', created_at: '2026-01-01T00:00:00.000Z',
    }])

    mirrorProfileToMemory(USER, profile({ productivity_peak: 'evening' }), ['productivity_peak'])

    const rows = readMem().filter(m => m.key === 'productivity_peak')
    expect(rows).toHaveLength(1)
    expect(rows[0].value).toBe('evening')
  })

  it('preserves created_at on overwrite, because it means FIRST seen', () => {
    writeMem([{
      id: 'old', user_id: USER, key: 'occupation', value: 'סטודנט',
      learned_from: 'onboarding', created_at: '2026-01-01T00:00:00.000Z',
    }])

    mirrorProfileToMemory(USER, profile({ occupation: 'ברמן' }), ['occupation'])

    const row = readMem().find(m => m.key === 'occupation')!
    expect(row.value).toBe('ברמן')
    expect(row.created_at).toBe('2026-01-01T00:00:00.000Z')
    expect(row.id).toBe('old')
  })
})

describe('what gets written', () => {
  it('writes only the fields named, so one toggle does not rewrite seven rows', () => {
    mirrorProfileToMemory(
      USER,
      profile({ occupation: 'ברמן', productivity_peak: 'evening', wake_time: '09:00' }),
      ['occupation'],
    )
    expect(readMem().map(m => m.key)).toEqual(['occupation'])
  })

  it('mirrors everything present when no field list is given', () => {
    mirrorProfileToMemory(USER, profile({ occupation: 'ברמן', productivity_peak: 'evening' }))
    const keys = readMem().map(m => m.key).sort()
    expect(keys).toEqual(['occupation', 'productivity_peak'])
  })

  it('joins an array field rather than writing [object Object]', () => {
    mirrorProfileToMemory(USER, profile({ secondary_methods: ['kanban', 'gtd'] }), ['secondary_methods'])
    expect(valueOf('secondary_methods')).toBe('kanban, gtd')
  })

  it('skips absent and empty values instead of writing blanks', () => {
    mirrorProfileToMemory(USER, profile({ occupation: '' }), ['occupation', 'productivity_peak'])
    expect(readMem()).toHaveLength(0)
  })

  it('skips an empty array rather than writing an empty string', () => {
    mirrorProfileToMemory(USER, profile({ secondary_methods: [] }), ['secondary_methods'])
    expect(readMem()).toHaveLength(0)
  })

  it('keeps Hebrew values intact through the round trip', () => {
    mirrorProfileToMemory(USER, profile({ occupation: 'סטודנט להנדסת חשמל' }), ['occupation'])
    expect(valueOf('occupation')).toBe('סטודנט להנדסת חשמל')
    expect(valueOf('occupation')).toMatch(/[֐-׿]/)
  })

  it('ignores a profile field that is not mirrored at all', () => {
    // `theme` is not in MIRRORED_KEYS and must never reach the prompt as a fact.
    mirrorProfileToMemory(USER, profile({ theme: 'light' }), ['theme'] as never)
    expect(readMem()).toHaveLength(0)
  })
})

describe('it never breaks the save that triggered it', () => {
  it('returns the keys it wrote, so a caller can report them', () => {
    const written = mirrorProfileToMemory(
      USER, profile({ occupation: 'ברמן', wake_time: '09:00' }), ['occupation', 'wake_time'],
    )
    expect([...written].sort()).toEqual(['occupation', 'wake_time'])
  })

  it('returns an empty array rather than throwing when there is nothing to write', () => {
    expect(mirrorProfileToMemory(USER, profile(), ['occupation'])).toEqual([])
  })

  it('swallows a bad user id instead of failing the profile write', () => {
    // assertSafeUserId throws on this; mirroring must not take the request down.
    expect(() => mirrorProfileToMemory('../escape', profile({ occupation: 'x' }), ['occupation'])).not.toThrow()
  })
})

describe('the mirrored key set', () => {
  it('maps every field to a key the prompt actually categorises', () => {
    // A key PROFILE_CATEGORIES does not recognise lands in the low-signal [Other]
    // bucket and is the first thing dropped at the cap — mirroring it would be
    // work for nothing.
    const recognised = /^(occupation|study_field|university|year_of_study|role|location|name|persona|wake_time|sleep_time|productivity_peak|energy|commute|day_structure|recurring_|work_hours|free_days|weekly_free|pref_|prefers_|main_challenge|relationship|family|hobby|volunteer|social|current_goal|goal|ongoing_|upcoming_focus|scheduling_method|secondary_methods|method_feedback|pattern_)/
    for (const { key } of MIRRORED_KEYS) {
      expect(recognised.test(key), `${key} is not recognised by PROFILE_CATEGORIES`).toBe(true)
    }
  })

  it('has no duplicate target keys', () => {
    const keys = MIRRORED_KEYS.map((m: { key: string }) => m.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
