import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import path from 'path'
import { runTurn } from '@/lib/ai/runTurn'
import { transcribeAudio } from '@/lib/voice/transcribe'
import { checkRateLimit, getUserIdByEmail, safeEqual } from '@/lib/auth'
import { userStore } from '@/lib/store/userStore'
import { withUserLock } from '@/lib/store/lock'
import { readJsonFile, writeJsonFileAtomic } from '@/lib/util/jsonStore'
import { assertSafeUserId } from '@/lib/util/safeUserId'
import { DATA_DIR } from '@/lib/util/dataDir'
import { AIMemory, UserProfile } from '@/types'

/**
 * POST /api/ingest — one spoken sentence, from outside the app.
 *
 * Built for an iPhone Shortcut on the Action Button: record, POST the audio, get
 * back what Zman did. It has to behave EXACTLY as if the sentence had been spoken
 * inside the app, which is why it runs `runTurn` — the same brain `/api/chat`
 * runs — rather than a second implementation. A duplicated brain is how this
 * codebase ended up with two session-length tables that disagreed on ten of
 * eighteen methods; see the note at the top of `chat/route.ts`.
 *
 * The one thing this route does that `/api/chat` does not: it loads the calendar
 * itself. `/api/chat` takes `events` from the request body because the browser
 * already holds them, and a caller that sends `[]` gets a model that believes the
 * week is empty — no conflict detection, no "you are busy then", cheerful
 * double-booking. A phone cannot supply that array, so the trap is closed
 * structurally: there is no `events` field here to get wrong.
 */

// ─── Config ─────────────────────────────────────────────────────────────────

/** Shared secret the Shortcut presents. Unset means this route is off. */
const TOKEN = process.env.SHORTCUT_TOKEN

/**
 * Whose calendar this writes to, by EMAIL rather than id. A uuid in an env var is
 * unreadable and unverifiable — the local `users.json` carries a different id for
 * the same person plus three test accounts, so a mistyped uuid would write into a
 * neighbouring account in silence. An email is checkable by eye.
 */
const USER_EMAIL = process.env.SHORTCUT_USER_EMAIL

/**
 * A phone is not a browser: there is no `Intl.DateTimeFormat()` to report the
 * zone, and with `timezone` absent `runTurn` falls back to `new Date()`, which on
 * Railway is UTC. A sentence spoken at 00:30 Israel time would then resolve to the
 * previous day. Overridable per request, for travel.
 */
const DEFAULT_TIMEZONE = 'Asia/Jerusalem'

/**
 * Lower than the 90s `/api/chat` allows. A browser tab can wait; a Shortcut
 * holding the phone's UI cannot, and an honest "that took too long" beats a
 * spinner that never resolves.
 */
const INGEST_MAX_LOOP_MS = 45_000

/**
 * The window is `checkRateLimit`'s fixed 15 minutes. Nothing else under
 * `src/app/api/` is rate limited at all, and this is the only route reachable with
 * a credential that lives inside a phone shortcut — one exported Shortcut is
 * otherwise an open door onto the Anthropic bill. In-process only, so it resets on
 * deploy and is not shared across replicas: the same limitation the login limiter
 * has, and still worth far more than nothing.
 */
const RATE_MAX_INGEST = 20

/** The same cap the chat-history route enforces. */
const MAX_MESSAGES = 100
/** What the browser sends per turn, matched so the model sees the same depth. */
const HISTORY_TURNS = 14

interface StoredMessage {
  id: string
  role: string
  content: string
  timestamp: string
}

function chatFile(userId: string) {
  return path.join(DATA_DIR, 'users', assertSafeUserId(userId), 'chat-history.json')
}

function memoryFile(userId: string) {
  return path.join(DATA_DIR, 'users', assertSafeUserId(userId), 'memory.json')
}

function profileFile(userId: string) {
  return path.join(DATA_DIR, 'users', assertSafeUserId(userId), 'profile.json')
}

