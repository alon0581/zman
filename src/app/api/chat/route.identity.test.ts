/**
 * route.identity.test.ts — /api/chat still writes the same bytes.
 *
 * The assistant's brain moved to `lib/ai/runTurn.ts` and this route became a
 * wrapper over it. The move is only safe if the wire output is unchanged, so
 * this file pins the wire output rather than the refactor: `runTurn` is mocked,
 * a `TurnResult` is fed in, and the FULL SSE body is compared against a string
 * written out by hand from the pre-refactor handler.
 *
 * Full-body equality rather than "the text came through" is the point. It is
 * what catches the things a tidy-looking refactor actually breaks:
 *   - a frame emitted in a different order (the client applies them in order),
 *   - the backstop line going out word-split instead of as one frame,
 *   - a key renamed or reordered inside the `events` frame's JSON,
 *   - `done` going missing on an error path, which hangs the client forever,
 *   - the 401 quietly becoming SSE, or the outer catch quietly becoming a 500.
 *
 * The word-splitting expectations below are computed BY HAND, never by
 * re-running `split(/(?<=\s)|(?=\s)/)` — asserting a regex against itself proves
 * nothing.
 */

import type { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarEvent, UserProfile } from '@/types'
import type { TurnResult } from '@/lib/ai/runTurn'

const runTurnMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/ai/runTurn', () => ({ runTurn: runTurnMock }))

const cookie = vi.hoisted(() => ({ value: 'a-token' as string | undefined }))
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => (cookie.value === undefined ? undefined : { value: cookie.value }) }),
}))
vi.mock('@/lib/auth', () => ({
  COOKIE_NAME: 'zman_session',
  getUserIdFromCookie: (token?: string) => (token ? 'u-test' : null),
}))

import { POST } from './route'

// ── Fixtures ────────────────────────────────────────────────────────────────

const F = (json: string) => `data: ${json}\n\n`
const EMPTY_EVENTS = F('{"type":"events","createdEvents":[],"updatedEvents":[],"deletedEventIds":[]}')
const DONE = F('{"type":"done"}')

const turn = (over: Partial<TurnResult> = {}): TurnResult => ({
  text: '',
  fallbackText: '✓ בוצע',
  createdEvents: [],
  updatedEvents: [],
  deletedEventIds: [],
  memoryUpdated: false,
  tasksUpdated: false,
  projectsUpdated: false,
  completedProfile: null,
  ...over,
})

const body = (over: Record<string, unknown> = {}) => ({
  messages: [{ role: 'user', content: 'היי' }],
  events: [],
  profile: null,
  timezone: 'Asia/Jerusalem',
  ...over,
})

const request = (payload: unknown): NextRequest =>
  ({ json: async () => payload }) as unknown as NextRequest

const throwingRequest = (): NextRequest =>
  ({ json: async () => { throw new SyntaxError('Unexpected token < in JSON') } }) as unknown as NextRequest

const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY

beforeEach(() => {
  cookie.value = 'a-token'
  process.env.ANTHROPIC_API_KEY = 'sk-test'
  runTurnMock.mockReset()
  runTurnMock.mockResolvedValue(turn())
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY
  vi.restoreAllMocks()
})

// ── The frame sequence ──────────────────────────────────────────────────────

describe('the ordinary turn', () => {
  it('emits events, then the reply, then done — and nothing else', async () => {
    runTurnMock.mockResolvedValue(turn({ text: 'שלום' }))
    const res = await POST(request(body()))

    expect(await res.text()).toBe(
      EMPTY_EVENTS +
      F('{"type":"text","content":"שלום"}') +
      DONE
    )
  })

  it('keeps the streaming headers the client relies on', async () => {
    const res = await POST(request(body()))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/event-stream')
    expect(res.headers.get('Cache-Control')).toBe('no-cache')
    // Nginx buffers text/event-stream by default, which delivers the whole turn
    // at once and makes the typing effect vanish in production only.
    expect(res.headers.get('X-Accel-Buffering')).toBe('no')
  })

  it('carries the events frame verbatim, keys in the original order', async () => {
    const created = [{ id: 'c1', title: 'שיעור' }] as unknown as CalendarEvent[]
    const updated = [{ id: 'u1', title: 'חדר כושר' }] as unknown as CalendarEvent[]
    runTurnMock.mockResolvedValue(turn({
      text: 'ok', createdEvents: created, updatedEvents: updated, deletedEventIds: ['d1', 'd2'],
    }))
    const res = await POST(request(body()))

    expect(await res.text()).toBe(
      F('{"type":"events","createdEvents":[{"id":"c1","title":"שיעור"}],"updatedEvents":[{"id":"u1","title":"חדר כושר"}],"deletedEventIds":["d1","d2"]}') +
      F('{"type":"text","content":"ok"}') +
      DONE
    )
  })
})

