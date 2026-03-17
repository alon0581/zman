import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'
import fs from 'fs'
import path from 'path'

const DEMO_MODE = !process.env.NEXT_PUBLIC_SUPABASE_URL?.startsWith('http')
const MAX_MESSAGES = 100

interface StoredMessage {
  id: string
  role: string
  content: string
  timestamp: string
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

function chatFile(userId: string) {
  return path.join(process.cwd(), 'data', 'users', userId, 'chat-history.json')
}

function ensureUserDir(userId: string) {
  const dir = path.join(process.cwd(), 'data', 'users', userId)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function readMessages(userId: string): StoredMessage[] {
  try {
    const file = chatFile(userId)
    if (!fs.existsSync(file)) return []
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch { return [] }
}

export async function GET(req: NextRequest) {
  const userId = await getAuthUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const messages = DEMO_MODE ? readMessages(userId) : []

  const { searchParams } = new URL(req.url)
  const since = searchParams.get('since')
  if (since) {
    const sinceTs = new Date(since).getTime()
    return NextResponse.json({ messages: messages.filter(m => new Date(m.timestamp).getTime() > sinceTs) })
  }
  return NextResponse.json({ messages })
}

export async function POST(req: NextRequest) {
  const userId = await getAuthUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as { messages: StoredMessage[] }
  if (!Array.isArray(body.messages)) return NextResponse.json({ error: 'Invalid' }, { status: 400 })

  if (DEMO_MODE) {
    ensureUserDir(userId)
    fs.writeFileSync(chatFile(userId), JSON.stringify(body.messages.slice(-MAX_MESSAGES), null, 2))
  }
  // Supabase: no chat schema — no-op for now
  return NextResponse.json({ ok: true })
}