/** `Bearer <token>`, case-insensitive scheme, nothing else accepted. */
function bearerFrom(req: NextRequest): string | null {
  const raw = req.headers.get('authorization') ?? ''
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim())
  return m ? m[1].trim() : null
}

function field(form: FormData, name: string): string {
  const v = form.get(name)
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * The OpenAI transcription models key off the upload's filename extension, so a
 * raw body needs one invented from its Content-Type. Unknown types fall through
 * to m4a, which is what iOS records.
 */
const EXT_FOR: Record<string, string> = {
  'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a', 'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav',
  'audio/x-wav': 'wav', 'audio/webm': 'webm', 'audio/ogg': 'ogg',
}

interface Incoming { typed: string; audio: Blob | null; lang: string; timezone: string }

/**
 * Two body shapes, because the Shortcuts app offers two and only one of them is
 * easy to get right.
 *
 * `Request Body: Form` with a file field named `audio` is the documented shape.
 * `Request Body: File` posts the recording as the WHOLE body with no field name
 * and no multipart wrapper — fewer places to fumble, and the shape a person
 * lands on naturally. Supporting both costs a branch; supporting only the first
 * cost a real evening of "the network connection failed".
 *
 * Returns null when there is nothing usable, which the caller turns into a 400.
 */
async function readIncoming(req: NextRequest): Promise<Incoming | null> {
  const ct = (req.headers.get('content-type') ?? '').toLowerCase()
  const header = (name: string, fallback: string) => (req.headers.get(name) ?? '').trim() || fallback

  if (!ct.startsWith('multipart/form-data')) {
    // Raw body. Headers carry what the form fields otherwise would.
    const lang = header('x-lang', 'he')
    const timezone = header('x-timezone', DEFAULT_TIMEZONE)

    if (ct.startsWith('text/') || ct.startsWith('application/x-www-form-urlencoded')) {
      const text = (await req.text()).trim()
      return text ? { typed: text, audio: null, lang, timezone } : null
    }

    const buf = await req.arrayBuffer()
    if (!buf.byteLength) return null
    const type = ct.split(';')[0].trim() || 'audio/m4a'
    const file = new File([buf], `audio.${EXT_FOR[type] ?? 'm4a'}`, { type })
    return { typed: '', audio: file, lang, timezone }
  }

  const form = await req.formData()
  const audio = form.get('audio')
  return {
    typed: field(form, 'text'),
    audio: audio instanceof Blob ? audio : null,
    lang: field(form, 'lang') || 'he',
    timezone: field(form, 'timezone') || DEFAULT_TIMEZONE,
  }
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Fails closed twice over: an unset secret or an unset user means this route
  // answers 401 to everything, so shipping the code before configuring it cannot
  // quietly open an unauthenticated door onto the assistant.
  if (!TOKEN || !USER_EMAIL) {
    return NextResponse.json({ ok: false, error: 'not_configured' }, { status: 401 })
  }

  const presented = bearerFrom(req)
  // `safeEqual` returns false on a length mismatch rather than throwing, so a
  // wrong-length token is a 401 and not a 500.
  if (!presented || !safeEqual(presented, TOKEN)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  // Keyed on the token, not the caller's IP: the point is to bound what ONE
  // credential can spend, and a phone's IP changes with every cell handover.
  const rateKey = `ingest:${crypto.createHash('sha256').update(TOKEN).digest('hex').slice(0, 16)}`
  const limit = checkRateLimit(rateKey, RATE_MAX_INGEST)
  if (!limit.allowed) {
    return NextResponse.json(
      { ok: false, error: 'rate_limited', reply: 'יותר מדי בקשות. נסה שוב עוד כמה דקות.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)) } },
    )
  }

  const userId = getUserIdByEmail(USER_EMAIL)
  if (!userId) {
    // Configured for an account that does not exist. Loud, because the quiet
    // alternative is writing events into nowhere and reporting success.
    console.error(`[ingest] SHORTCUT_USER_EMAIL matches no account: ${USER_EMAIL}`)
    return NextResponse.json({ ok: false, error: 'unknown_user' }, { status: 500 })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: 'no_api_key', reply: 'אין מפתח API מוגדר בשרת.' },
      { status: 500 },
    )
  }

  // Read before the main try so that a body we cannot parse answers 400 rather
  // than the 500 the catch-all would give it. "The server broke" is the wrong
  // thing to tell a caller that sent a bad request.
  let incoming: Incoming | null
  try {
    incoming = await readIncoming(req)
  } catch {
    incoming = null
  }
  if (!incoming) {
    return NextResponse.json(
      { ok: false, error: 'bad_request', reply: 'לא קיבלתי הקלטה או טקסט.' },
      { status: 400 },
    )
  }

  try {
    // ── What was said ────────────────────────────────────────────────────────
    const { typed, audio, lang, timezone } = incoming

    let heard = typed
    if (!heard) {
      if (!audio) {
        return NextResponse.json(
          { ok: false, error: 'no_input', reply: 'לא קיבלתי הקלטה.' },
          { status: 400 },
        )
      }
      // Blobs under 4KB come back as '' by design, and the hallucination filter
      // turns a transcript of pure silence into '' too. Both mean the same thing
      // here: a stray press of the Action Button must not become a turn.
      heard = (await transcribeAudio(audio, lang)).trim()
    }

    if (!heard) {
      return NextResponse.json({ ok: true, heard: '', reply: 'לא שמעתי כלום.', created: [] })
    }

    // ── Everything the turn needs, read here rather than trusted from outside ──
    const events = userStore.getEvents(userId)
    const tasks = userStore.getTasks(userId)
    const memory = readJsonFile<AIMemory[]>(memoryFile(userId), [])
      .map(m => ({ key: m.key, value: m.value }))
    const profile = readJsonFile<UserProfile | null>(profileFile(userId), null)
    const history = readJsonFile<StoredMessage[]>(chatFile(userId), [])

    const messages = [
      ...history
        .slice(-HISTORY_TURNS)
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user' as const, content: heard },
    ]

    const turn = await runTurn({
      userId, messages, events, profile, memory, tasks, timezone, apiKey,
      maxLoopMs: INGEST_MAX_LOOP_MS,
    })

    const reply = turn.text || turn.fallbackText

    // ── Make it part of the same conversation ────────────────────────────────
    // Written straight to the file, never through POST /api/chat-history: that
    // route overwrites the whole array from the client's copy, so posting there
    // would race an open tab. Read-modify-write across an await is exactly the
    // shape `withUserLock` exists for.
    await withUserLock(userId, () => {
      const current = readJsonFile<StoredMessage[]>(chatFile(userId), [])
      const stamp = new Date().toISOString()
      current.push(
        { id: crypto.randomUUID(), role: 'user', content: heard, timestamp: stamp },
        { id: crypto.randomUUID(), role: 'assistant', content: reply, timestamp: stamp },
      )
      writeJsonFileAtomic(chatFile(userId), current.slice(-MAX_MESSAGES))
    })

    return NextResponse.json({
      ok: true,
      heard,
      reply,
      created: turn.createdEvents.map(e => ({ title: e.title, start: e.start_time, end: e.end_time })),
      updated: turn.updatedEvents.length,
      deleted: turn.deletedEventIds.length,
    })
  } catch (err) {
    console.error('[ingest] failed:', err)
    // The Shortcut shows `reply` whatever happens, so it must always be a sentence
    // a human can act on rather than a stack trace.
    return NextResponse.json(
      { ok: false, error: 'internal', reply: 'משהו נכשל בצד השרת. תפתח את האפליקציה ותבדוק.' },
      { status: 500 },
    )
  }
}
