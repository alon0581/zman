/**
 * executeTool.identity.test.ts — the tool dispatcher survived being moved.
 *
 * `executeTool` and its helpers were lifted out of `src/app/api/chat/route.ts`
 * without a line changing, because a route file may export nothing but HTTP
 * handlers and Next's route config — so the second caller could never have
 * reached it where it was.
 *
 * A pure move still needs a witness. This file pins the dispatcher's boundary
 * rather than its 1,600 lines of tool bodies: the three fail-closed flag guards,
 * the unknown-tool default, the input validation that runs before any storage is
 * touched, and one tool that writes and reports it (`save_memory`), which is
 * what proves the `state` bag the SSE stream reads is still being filled.
 *
 * `jsonStore` is mocked, so nothing here touches the live Railway volume.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AIMemory, CalendarEvent, UserProfile } from '@/types'
import { PHASE_ONLY_TOOLS, PROJECT_ONLY_TOOLS, V2_ONLY_TOOLS } from '@/lib/ai/tools'

const files = vi.hoisted(() => new Map<string, unknown>())
vi.mock('@/lib/util/jsonStore', () => ({
  readJsonFile: (file: string, fallback: unknown) => (files.has(file) ? files.get(file) : fallback),
  writeJsonFileAtomic: (file: string, data: unknown) => { files.set(file, data) },
}))

import { executeTool, memoryFile, type ToolState } from './executeTool'

// ── Fixtures ────────────────────────────────────────────────────────────────

const freshState = (): ToolState =>
  ({ completedProfile: null, memoryUpdated: false, tasksUpdated: false, projectsUpdated: false })

type CallOver = {
  events?: CalendarEvent[]
  created?: CalendarEvent[]
  updated?: CalendarEvent[]
  deleted?: string[]
  profile?: UserProfile | null
  state?: ToolState
}

/** Same positional call the loop makes, so the arity itself is under test. */
const call = (name: string, input: Record<string, unknown> = {}, over: CallOver = {}) =>
  executeTool(
    name, input, 'u-test',
    over.events ?? [], over.created ?? [], over.updated ?? [], over.deleted ?? [],
    over.profile ?? null, over.state ?? freshState(),
    undefined, undefined, new Date('2026-08-18T09:00:00'), undefined,
  )

const ENV_KEYS = ['SCHEDULER_V2', 'PROJECTS', 'PHASES'] as const
const ORIGINAL = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))

