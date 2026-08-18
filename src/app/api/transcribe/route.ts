import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'
import { transcribeAudio } from '@/lib/voice/transcribe'

async function getAuthUserId(): Promise<string | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(COOKIE_NAME)?.value
  return getUserIdFromCookie(token)
}

export async function POST(req: NextRequest) {
  const userId = await getAuthUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const formData = await req.formData()
  const audio = formData.get('audio') as File
  const lang = formData.get('lang') as string | null

  if (!audio) return NextResponse.json({ error: 'No audio' }, { status: 400 })

  try {
    const text = await transcribeAudio(audio, lang)
    return NextResponse.json({ text })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('Transcribe error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
