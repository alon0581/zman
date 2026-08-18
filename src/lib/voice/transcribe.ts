import OpenAI from 'openai'

function getOpenAI(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY not set')
  return new OpenAI({ apiKey })
}

export interface TranscribeOptions {
  // Injectable OpenAI client — lets callers (and tests) supply their own
  // instance instead of one built from OPENAI_API_KEY.
  client?: OpenAI
}

/**
 * Transcribe an audio clip to text.
 *
 * Pulled out of the cookie-authenticated `/api/transcribe` route so a second,
 * differently-authenticated caller (a machine-callable endpoint for an iPhone
 * Shortcut) can reuse the exact same transcription behaviour. This function
 * owns only the audio-to-text step — auth and request parsing stay with the
 * caller.
 */
export async function transcribeAudio(
  audio: File | Blob,
  lang: string | null | undefined,
  options: TranscribeOptions = {}
): Promise<string> {
  // Reject tiny blobs — silence or accidental tap (< 4 KB)
  if (audio.size < 4000) return ''

  const whisperLang = (!lang || lang === 'auto') ? undefined : lang

  const prompt = lang === 'he'
    ? 'לוח שנה, פגישות, אירועים, משימות, תזכורות, מועדים. זמן פנוי, שיעורים, בחינות, אימון, ספורט.'
    : 'Calendar scheduling. Appointments, meetings, events, tasks, reminders, deadlines.'

  const client = options.client ?? getOpenAI()

  // gpt-4o-transcribe is markedly better on Hebrew than whisper-1, which is the
  // oldest transcription model OpenAI still serves. Overridable by env so a
  // model rename can be fixed without a deploy, and it falls back to whisper-1
  // below rather than leaving the mic dead if the newer model is unavailable.
  let transcription
  try {
    transcription = await client.audio.transcriptions.create({
      file: audio,
      model: process.env.TRANSCRIBE_MODEL || 'gpt-4o-transcribe',
      language: whisperLang ?? undefined,
      prompt,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Only fall back for "this model doesn't exist / isn't yours" — a quota or
    // auth failure would fail identically on whisper-1, so retrying wastes a
    // round-trip and hides the real cause.
    if (!/model/i.test(msg) || !/(not found|does not exist|no access|invalid)/i.test(msg)) throw err
    console.warn('[transcribe] falling back to whisper-1:', msg)
    transcription = await client.audio.transcriptions.create({
      file: audio,
      model: 'whisper-1',
      language: whisperLang ?? undefined,
      prompt,
    })
  }

  // Reject common Whisper hallucinations on silence
  const hallucinationPhrases = [
    'thank you', 'thanks for watching', 'תודה רבה', 'תודה',
    'שלום', 'bye', 'goodbye', 'see you', 'subscribe',
  ]
  const lower = transcription.text.trim().toLowerCase()
  const isHallucination = hallucinationPhrases.some(p => lower === p || lower === p + '.' || lower === p + '!')
  if (isHallucination) return ''

  return transcription.text
}