beforeEach(() => {
  files.clear()
  for (const key of ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.restoreAllMocks()
})

// ── The fail-closed guards ──────────────────────────────────────────────────

describe('a tool whose flag is off is refused by name', () => {
  // A stale transcript can still name a tool the flag has since turned off. It
  // must fail loudly rather than silently doing nothing, which is how a user
  // ends up thanked for work that never happened.
  it('refuses every V2-only tool when the engine path is off', async () => {
    expect(V2_ONLY_TOOLS.size).toBeGreaterThan(0)
    for (const name of V2_ONLY_TOOLS) {
      expect(await call(name), name).toEqual({ error: 'unknown_tool', message: `Unknown tool: ${name}` })
    }
  })

  it('refuses every projects-only tool when PROJECTS is off', async () => {
    expect(PROJECT_ONLY_TOOLS.size).toBeGreaterThan(0)
    for (const name of PROJECT_ONLY_TOOLS) {
      expect(await call(name), name).toEqual({ error: 'unknown_tool', message: `Unknown tool: ${name}` })
    }
  })

  it('refuses every phase-only tool when PHASES is off', async () => {
    expect(PHASE_ONLY_TOOLS.size).toBeGreaterThan(0)
    for (const name of PHASE_ONLY_TOOLS) {
      expect(await call(name), name).toEqual({ error: 'unknown_tool', message: `Unknown tool: ${name}` })
    }
  })

  it('answers a name it has never heard of with the default branch', async () => {
    // Deliberately a different shape from the flag refusals above: this one is
    // a bug in the model's output, not a flag state.
    expect(await call('summon_a_pony')).toEqual({ error: 'Unknown tool: summon_a_pony' })
  })
})

// ── Validation runs before storage ──────────────────────────────────────────

describe('create_event rejects bad input without writing anything', () => {
  it('needs a title and both times', async () => {
    expect(await call('create_event', { title: 'ריצה' }))
      .toEqual({ error: 'missing_required_fields', message: 'title, start_time, and end_time are required' })
  })

  it('needs the times to parse', async () => {
    expect(await call('create_event', { title: 'ריצה', start_time: 'מחר', end_time: 'אחר כך' }))
      .toEqual({ error: 'invalid_date', message: 'start_time or end_time is not a valid date' })
  })

  it('needs the end after the start', async () => {
    expect(await call('create_event', {
      title: 'ריצה', start_time: '2026-08-18T10:00:00', end_time: '2026-08-18T09:00:00',
    })).toEqual({ error: 'invalid_range', message: 'end_time must be after start_time' })
  })

  it('leaves the created array untouched when it refuses', async () => {
    const created: CalendarEvent[] = []
    await call('create_event', { title: '' }, { created })
    expect(created).toEqual([])
    expect(files.size).toBe(0)
  })
})

describe('save_memory guards the size of what it stores', () => {
  it('needs a non-empty array', async () => {
    expect(await call('save_memory', { entries: [] }))
      .toEqual({ error: 'invalid_entries', message: 'entries must be a non-empty array' })
  })

  it('needs string keys and values', async () => {
    expect(await call('save_memory', { entries: [{ key: 'k', value: 42 }] }))
      .toEqual({ error: 'invalid_entry', message: 'each entry needs string key and value' })
  })

  it('caps the key at 100 characters', async () => {
    expect(await call('save_memory', { entries: [{ key: 'k'.repeat(101), value: 'v' }] }))
      .toEqual({ error: 'key_length', message: 'key must be 1–100 chars' })
  })

  it('caps the value at 10000 characters', async () => {
    expect(await call('save_memory', { entries: [{ key: 'k', value: 'v'.repeat(10001) }] }))
      .toEqual({ error: 'value_too_large', message: 'value must be ≤ 10000 chars' })
  })
})

// ── The state bag the stream reads ──────────────────────────────────────────

describe('save_memory writes and reports it', () => {
  it('sets memoryUpdated on the shared state object', async () => {
    const state = freshState()
    const result = await call('save_memory', { entries: [{ key: 'wake_time', value: '07:00' }] }, { state })

    expect(result).toEqual({ success: true, saved: 1 })
    expect(state.memoryUpdated).toBe(true)
    expect(state.tasksUpdated).toBe(false)
    expect(state.projectsUpdated).toBe(false)
  })

  it('overwrites by key and preserves created_at, which is FIRST-seen and not a recency signal', async () => {
    const file = memoryFile('u-test')
    files.set(file, [{
      id: 'm-1', user_id: 'u-test', key: 'wake_time', value: '09:00',
      learned_from: 'behavior', created_at: '2020-01-01T00:00:00.000Z',
    }] as AIMemory[])

    await call('save_memory', { entries: [{ key: 'wake_time', value: '07:00' }] })

    const stored = files.get(file) as AIMemory[]
    expect(stored).toHaveLength(1)
    expect(stored[0].id).toBe('m-1')
    expect(stored[0].value).toBe('07:00')
    expect(stored[0].created_at).toBe('2020-01-01T00:00:00.000Z')
    // updated_at exists precisely because created_at may not move.
    expect(stored[0].updated_at).toBeTruthy()
  })

  it('files a fact as timeless while PHASES is off', async () => {
    await call('save_memory', { entries: [{ key: 'wake_time', value: '07:00' }] })
    const stored = files.get(memoryFile('u-test')) as AIMemory[]
    expect(stored[0].phase_id).toBeUndefined()
  })
})

describe('memoryFile', () => {
  it('lands under the user directory', async () => {
    expect(memoryFile('u-test').replace(/\\/g, '/')).toMatch(/\/users\/u-test\/memory\.json$/)
  })

  it('refuses a userId that would escape the data directory', () => {
    // Every path built from a userId runs through assertSafeUserId first.
    expect(() => memoryFile('../../etc')).toThrow(/Invalid userId/)
  })
})
