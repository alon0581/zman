/**
 * route.test.ts — the Shortcut ingress.
 *
 * This is the only route in the app reachable without a session cookie, and the
 * only one whose credential lives in an exported file on a phone. So the tests
 * that matter most here are not the happy path; they are the ways it could be
 * wrong quietly:
 *
 *   - answering to a caller it should have refused,
 *   - handing the model an EMPTY CALENDAR, which is what makes the assistant
 *     double-book without ever reporting an error,
 *   - resolving "today" in UTC, so a sentence spoken late at night lands on the
 *     wrong date,
 *   - dropping the turn out of chat history, so the next in-app message has a
 *     hole in the conversation.
 *
 * Only three things are mocked: the brain (`runTurn`), speech-to-text, and the
 * JSON layer, which is replaced by an in-memory filesystem. Everything else —
 * auth, `safeEqual`, the rate limiter, `userStore`, `withUserLock` — is the real
 * module, because those are the parts a mock would flatter.
 */

import type { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'path'
import type { TurnResult } from '@/lib/ai/runTurn'
import type { CalendarEvent } from '@/types'

const DATA = path.join('/tmp', 'zman-ingest-test')
const USER_ID = 'user-alon'
const EMAIL = 'alon@example.com'
const TOKEN = 'shortcut-token-abcdefghijklmnop'

// ── An in-memory filesystem, shared by every module that reads JSON ──────────
const files = vi.hoisted(() => new Map<string, unknown>())
vi.mock('@/lib/util/jsonStore', () => ({
  readJsonFile: (p: string, fallback: unknown) =>
    files.has(p) ? JSON.parse(JSON.stringify(files.get(p))) : fallback,
  writeJsonFileAtomic: (p: string, data: unknown) => {
    files.set(p, JSON.parse(JSON.stringify(data)))
  },
}))

const runTurnMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/ai/runTurn', () => ({ runTurn: runTurnMock }))

const transcribeMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/voice/transcribe', () => ({ transcribeAudio: transcribeMock }))

// ── Fixtures ────────────────────────────────────────────────────────────────

const userFile = path.join(DATA, 'auth', 'users.json')
const eventsFile = path.join(DATA, 'users', USER_ID, 'events.json')
const chatFile = path.join(DATA, 'users', USER_ID, 'chat-history.json')

const LECTURE: CalendarEvent = {
  id: 'lec', user_id: USER_ID, title: 'הרצאה במבני נתונים',
  start_time: '2026-08-19T09:00:00', end_time: '2026-08-19T11:00:00',
  is_all_day: false, source: 'zman', created_by: 'user', status: 'confirmed',
  created_at: '2026-08-01T00:00:00.000Z',
}

const turn = (over: Partial<TurnResult> = {}): TurnResult => ({
  text: 'קבעתי אימון מחר ב-18:00.',
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

/** A multipart request — the documented Shortcut shape. */
function request(form: Record<string, string | Blob>, auth: string | null = `Bearer ${TOKEN}`): NextRequest {
  const fd = new FormData()
  for (const [k, v] of Object.entries(form)) fd.append(k, v)
  const headers = new Headers({ 'content-type': 'multipart/form-data; boundary=abc' })
  if (auth !== null) headers.set('authorization', auth)
  return { headers, formData: async () => fd } as unknown as NextRequest
}

/** A raw-body request — what "Request Body: File" in Shortcuts actually sends. */
function rawRequest(
  body: ArrayBuffer | string,
  contentType: string,
  extra: Record<string, string> = {},
): NextRequest {
  const headers = new Headers({ 'content-type': contentType, authorization: `Bearer ${TOKEN}`, ...extra })
  return {
    headers,
    text: async () => (typeof body === 'string' ? body : ''),
    arrayBuffer: async () => (typeof body === 'string' ? new ArrayBuffer(0) : body),
    formData: async () => { throw new TypeError('not a form') },
  } as unknown as NextRequest
}

/** Fresh module graph per test: the route reads its env into consts at load. */
async function load(env: Partial<Record<string, string>> = {}) {
  vi.resetModules()
  process.env.DATA_DIR = DATA
  process.env.AUTH_SECRET = 'test-secret'
  process.env.ANTHROPIC_API_KEY = 'sk-test'
  process.env.SHORTCUT_TOKEN = TOKEN
  process.env.SHORTCUT_USER_EMAIL = EMAIL
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  const mod = await import('./route')
  return mod.POST
}

beforeEach(() => {
  files.clear()
  files.set(userFile, [
    { id: USER_ID, email: EMAIL, passwordHash: 'x', salt: 'y', createdAt: '2026-01-01T00:00:00.000Z', tokenVersion: 0 },
  ])
  runTurnMock.mockReset().mockResolvedValue(turn())
  transcribeMock.mockReset().mockResolvedValue('תקבע לי אימון מחר בשש')
})

afterEach(() => {
  delete process.env.SHORTCUT_TOKEN
  delete process.env.SHORTCUT_USER_EMAIL
})

const audio = () => new Blob([new Uint8Array(8000)], { type: 'audio/m4a' })

// ── Auth ────────────────────────────────────────────────────────────────────

describe('auth', () => {
  it('refuses a request with no Authorization header', async () => {
    const POST = await load()
    const res = await POST(request({ audio: audio() }, null))
    expect(res.status).toBe(401)
    expect(runTurnMock).not.toHaveBeenCalled()
  })

  it('refuses a wrong token', async () => {
    const POST = await load()
    const res = await POST(request({ audio: audio() }, 'Bearer not-the-token-not-the-token'))
    expect(res.status).toBe(401)
    expect(runTurnMock).not.toHaveBeenCalled()
  })

  // safeEqual must length-check before timingSafeEqual, which throws on a
  // mismatch. Without that this is a 500, and a 500 tells an attacker the token
  // was the wrong LENGTH — the one bit constant-time comparison exists to hide.
  it('answers 401, not 500, for a token of the wrong length', async () => {
    const POST = await load()
    const res = await POST(request({ audio: audio() }, 'Bearer x'))
    expect(res.status).toBe(401)
  })

  it('ignores a token in the query string or body — header only', async () => {
    const POST = await load()
    const res = await POST(request({ audio: audio(), token: TOKEN }, null))
    expect(res.status).toBe(401)
  })

  // Deploying the code before configuring it must not open the door.
  it('fails closed when SHORTCUT_TOKEN is unset, even with a correct token', async () => {
    const POST = await load({ SHORTCUT_TOKEN: undefined })
    const res = await POST(request({ audio: audio() }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('not_configured')
  })

  it('fails closed when SHORTCUT_USER_EMAIL is unset', async () => {
    const POST = await load({ SHORTCUT_USER_EMAIL: undefined })
    const res = await POST(request({ audio: audio() }))
    expect(res.status).toBe(401)
  })

  // Configured for someone who does not exist: refuse rather than invent a user
  // and write events into a directory nobody will ever open.
  it('refuses when the configured email matches no account', async () => {
    const POST = await load({ SHORTCUT_USER_EMAIL: 'nobody@example.com' })
    const res = await POST(request({ audio: audio() }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('unknown_user')
    expect(runTurnMock).not.toHaveBeenCalled()
  })
})

// ── The trap this route exists to close ─────────────────────────────────────

describe('the calendar is loaded server-side', () => {
  it('hands runTurn the real events, so conflicts can be detected at all', async () => {
    files.set(eventsFile, [LECTURE])
    const POST = await load()
    await POST(request({ audio: audio() }))

    const input = runTurnMock.mock.calls[0][0]
    expect(input.events).toHaveLength(1)
    expect(input.events[0].id).toBe('lec')
  })

  // The whole point of the design: there is no `events` field on the request, so
  // no caller can supply an empty week. If this ever starts reading one from the
  // body, the assistant silently loses conflict detection.
  it('cannot be told the calendar is empty by the caller', async () => {
    files.set(eventsFile, [LECTURE])
    const POST = await load()
    await POST(request({ audio: audio(), events: '[]' }))

    expect(runTurnMock.mock.calls[0][0].events).toHaveLength(1)
  })

  it('passes the resolved user id, never the configured email', async () => {
    const POST = await load()
    await POST(request({ audio: audio() }))
    expect(runTurnMock.mock.calls[0][0].userId).toBe(USER_ID)
  })
})

// ── Time ────────────────────────────────────────────────────────────────────

describe('timezone', () => {
  // With no timezone runTurn falls back to `new Date()`, which is UTC on
  // Railway — so 00:30 in Israel resolves to the day before.
  it('defaults to Asia/Jerusalem, because a phone reports no zone', async () => {
    const POST = await load()
    await POST(request({ audio: audio() }))
    expect(runTurnMock.mock.calls[0][0].timezone).toBe('Asia/Jerusalem')
  })

  it('lets the caller override it, for travel', async () => {
    const POST = await load()
    await POST(request({ audio: audio(), timezone: 'Europe/Berlin' }))
    expect(runTurnMock.mock.calls[0][0].timezone).toBe('Europe/Berlin')
  })
})

// ── Input handling ──────────────────────────────────────────────────────────

describe('input', () => {
  it('transcribes the audio and reports what it heard', async () => {
    const POST = await load()
    const res = await POST(request({ audio: audio() }))
    const body = await res.json()

    expect(body.ok).toBe(true)
    expect(body.heard).toBe('תקבע לי אימון מחר בשש')
    expect(body.reply).toBe('קבעתי אימון מחר ב-18:00.')
  })

  it('accepts typed text instead of audio, and then never transcribes', async () => {
    const POST = await load()
    const res = await POST(request({ text: 'תוסיף משימה' }))

    expect(transcribeMock).not.toHaveBeenCalled()
    expect(runTurnMock.mock.calls[0][0].messages.at(-1).content).toBe('תוסיף משימה')
    expect((await res.json()).ok).toBe(true)
  })

  // A stray press of the Action Button, or silence: transcribeAudio returns ''
  // for a sub-4KB blob and for a hallucinated "תודה". Neither may cost a turn.
  it('spends nothing when the transcript comes back empty', async () => {
    transcribeMock.mockResolvedValue('')
    const POST = await load()
    const res = await POST(request({ audio: audio() }))

    expect(runTurnMock).not.toHaveBeenCalled()
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.heard).toBe('')
  })

  it('rejects a request carrying neither audio nor text', async () => {
    const POST = await load()
    const res = await POST(request({}))
    expect(res.status).toBe(400)
    expect(runTurnMock).not.toHaveBeenCalled()
  })

  // Caught live: a POST whose body cannot be read at all used to fall through to
  // the catch-all and answer 500 — telling the caller the server broke when the
  // caller had sent a bad request.
  it('answers 400, not 500, when the body cannot be read', async () => {
    const POST = await load()
    const bad = {
      headers: new Headers({ authorization: `Bearer ${TOKEN}`, 'content-type': 'multipart/form-data; boundary=x' }),
      formData: async () => { throw new TypeError('Could not parse content as FormData') },
    } as unknown as NextRequest
    const res = await POST(bad)

    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('bad_request')
    expect(runTurnMock).not.toHaveBeenCalled()
  })

  // A Shortcut cannot wait as long as a browser tab.
  it('caps the tool loop well below the 90s the browser path allows', async () => {
    const POST = await load()
    await POST(request({ audio: audio() }))
    expect(runTurnMock.mock.calls[0][0].maxLoopMs).toBe(45_000)
  })
})

// ── Conversation continuity ─────────────────────────────────────────────────

describe('chat history', () => {
  it('sends the recent conversation, so the turn is not context-free', async () => {
    files.set(chatFile, [
      { id: '1', role: 'user', content: 'מה יש לי מחר?', timestamp: '2026-08-18T08:00:00.000Z' },
      { id: '2', role: 'assistant', content: 'הרצאה ב-9.', timestamp: '2026-08-18T08:00:01.000Z' },
    ])
    const POST = await load()
    await POST(request({ audio: audio() }))

    const sent = runTurnMock.mock.calls[0][0].messages
    expect(sent).toHaveLength(3)
    expect(sent[0]).toEqual({ role: 'user', content: 'מה יש לי מחר?' })
    expect(sent[2]).toEqual({ role: 'user', content: 'תקבע לי אימון מחר בשש' })
  })

  // Without this the next in-app message sends a transcript with a hole in it,
  // and the assistant has no idea it just scheduled something.
  it('appends BOTH turns, preserving what was already there', async () => {
    files.set(chatFile, [
      { id: '1', role: 'user', content: 'שלום', timestamp: '2026-08-18T08:00:00.000Z' },
    ])
    const POST = await load()
    await POST(request({ audio: audio() }))

    const saved = files.get(chatFile) as Array<{ role: string; content: string }>
    expect(saved).toHaveLength(3)
    expect(saved[0].content).toBe('שלום')
    expect(saved[1]).toMatchObject({ role: 'user', content: 'תקבע לי אימון מחר בשש' })
    expect(saved[2]).toMatchObject({ role: 'assistant', content: 'קבעתי אימון מחר ב-18:00.' })
  })

  it('stores the backstop line when the model produced no text', async () => {
    runTurnMock.mockResolvedValue(turn({ text: '', fallbackText: '✓ נוסף אירוע' }))
    const POST = await load()
    const res = await POST(request({ audio: audio() }))

    expect((await res.json()).reply).toBe('✓ נוסף אירוע')
    expect((files.get(chatFile) as Array<{ content: string }>).at(-1)!.content).toBe('✓ נוסף אירוע')
  })

  it('keeps the file at the 100-message cap', async () => {
    files.set(chatFile, Array.from({ length: 100 }, (_, i) => ({
      id: String(i), role: i % 2 ? 'assistant' : 'user', content: `m${i}`,
      timestamp: '2026-08-18T08:00:00.000Z',
    })))
    const POST = await load()
    await POST(request({ audio: audio() }))

    const saved = files.get(chatFile) as unknown[]
    expect(saved).toHaveLength(100)
  })
})

// ── What the phone gets back ────────────────────────────────────────────────

describe('response', () => {
  it('names what was created, so the Shortcut can show it', async () => {
    runTurnMock.mockResolvedValue(turn({
      createdEvents: [{ ...LECTURE, id: 'gym', title: 'אימון', start_time: '2026-08-19T18:00:00', end_time: '2026-08-19T19:00:00' }],
    }))
    const POST = await load()
    const body = await (await POST(request({ audio: audio() }))).json()

    expect(body.created).toEqual([{ title: 'אימון', start: '2026-08-19T18:00:00', end: '2026-08-19T19:00:00' }])
  })

  // The Shortcut displays `reply` unconditionally, so every failure shape must
  // carry a sentence a human can act on — never an empty field or a stack trace.
  it('always carries a human-readable reply, even when the turn throws', async () => {
    runTurnMock.mockRejectedValue(new Error('boom'))
    const POST = await load()
    const res = await POST(request({ audio: audio() }))

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(typeof body.reply).toBe('string')
    expect(body.reply.length).toBeGreaterThan(0)
  })

  it('does not write history when the turn failed', async () => {
    runTurnMock.mockRejectedValue(new Error('boom'))
    const POST = await load()
    await POST(request({ audio: audio() }))
    expect(files.has(chatFile)).toBe(false)
  })
})

// ── The other body shape ────────────────────────────────────────────────────
//
// Shortcuts offers "Request Body: Form" and "Request Body: File". The second
// posts the recording as the whole body with no field name, and it is the one a
// person lands on naturally — this suite exists because that shape spent an
// evening answering "the network connection failed".

describe('raw body (Request Body: File)', () => {
  const clip = () => new Uint8Array(9000).buffer

  it('accepts the recording as the entire body, with no form and no field name', async () => {
    const POST = await load()
    const res = await POST(rawRequest(clip(), 'audio/m4a'))

    expect(res.status).toBe(200)
    expect(transcribeMock).toHaveBeenCalledTimes(1)
    expect((await res.json()).heard).toBe('תקבע לי אימון מחר בשש')
  })

  // The OpenAI transcription models read the extension off the upload's
  // filename, so a raw body has to be given one derived from its Content-Type.
  it('names the upload from the Content-Type, so the model accepts it', async () => {
    const POST = await load()
    await POST(rawRequest(clip(), 'audio/mpeg'))

    const sent = transcribeMock.mock.calls[0][0] as File
    expect(sent.name).toBe('audio.mp3')
    expect(sent.size).toBe(9000)
  })

  it('falls back to m4a for a Content-Type it does not recognise', async () => {
    const POST = await load()
    await POST(rawRequest(clip(), 'application/octet-stream'))
    expect((transcribeMock.mock.calls[0][0] as File).name).toBe('audio.m4a')
  })

  it('takes a plain-text body as the sentence itself', async () => {
    const POST = await load()
    await POST(rawRequest('תקבע פגישה מחר', 'text/plain; charset=utf-8'))

    expect(transcribeMock).not.toHaveBeenCalled()
    expect(runTurnMock.mock.calls[0][0].messages.at(-1).content).toBe('תקבע פגישה מחר')
  })

  // No form fields on this path, so the two things the browser would have sent
  // move to headers — with the same defaults as before when they are absent.
  it('reads lang and timezone from headers, defaulting as the form path does', async () => {
    const POST = await load()
    await POST(rawRequest(clip(), 'audio/m4a'))
    expect(runTurnMock.mock.calls[0][0].timezone).toBe('Asia/Jerusalem')

    runTurnMock.mockClear()
    await POST(rawRequest(clip(), 'audio/m4a', { 'x-timezone': 'Europe/Berlin', 'x-lang': 'en' }))
    expect(runTurnMock.mock.calls[0][0].timezone).toBe('Europe/Berlin')
    expect(transcribeMock.mock.calls.at(-1)![1]).toBe('en')
  })

  it('rejects an empty body rather than burning a turn on nothing', async () => {
    const POST = await load()
    const res = await POST(rawRequest(new ArrayBuffer(0), 'audio/m4a'))

    expect(res.status).toBe(400)
    expect(runTurnMock).not.toHaveBeenCalled()
  })

  it('still refuses an unauthenticated raw body', async () => {
    const POST = await load()
    const noAuth = {
      headers: new Headers({ 'content-type': 'audio/m4a' }),
      arrayBuffer: async () => clip(),
    } as unknown as NextRequest
    expect((await POST(noAuth)).status).toBe(401)
  })
})

// ── The reachability probe ──────────────────────────────────────────────────

describe('GET probe', () => {
  const getReq = (auth: string | null = `Bearer ${TOKEN}`) => {
    const headers = new Headers()
    if (auth !== null) headers.set('authorization', auth)
    return { headers } as unknown as NextRequest
  }

  it('confirms reachability and a good token', async () => {
    const mod = await (async () => { await load(); return import('./route') })()
    const res = await mod.GET(getReq())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(typeof body.reply).toBe('string')
  })

  // 200 with ok:false on purpose: Shortcuts turns a non-2xx into a generic
  // failure and hides the sentence that says what is actually wrong, which is
  // the whole reason this endpoint exists.
  it('answers 200 with ok:false for a bad token, so the reason is readable', async () => {
    const mod = await (async () => { await load(); return import('./route') })()
    const res = await mod.GET(getReq('Bearer wrong-token-wrong-token'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.reply).toContain('טוקן')
  })

  it('never runs a turn', async () => {
    const mod = await (async () => { await load(); return import('./route') })()
    await mod.GET(getReq())
    expect(runTurnMock).not.toHaveBeenCalled()
  })
})
