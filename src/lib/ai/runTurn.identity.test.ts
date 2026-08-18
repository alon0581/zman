/**
 * runTurn.identity.test.ts — the brain still behaves exactly as it did inside
 * the route handler.
 *
 * `runTurn` is the POST handler's tool-call loop, lifted out unchanged. The
 * extraction rests on one structural claim, and this file is where it is
 * checked: the loop runs to completion BEFORE any byte is streamed, so the turn
 * is a plain `async` function returning a finished value, with no interleaving
 * between deciding and reporting. Every assertion below is about the value it
 * returns and the calls it makes — never about a stream, because by design there
 * isn't one here any more.
 *
 * The Anthropic client is scripted (mocked at the SDK boundary, so the dynamic
 * `import('@anthropic-ai/sdk')` inside the loop is intercepted) and `executeTool`
 * is mocked, because the thing under test is the WIRING: that the dispatcher is
 * still handed the same thirteen arguments in the same order, that whatever it
 * mutates still comes back out, and that the four odd paths — follow-up retry,
 * iteration cap, wall-clock ceiling, provider failure — still produce the exact
 * strings a user would have seen before the move.
 *
 * The dispatcher's own behaviour is pinned separately, in
 * `executeTool.identity.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarEvent, UserProfile } from '@/types'
import { FOLLOWUP_MIN_CHARS, followupPrompt } from '@/lib/ai/followup'

// Runs BEFORE the imports below, so the module-load-time constants inside
// runTurn.ts (max tokens, the 90s ceiling, the default model) are read from a
// known-clean environment rather than from whatever the developer has exported.
vi.hoisted(() => {
  for (const key of [
    'AI_MODEL', 'AI_EFFORT', 'ANTHROPIC_MAX_TOKENS', 'MAX_LOOP_MS',
    'SCHEDULER_V2', 'PROJECTS', 'PHASES',
  ]) delete process.env[key]
})

// ── The scripted provider ───────────────────────────────────────────────────

type Scripted = Record<string, unknown> | ((params: Record<string, unknown>) => never)

const anthropic = vi.hoisted(() => ({
  script: [] as Scripted[],
  requests: [] as Record<string, unknown>[],
  keys: [] as string[],
}))

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages: { create: (params: Record<string, unknown>) => Promise<Record<string, unknown>> }
    constructor(opts: { apiKey: string }) {
      anthropic.keys.push(opts.apiKey)
      this.messages = {
        create: async (params: Record<string, unknown>) => {
          anthropic.requests.push(params)
          const next = anthropic.script.shift()
          if (!next) throw new Error('anthropic script exhausted')
          if (typeof next === 'function') return next(params)
          return next
        },
      }
    }
  }
  return { default: FakeAnthropic }
})

// ── The mocked seams ────────────────────────────────────────────────────────

const executeToolMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/ai/executeTool', () => ({
  executeTool: executeToolMock,
  memoryFile: (userId: string) => `memory:${userId}`,
}))

const files = vi.hoisted(() => new Map<string, unknown>())
vi.mock('@/lib/util/jsonStore', () => ({
  readJsonFile: (file: string, fallback: unknown) => {
    const key = file.replace(/\\/g, '/').split('/').slice(-1)[0]
    return files.has(file) ? files.get(file) : files.has(key) ? files.get(key) : fallback
  },
  writeJsonFileAtomic: (file: string, data: unknown) => { files.set(file, data) },
}))

vi.mock('@/lib/feedback/store', () => ({
  readFeedback: () => [],
  recordFeedback: () => {},
}))

import { MAX_LOOP_MS, runTurn, type RunTurnInput } from './runTurn'

// ── Fixtures ────────────────────────────────────────────────────────────────

const textReply = (text: string) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text }],
  usage: { input_tokens: 10, cache_read_input_tokens: 0 },
})

const toolCall = (name: string, input: Record<string, unknown> = {}, id = 'tu-1') => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id, name, input }],
})

/** No text block at all — the shape that makes the backstop necessary. */
const silentReply = () => ({ stop_reason: 'end_turn', content: [] })