describe('the refresh frames', () => {
  it('emits all four in the fixed order the client applies them in', async () => {
    const profile = { user_id: 'u-test', language: 'he' } as unknown as UserProfile
    runTurnMock.mockResolvedValue(turn({
      text: 'בוצע הכל בהצלחה גמורה',
      completedProfile: profile,
      memoryUpdated: true,
      tasksUpdated: true,
      projectsUpdated: true,
    }))
    const res = await POST(request(body()))
    const lines = (await res.text()).split('\n\n').filter(Boolean)

    expect(lines.slice(0, 5)).toEqual([
      'data: {"type":"events","createdEvents":[],"updatedEvents":[],"deletedEventIds":[]}',
      'data: {"type":"onboarding_complete","profile":{"user_id":"u-test","language":"he"}}',
      'data: {"type":"memory_updated"}',
      'data: {"type":"tasks_updated"}',
      'data: {"type":"projects_updated"}',
    ])
    expect(lines[lines.length - 1]).toBe('data: {"type":"done"}')
  })

  it('omits each one when its flag is false', async () => {
    runTurnMock.mockResolvedValue(turn({ text: 'x' }))
    const out = await (await POST(request(body()))).text()
    for (const type of ['onboarding_complete', 'memory_updated', 'tasks_updated', 'projects_updated']) {
      expect(out).not.toContain(type)
    }
  })

  // projects_updated is deliberately NOT folded into tasks_updated: refetching
  // projects also pulls /api/projects/health, which runs a real placement pass.
  it('keeps projects_updated independent of tasks_updated', async () => {
    runTurnMock.mockResolvedValue(turn({ text: 'x', projectsUpdated: true }))
    const out = await (await POST(request(body()))).text()
    expect(out).toContain('projects_updated')
    expect(out).not.toContain('tasks_updated')
  })
})

describe('word-by-word emission', () => {
  // `split(/(?<=\s)|(?=\s)/)` cuts on both sides of every run of whitespace, so
  // each whitespace character becomes its own chunk and a doubled space becomes
  // two. Worked out by hand for 'שלום  עולם\nמה נשמע ' — note the double space,
  // the newline, and the trailing space:
  //   'שלום' ' ' ' ' 'עולם' '\n' 'מה' ' ' 'נשמע' ' ' ''
  // The empty final chunk is dropped by the `if (word)` guard; the whitespace
  // chunks are NOT, which is what makes the client's concatenation lossless.
  it('splits on both sides of whitespace and keeps every space as its own frame', async () => {
    runTurnMock.mockResolvedValue(turn({ text: 'שלום  עולם\nמה נשמע ' }))
    const res = await POST(request(body()))

    expect(await res.text()).toBe(
      EMPTY_EVENTS +
      F('{"type":"text","content":"שלום"}') +
      F('{"type":"text","content":" "}') +
      F('{"type":"text","content":" "}') +
      F('{"type":"text","content":"עולם"}') +
      F('{"type":"text","content":"\\n"}') +
      F('{"type":"text","content":"מה"}') +
      F('{"type":"text","content":" "}') +
      F('{"type":"text","content":"נשמע"}') +
      F('{"type":"text","content":" "}') +
      DONE
    )
  })

  it('reassembles to exactly the original text, character for character', async () => {
    const text = '  קבעתי לך 3 בלוקים:\tראשון, שני,  שלישי. 🎯 '
    runTurnMock.mockResolvedValue(turn({ text }))
    const out = await (await POST(request(body()))).text()

    const rebuilt = out.split('\n\n').filter(Boolean)
      .map(l => JSON.parse(l.slice('data: '.length)))
      .filter((f: { type: string }) => f.type === 'text')
      .map((f: { content: string }) => f.content)
      .join('')
    expect(rebuilt).toBe(text)
  })
})

