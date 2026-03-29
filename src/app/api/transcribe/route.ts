import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'

const DEMO_MODE = !process.env.NEXT_PUBLIC_SUPABASE_URL?.startsWith('http')

function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY not set')
  return new OpenAI({ apiKey })
}

export async function POST(req: NextRequest) {
  if (!DEMO_MODE) {
    const { createClient } = await import('@/lib/supabase/server')
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

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
    const transcription = await getOpenAI().audio.transcriptions.create({
      file: audio,
      model: 'whisper-1',
      language: whisperLang ?? undefined,
      prompt,
    })

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
