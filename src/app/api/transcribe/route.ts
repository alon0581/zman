import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import OpenAI from 'openai'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'

const DEMO_MODE = !process.env.NEXT_PUBLIC_SUPABASE_URL?.startsWith('http')

function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY not set')
  return new OpenAI({ apiKey })
}

async function getAuthUserId(): Promise<string | null> {
  if (DEMO_MODE) {
    const cookieStore = await cookies()
    const token = cookieStore.get(COOKIE_NAME)?.value
    return getUserIdFromCookie(token)
  }
  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user?.id ?? null
}

export async function POST(req: NextRequest) {
  const userId = await getAuthUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const formData = await req.formData()
  const audio = formData.get('audio') as File
  const lang = formData.get('lang') as string | null

  if (!audio) return NextResponse.json({ error: 'No audio' }, { status: 400 })

  // Reject tiny blobs — silence or accidental tap (< 4 KB)
  if (audio.size < 4000) return NextResponse.json({ text: '' })

  const whisperLang = (!lang || lang === 'auto') ? undefined : lang

  const prompt = lang === 'he'
    ? 'לוח שנה, פגישות, אירועים, משימות, תזכורות, מועדים. זמן פנוי, שיעורים, בחינות, אימון, ספורט.'
    : 'Calendar scheduling. Appointments, meetings, events, tasks, reminders, deadlines.'

  try {
    // gpt-4o-transcribe is markedly better on Hebrew than whisper-1, which is the
    // oldest transcription model OpenAI still serves. Overridable by env so a
    // model rename can be fixed without a deploy, and it falls back to whisper-1
    // below rather than leaving the mic dead if the newer model is unavailable.
    let transcription
    try {
      transcription = await getOpenAI().audio.transcriptions.create({
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
      transcription = await getOpenAI().audio.transcriptions.create({
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
    if (isHallucination) return NextResponse.json({ text: '' })

    return NextResponse.json({ text: transcription.text })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('Transcribe error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
