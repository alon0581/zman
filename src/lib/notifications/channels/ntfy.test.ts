import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defaultTopicFor, isNtfyConfigured, sendNtfy } from './ntfy'

const ORIGINAL = { ...process.env }

beforeEach(() => {
  process.env.NTFY_TOPIC_SECRET = 'test-secret-value'
  delete process.env.NTFY_SERVER
})

afterEach(() => {
  process.env = { ...ORIGINAL }
  vi.restoreAllMocks()
})

describe('topic derivation', () => {
  it('is stable for the same user', () => {
    expect(defaultTopicFor('user-a')).toBe(defaultTopicFor('user-a'))
  })

  it('differs between users', () => {
    expect(defaultTopicFor('user-a')).not.toBe(defaultTopicFor('user-b'))
  })

  it('is not guessable from the user id alone — the secret changes it', () => {
    const withOne = defaultTopicFor('user-a')
    process.env.NTFY_TOPIC_SECRET = 'a-completely-different-secret'
    expect(defaultTopicFor('user-a')).not.toBe(withOne)
  })

  it('leaks nothing about the user id', () => {
    const topic = defaultTopicFor('alon@example.com')!
    expect(topic).not.toContain('alon')
    expect(topic).not.toContain('example')
  })

  it('refuses to invent a topic with no secret, rather than using a predictable one', () => {
    delete process.env.NTFY_TOPIC_SECRET
    delete process.env.AUTH_SECRET
    expect(defaultTopicFor('user-a')).toBeNull()
    expect(isNtfyConfigured()).toBe(false)
  })
})

describe('delivery', () => {
  it('posts the body as-is and encodes a Hebrew title for the wire', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    const ok = await sendNtfy('topic-x', { title: 'תזכורת', body: 'שיעור מתחיל בעוד 10 דקות' })

    expect(ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://ntfy.sh/topic-x')
    expect(init.body).toBe('שיעור מתחיל בעוד 10 דקות')
    // Latin-1-only headers: the Hebrew title must go out RFC 2047 encoded.
    expect(init.headers.Title).toMatch(/^=\?UTF-8\?B\?/)
    expect(Buffer.from(init.headers.Title.slice(10, -2), 'base64').toString('utf-8')).toBe('תזכורת')
  })

  it('honours a self-hosted server', async () => {
    process.env.NTFY_SERVER = 'https://push.example.com/'
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    await sendNtfy('t', { title: 'a', body: 'b' })
    expect(fetchMock.mock.calls[0][0]).toBe('https://push.example.com/t')
  })

  it('reports failure without throwing, so one bad topic cannot kill the cron run', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => 'rate limited' }))
    await expect(sendNtfy('t', { title: 'a', body: 'b' })).resolves.toBe(false)

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    await expect(sendNtfy('t', { title: 'a', body: 'b' })).resolves.toBe(false)
  })
})
