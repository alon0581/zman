import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type OpenAI from 'openai'
import { transcribeAudio } from './transcribe'

// Build a fake OpenAI client whose transcriptions.create is a mock we control.
// Typed loosely and cast, since only the one method the module calls matters.
function fakeClient(create: (...args: unknown[]) => unknown) {
  return {
    audio: { transcriptions: { create: vi.fn(create) } },
  } as unknown as OpenAI
}

// A Blob of at least 4000 bytes so it clears the tiny-blob short-circuit.
function bigBlob(bytes = 5000): Blob {
  return new Blob([new Uint8Array(bytes)])
}

describe('transcribeAudio', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  describe('minimum blob size', () => {
    it('returns empty text for a blob under 4000 bytes without calling OpenAI', async () => {
      const create = vi.fn()
      const client = fakeClient(create)
      const audio = new Blob([new Uint8Array(3999)])

      const text = await transcribeAudio(audio, 'he', { client })

      expect(text).toBe('')
      expect(create).not.toHaveBeenCalled()
    })

    it('does call OpenAI once the blob reaches 4000 bytes', async () => {
      const create = vi.fn().mockResolvedValue({ text: 'קבע פגישה' })
      const client = fakeClient(create)
      const audio = new Blob([new Uint8Array(4000)])

      const text = await transcribeAudio(audio, 'he', { client })

      expect(text).toBe('קבע פגישה')
      expect(create).toHaveBeenCalledTimes(1)
    })
  })

  describe('hallucination filter', () => {
    const phrases = [
      'thank you', 'thanks for watching', 'תודה רבה', 'תודה',
      'שלום', 'bye', 'goodbye', 'see you', 'subscribe',
    ]

    it.each(phrases)('rejects a transcript that is only "%s"', async (phrase) => {
      const create = vi.fn().mockResolvedValue({ text: phrase })
      const client = fakeClient(create)

      const text = await transcribeAudio(bigBlob(), 'he', { client })

      expect(text).toBe('')
    })

    it.each(phrases)('rejects "%s" with trailing punctuation and different case', async (phrase) => {
      const create = vi.fn().mockResolvedValue({ text: `${phrase.toUpperCase()}!` })
      const client = fakeClient(create)

      const text = await transcribeAudio(bigBlob(), 'he', { client })

      expect(text).toBe('')
    })

    it('does not reject a real transcript that merely contains a hallucination phrase as a substring', async () => {
      const create = vi.fn().mockResolvedValue({ text: 'תודה על ההזמנה, קבע לי פגישה מחר בעשר' })
      const client = fakeClient(create)

      const text = await transcribeAudio(bigBlob(), 'he', { client })

      expect(text).toBe('תודה על ההזמנה, קבע לי פגישה מחר בעשר')
    })

    it('lets a real transcript through untouched', async () => {
      const create = vi.fn().mockResolvedValue({ text: 'קבע לי פגישה עם רופא השיניים ביום שלישי' })
      const client = fakeClient(create)

      const text = await transcribeAudio(bigBlob(), 'he', { client })

      expect(text).toBe('קבע לי פגישה עם רופא השיניים ביום שלישי')
    })
  })

  describe('model selection', () => {
    it('defaults to gpt-4o-transcribe when TRANSCRIBE_MODEL is unset', async () => {
      delete process.env.TRANSCRIBE_MODEL
      const create = vi.fn().mockResolvedValue({ text: 'פגישה' })
      const client = fakeClient(create)

      await transcribeAudio(bigBlob(), 'he', { client })

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-4o-transcribe' })
      )
    })

    it('honours TRANSCRIBE_MODEL when set', async () => {
      process.env.TRANSCRIBE_MODEL = 'custom-model'
      const create = vi.fn().mockResolvedValue({ text: 'פגישה' })
      const client = fakeClient(create)

      await transcribeAudio(bigBlob(), 'he', { client })

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'custom-model' })
      )
    })
  })

  describe('Hebrew priming prompt', () => {
    it('sends the Hebrew scheduling prompt when lang is "he"', async () => {
      const create = vi.fn().mockResolvedValue({ text: 'פגישה' })
      const client = fakeClient(create)

      await transcribeAudio(bigBlob(), 'he', { client })

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'לוח שנה, פגישות, אירועים, משימות, תזכורות, מועדים. זמן פנוי, שיעורים, בחינות, אימון, ספורט.',
        })
      )
    })

    it('sends the English scheduling prompt for any non-Hebrew lang', async () => {
      const create = vi.fn().mockResolvedValue({ text: 'meeting' })
      const client = fakeClient(create)

      await transcribeAudio(bigBlob(), 'en', { client })

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'Calendar scheduling. Appointments, meetings, events, tasks, reminders, deadlines.',
        })
      )
    })
  })

  describe('whisper-1 fallback', () => {
    it('falls back to whisper-1 when the error matches both the model and not-found patterns', async () => {
      const create = vi.fn()
        .mockRejectedValueOnce(new Error('The model `gpt-4o-transcribe` does not exist'))
        .mockResolvedValueOnce({ text: 'פגישה מחר' })
      const client = fakeClient(create)

      const text = await transcribeAudio(bigBlob(), 'he', { client })

      expect(text).toBe('פגישה מחר')
      expect(create).toHaveBeenCalledTimes(2)
      expect(create).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: 'whisper-1' }))
    })

    it('does NOT fall back when the error mentions "model" but not a not-found reason', async () => {
      const error = new Error('model is currently overloaded, try again later')
      const create = vi.fn().mockRejectedValueOnce(error)
      const client = fakeClient(create)

      await expect(transcribeAudio(bigBlob(), 'he', { client })).rejects.toThrow(
        'model is currently overloaded, try again later'
      )
      expect(create).toHaveBeenCalledTimes(1)
    })

    it('does NOT fall back on an unrelated error (quota/auth)', async () => {
      const error = new Error('You exceeded your current quota')
      const create = vi.fn().mockRejectedValueOnce(error)
      const client = fakeClient(create)

      await expect(transcribeAudio(bigBlob(), 'he', { client })).rejects.toThrow(
        'You exceeded your current quota'
      )
      expect(create).toHaveBeenCalledTimes(1)
    })

    it('recognizes each of the not-found phrasings alongside "model"', async () => {
      const reasons = ['not found', 'does not exist', 'no access', 'invalid']
      for (const reason of reasons) {
        const create = vi.fn()
          .mockRejectedValueOnce(new Error(`model xyz: ${reason}`))
          .mockResolvedValueOnce({ text: 'פגישה' })
        const client = fakeClient(create)

        const text = await transcribeAudio(bigBlob(), 'he', { client })

        expect(text).toBe('פגישה')
        expect(create).toHaveBeenCalledTimes(2)
      }
    })
  })
})