describe('the empty-reply backstop', () => {
  // The trap this exists to catch: the backstop line contains spaces, and the
  // pre-refactor handler sent it as ONE frame, not word-split. A refactor that
  // routes it through the same splitter as a real reply changes the wire.
  it('sends the backstop as a single unsplit frame', async () => {
    runTurnMock.mockResolvedValue(turn({ text: '', fallbackText: '✓ נוספו 2 אירועים' }))
    const res = await POST(request(body()))

    expect(await res.text()).toBe(
      EMPTY_EVENTS +
      F('{"type":"text","content":"✓ נוספו 2 אירועים"}') +
      DONE
    )
  })

  it('prefers real text whenever there is any, and never sends both', async () => {
    runTurnMock.mockResolvedValue(turn({ text: 'תשובה', fallbackText: '✓ בוצע' }))
    const out = await (await POST(request(body()))).text()
    expect(out).toContain('תשובה')
    expect(out).not.toContain('בוצע')
  })
})

// ── The error shapes ────────────────────────────────────────────────────────

describe('the shapes that are deliberately not a normal stream', () => {
  it('answers an unauthenticated request with a plain-text 401, not SSE', async () => {
    cookie.value = undefined
    const res = await POST(request(body()))

    expect(res.status).toBe(401)
    expect(res.headers.get('Content-Type')).not.toBe('text/event-stream')
    expect(await res.text()).toBe('Unauthorized')
    expect(runTurnMock).not.toHaveBeenCalled()
  })

  it('reports a missing API key as three frames, message unsplit', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const res = await POST(request(body()))

    expect(res.status).toBe(200)
    expect(await res.text()).toBe(
      EMPTY_EVENTS +
      F('{"type":"text","content":"⚙️ No Anthropic API key configured on the server."}') +
      DONE
    )
    // And the turn is never started — no key, no provider call.
    expect(runTurnMock).not.toHaveBeenCalled()
  })

  it('turns a broken request body into a 200 with a well-formed 3-frame turn', async () => {
    // HTTP 200 on purpose: the client's reader stops on `done` and nothing else,
    // so a 500 with no body hangs the UI rather than showing an error.
    const res = await POST(throwingRequest())

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/event-stream')
    expect(res.headers.get('Cache-Control')).toBe('no-cache')
    // This path never set X-Accel-Buffering, and still does not.
    expect(res.headers.get('X-Accel-Buffering')).toBeNull()
    expect(await res.text()).toBe(
      'data: {"type":"events","createdEvents":[],"updatedEvents":[],"deletedEventIds":[]}\n\n' +
      'data: {"type":"error","message":"Internal server error"}\n\n' +
      'data: {"type":"done"}\n\n'
    )
  })

  it('falls into the same shape when the turn itself throws', async () => {
    runTurnMock.mockRejectedValue(new Error('storage exploded'))
    const res = await POST(request(body()))

    expect(res.status).toBe(200)
    const out = await res.text()
    expect(out).toContain('"type":"error"')
    expect(out.endsWith('data: {"type":"done"}\n\n')).toBe(true)
  })
})

// ── The call into the brain ─────────────────────────────────────────────────

describe('what the route hands to runTurn', () => {
  it('passes the parsed body through unchanged, plus the resolved key', async () => {
    const events = [{ id: 'e1' }] as unknown as CalendarEvent[]
    const profile = { user_id: 'u-test' } as unknown as UserProfile
    await POST(request(body({
      events, profile, isOnboarding: true,
      memory: [{ key: 'k', value: 'v' }],
      tasks: [{ id: 't1' }],
    })))

    expect(runTurnMock).toHaveBeenCalledTimes(1)
    expect(runTurnMock.mock.calls[0][0]).toEqual({
      userId: 'u-test',
      messages: [{ role: 'user', content: 'היי' }],
      events,
      profile,
      isOnboarding: true,
      memory: [{ key: 'k', value: 'v' }],
      tasks: [{ id: 't1' }],
      timezone: 'Asia/Jerusalem',
      apiKey: 'sk-test',
    })
  })

  it('does NOT pass maxLoopMs, so the browser turn keeps the 90s ceiling', async () => {
    // The parameter exists for the phone endpoint, which cannot hold a request
    // open that long. Passing one here would shorten every chat turn silently.
    await POST(request(body()))
    expect(runTurnMock.mock.calls[0][0]).not.toHaveProperty('maxLoopMs')
  })
})