const input = (over: Partial<RunTurnInput> = {}): RunTurnInput => ({
  userId: 'u-test',
  messages: [{ role: 'user', content: 'תקבע לי אימון מחר' }],
  events: [],
  profile: null,
  timezone: 'Asia/Jerusalem',
  apiKey: 'sk-test',
  ...over,
})

beforeEach(() => {
  anthropic.script = []
  anthropic.requests = []
  anthropic.keys = []
  files.clear()
  executeToolMock.mockReset()
  executeToolMock.mockResolvedValue({ ok: true })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ── The plain turn ──────────────────────────────────────────────────────────

describe('a turn with no tool calls', () => {
  it('returns the model text and leaves every flag false', async () => {
    anthropic.script = [textReply('קבעתי לך אימון מחר ב-18:00')]
    const result = await runTurn(input())

    expect(result).toEqual({
      text: 'קבעתי לך אימון מחר ב-18:00',
      fallbackText: '✓ בוצע',
      createdEvents: [],
      updatedEvents: [],
      deletedEventIds: [],
      memoryUpdated: false,
      tasksUpdated: false,
      projectsUpdated: false,
      completedProfile: null,
    })
    expect(executeToolMock).not.toHaveBeenCalled()
  })

  it('opens the client with the caller-supplied key, never an env read of its own', async () => {
    anthropic.script = [textReply('ok')]
    await runTurn(input({ apiKey: 'sk-from-caller' }))
    expect(anthropic.keys).toEqual(['sk-from-caller'])
  })

  it('sends the request the chat route has always sent', async () => {
    anthropic.script = [textReply('ok')]
    await runTurn(input())

    const req = anthropic.requests[0]
    expect(req.model).toBe('claude-sonnet-5')
    // 8192, not 2048: on Sonnet 5 max_tokens caps thinking PLUS the reply, and
    // the old budget got eaten by the thinking, truncating answers mid-sentence.
    expect(req.max_tokens).toBe(8192)
    // effort is `medium` while the model still does placement reasoning itself.
    expect(req.output_config).toEqual({ effort: 'medium' })
    // Sonnet 5 rejects non-default sampling parameters outright.
    expect(req).not.toHaveProperty('temperature')
    expect(req).not.toHaveProperty('top_p')
    expect(req).not.toHaveProperty('top_k')
  })

  it('caches only the static half of the system prompt', async () => {
    anthropic.script = [textReply('ok')]
    await runTurn(input())

    const system = anthropic.requests[0].system as Array<Record<string, unknown>>
    expect(system.length).toBeGreaterThanOrEqual(1)
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' })
    // Anything that varies per request must NOT be inside the cached block, or
    // every user pays a cache miss on every turn.
    for (const block of system.slice(1)) expect(block.cache_control).toBeUndefined()
  })

  it('offers the onboarding tool list when the turn is an onboarding turn', async () => {
    anthropic.script = [textReply('ok')]
    await runTurn(input({ isOnboarding: true }))
    const names = (anthropic.requests[0].tools as Array<{ name: string }>).map(t => t.name)
    expect(names).toContain('complete_onboarding')
  })

  it('offers the calendar tool list otherwise', async () => {
    anthropic.script = [textReply('ok')]
    await runTurn(input())
    const names = (anthropic.requests[0].tools as Array<{ name: string }>).map(t => t.name)
    expect(names).toContain('create_event')
    expect(names).not.toContain('complete_onboarding')
  })
})

// ── The dispatcher call site ────────────────────────────────────────────────

describe('what the loop hands to executeTool', () => {
  it('passes the same thirteen positional arguments, in the same order', async () => {
    const events = [{ id: 'existing' }] as unknown as CalendarEvent[]
    files.set('profile.json', { user_id: 'u-test', language: 'en', push_subscription: 'sub-1', fcm_token: 'fcm-1' })

    anthropic.script = [toolCall('create_event', { title: 'ריצה' }), textReply('done')]
    await runTurn(input({ events, profile: { user_id: 'u-test', language: 'he' } as UserProfile }))

    expect(executeToolMock).toHaveBeenCalledTimes(1)
    const args = executeToolMock.mock.calls[0]
    expect(args).toHaveLength(13)
    expect(args[0]).toBe('create_event')
    expect(args[1]).toEqual({ title: 'ריצה' })
    expect(args[2]).toBe('u-test')
    expect(args[3]).toBe(events)
    expect(args[4]).toEqual([])   // createdEvents
    expect(args[5]).toEqual([])   // updatedEvents
    expect(args[6]).toEqual([])   // deletedEventIds
    // The SERVER's profile, not the client's — the turn that changes your hours
    // must not be the one turn that reasons from the old ones.
    expect((args[7] as UserProfile).language).toBe('en')
    expect(args[8]).toEqual({ completedProfile: null, memoryUpdated: false, tasksUpdated: false, projectsUpdated: false })
    expect(args[9]).toBe('sub-1')
    expect(args[10]).toBe('fcm-1')
    expect(args[11]).toBeInstanceOf(Date)
    expect(args[12]).toMatchObject({ enabled: false, timezone: 'Asia/Jerusalem' })
  })

  it('falls back to the client profile when the server has none', async () => {
    anthropic.script = [toolCall('create_event'), textReply('done')]
    const clientProfile = { user_id: 'u-test', language: 'en' } as UserProfile
    await runTurn(input({ profile: clientProfile }))
    expect(executeToolMock.mock.calls[0][7]).toBe(clientProfile)
  })

  it('reads memory from disk rather than trusting the client body', async () => {
    // The client loads memory async on mount, so a fast first message POSTs an
    // empty array — and the assistant "forgets" the user across sessions.
    files.set('memory:u-test', [{ key: 'server', value: 'wins' }])
    anthropic.script = [toolCall('save_memory'), textReply('done')]
    await runTurn(input({ memory: [{ key: 'client', value: 'loses' }] }))

    expect(executeToolMock.mock.calls[0][12]).toMatchObject({
      memory: [{ key: 'server', value: 'wins' }],
    })
  })

  it('surfaces everything the dispatcher mutated', async () => {
    const created = { id: 'c1' } as CalendarEvent
    const updated = { id: 'u1' } as CalendarEvent
    const finished = { user_id: 'u-test' } as UserProfile

    executeToolMock.mockImplementation(async (
      _name: string, _in: unknown, _uid: string, _ev: unknown,
      createdEvents: CalendarEvent[], updatedEvents: CalendarEvent[], deletedEventIds: string[],
      _p: unknown,
      state: { completedProfile: UserProfile | null; memoryUpdated: boolean; tasksUpdated: boolean; projectsUpdated: boolean },
    ) => {
      createdEvents.push(created)
      updatedEvents.push(updated)
      deletedEventIds.push('d1')
      state.memoryUpdated = true
      state.tasksUpdated = true
      state.projectsUpdated = true
      state.completedProfile = finished
      return { ok: true }
    })

    anthropic.script = [toolCall('create_event'), textReply('הכל בוצע כמו שצריך, הנה הפירוט')]
    const result = await runTurn(input())

    expect(result.createdEvents).toEqual([created])
    expect(result.updatedEvents).toEqual([updated])
    expect(result.deletedEventIds).toEqual(['d1'])
    expect(result.memoryUpdated).toBe(true)
    expect(result.tasksUpdated).toBe(true)
    expect(result.projectsUpdated).toBe(true)
    expect(result.completedProfile).toBe(finished)
  })

  it('feeds every tool result back as a user turn before asking again', async () => {
    executeToolMock.mockResolvedValue({ event_id: 'e-9' })
    // Long enough not to trip the terse-reply retry, which would add a request.
    anthropic.script = [toolCall('create_event', { title: 'ריצה' }, 'tu-42'), textReply('קבעתי לך ריצה מחר ב-18:00, אחרי ההרצאה')]
    await runTurn(input())

    expect(anthropic.requests).toHaveLength(2)
    const messages = anthropic.requests[1].messages as Array<{ role: string; content: unknown }>
    expect(messages[0]).toEqual({ role: 'user', content: 'תקבע לי אימון מחר' })
    expect(messages[1].role).toBe('assistant')
    expect(messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu-42', content: JSON.stringify({ event_id: 'e-9' }) }],
    })
  })
})

// ── The follow-up retry ─────────────────────────────────────────────────────

describe('the terse-reply retry', () => {
  it('re-asks when a turn that used tools answers with an acknowledgement', async () => {
    const terse = 'בוצע!'
    expect(terse.length).toBeLessThan(FOLLOWUP_MIN_CHARS)

    anthropic.script = [
      toolCall('create_event'),
      textReply(terse),
      textReply('קבעתי אימון מחר ב-18:00 כי זה החלון הפנוי הראשון אחרי ההרצאה'),
    ]
    const result = await runTurn(input())

    expect(anthropic.requests).toHaveLength(3)
    const retry = anthropic.requests[2].messages as Array<{ role: string; content: unknown }>
    expect(retry[retry.length - 1]).toEqual({ role: 'user', content: followupPrompt(true) })
    // The retry has no tools: it is a summary pass over results already in the
    // transcript, not another chance to act.
    expect(anthropic.requests[2]).not.toHaveProperty('tools')
    expect(anthropic.requests[2].max_tokens).toBe(4096)
    expect(result.text).toContain('החלון הפנוי הראשון')
  })

  it('keeps the first answer when the retry comes back shorter', async () => {
    anthropic.script = [toolCall('create_event'), textReply('בוצע!'), textReply('כן')]
    const result = await runTurn(input())
    expect(result.text).toBe('בוצע!')
  })

  it('keeps the first answer when the retry itself fails', async () => {
    anthropic.script = [
      toolCall('create_event'),
      textReply('בוצע!'),
      () => { throw new Error('overloaded') },
    ]
    const result = await runTurn(input())
    expect(result.text).toBe('בוצע!')
  })

  it('does not re-ask a short answer to a question that used no tools', async () => {
    // A short answer to a short question is fine; a short answer after writing
    // to the user's calendar is not. The rule keys on tool calls, not length.
    anthropic.script = [textReply('כן')]
    const result = await runTurn(input())
    expect(anthropic.requests).toHaveLength(1)
    expect(result.text).toBe('כן')
  })

  it('asks in English when the client profile says so', async () => {
    anthropic.script = [toolCall('create_event'), textReply('Done!'), textReply('Scheduled your run for tomorrow at 18:00.')]
    await runTurn(input({ profile: { user_id: 'u-test', language: 'en' } as UserProfile }))
    const retry = anthropic.requests[2].messages as Array<{ role: string; content: unknown }>
    expect(retry[retry.length - 1]).toEqual({ role: 'user', content: followupPrompt(false) })
  })
})

// ── The ceilings ────────────────────────────────────────────────────────────

describe('the wall-clock ceiling', () => {
  it('defaults to the 90 seconds the chat route has always used', () => {
    expect(MAX_LOOP_MS).toBe(90000)
  })

  it('stops before the first provider call when the budget is already spent', async () => {
    anthropic.script = [textReply('never reached')]
    const result = await runTurn(input({ maxLoopMs: -1 }))

    expect(anthropic.requests).toHaveLength(0)
    expect(result.text).toBe('⏱️ This took too long to process. Please try again.')
  })

  it('cuts a running loop off at the caller-supplied ceiling, not at 90s', async () => {
    vi.useFakeTimers()
    // Each tool round-trip burns five seconds of the budget.
    executeToolMock.mockImplementation(async () => { vi.advanceTimersByTime(5000); return {} })
    anthropic.script = [toolCall('a'), toolCall('b'), toolCall('c'), textReply('too late')]

    const result = await runTurn(input({ maxLoopMs: 8000 }))

    expect(anthropic.requests).toHaveLength(2)
    expect(result.text).toBe('⏱️ This took too long to process. Please try again.')
  })

  it('lets the same loop finish under the default ceiling', async () => {
    vi.useFakeTimers()
    executeToolMock.mockImplementation(async () => { vi.advanceTimersByTime(5000); return {} })
    anthropic.script = [toolCall('a'), toolCall('b'), toolCall('c'), textReply('finished in time, with a full account of what was decided')]

    const result = await runTurn(input())

    expect(anthropic.requests).toHaveLength(4)
    expect(result.text).toBe('finished in time, with a full account of what was decided')
  })

  it('never keeps a partial answer waiting behind the timeout message', async () => {
    vi.useFakeTimers()
    executeToolMock.mockImplementation(async () => { vi.advanceTimersByTime(5000); return {} })
    // A text block arrived before the budget ran out, so it is what the user gets.
    anthropic.script = [toolCall('a'), textReply('partial, but real, and long enough to stand on its own'), textReply('unused')]
    const result = await runTurn(input({ maxLoopMs: 8000 }))
    expect(result.text).toBe('partial, but real, and long enough to stand on its own')
  })
})

describe('the iteration cap', () => {
  it('gives up after ten rounds of tool calls', async () => {
    anthropic.script = Array.from({ length: 12 }, (_, i) => toolCall('create_event', {}, `tu-${i}`))
    const result = await runTurn(input())

    // Ten loop requests — counted by the presence of `tools`, because the terse-
    // reply retry that follows an empty answer is a toolless eleventh request.
    expect(anthropic.requests.filter(r => 'tools' in r)).toHaveLength(10)
    expect(executeToolMock).toHaveBeenCalledTimes(10)
    // No text was ever produced, so the caller falls back to the backstop line.
    expect(result.text).toBe('')
  })
})

// ── Failure and the backstop ────────────────────────────────────────────────

describe('a provider failure', () => {
  it('is reported as Hebrew text rather than thrown, so the turn still ends', async () => {
    anthropic.script = [() => { throw new Error('502 bad gateway') }]
    const result = await runTurn(input())
    expect(result.text).toBe('⚠️ הייתה תקלה מול מנוע ה-AI. נסה שוב בעוד רגע.')
  })

  it('speaks English when the client profile does', async () => {
    anthropic.script = [() => { throw new Error('502 bad gateway') }]
    const result = await runTurn(input({ profile: { user_id: 'u-test', language: 'en' } as UserProfile }))
    expect(result.text).toBe('⚠️ The AI provider failed on this request. Please try again in a moment.')
  })

  it('does not overwrite text the loop already produced', async () => {
    anthropic.script = [
      toolCall('create_event'),
      textReply('קבעתי לך אימון מחר, וזה החלון הכי טוב שיש'),
      () => { throw new Error('boom in the follow-up') },
    ]
    const result = await runTurn(input())
    expect(result.text).toBe('קבעתי לך אימון מחר, וזה החלון הכי טוב שיש')
  })
})

describe('the backstop line', () => {
  it('is a soft Hebrew ack when nothing happened', async () => {
    anthropic.script = [silentReply()]
    const result = await runTurn(input())
    expect(result.text).toBe('')
    expect(result.fallbackText).toBe('✓ בוצע')
  })

  it('is a soft English ack for an English profile', async () => {
    anthropic.script = [silentReply()]
    const result = await runTurn(input({ profile: { user_id: 'u-test', language: 'en' } as UserProfile }))
    expect(result.fallbackText).toBe('✓ Done')
  })

  it('counts what actually changed, in the client profile language', async () => {
    executeToolMock.mockImplementation(async (
      _n: string, _i: unknown, _u: string, _e: unknown,
      created: CalendarEvent[], updated: CalendarEvent[], deleted: string[],
    ) => {
      created.push({ id: 'c1' } as CalendarEvent, { id: 'c2' } as CalendarEvent)
      updated.push({ id: 'u1' } as CalendarEvent)
      deleted.push('d1', 'd2', 'd3')
      return {}
    })
    anthropic.script = [toolCall('create_event'), silentReply()]

    const he = await runTurn(input())
    expect(he.fallbackText).toBe('✓ נוספו 2 אירועים, עודכנו 1, נמחקו 3')

    anthropic.script = [toolCall('create_event'), silentReply()]
    const en = await runTurn(input({ profile: { user_id: 'u-test', language: 'en' } as UserProfile }))
    expect(en.fallbackText).toBe('✓ added 2 event(s), updated 1, deleted 3')
  })

  it('is computed even when there is real text, so no caller has to recompute it', async () => {
    anthropic.script = [textReply('תשובה מלאה')]
    const result = await runTurn(input())
    expect(result.text).toBe('תשובה מלאה')
    expect(result.fallbackText).toBe('✓ בוצע')
  })
})
