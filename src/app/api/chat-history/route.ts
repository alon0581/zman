import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'
import { DATA_DIR } from '@/lib/util/dataDir'
import { readJsonFile, writeJsonFileAtomic } from '@/lib/util/jsonStore'
import { assertSafeUserId } from '@/lib/util/safeUserId'
import path from 'path'

const MAX_MESSAGES = 100

interface StoredMessage {
  id: string
  role: string
  content: string
  timestamp: string
}

async function getAuthUserId(): Promise<string | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(COOKIE_NAME)?.value
  return getUserIdFromCookie(token)
}

function chatFile(userId: string) {
  // Every other store guards the id before it reaches a path; this one didn't.
  return path.join(DATA_DIR, 'users', assertSafeUserId(userId), 'chat-history.json')
}

function readMessages(userId: string): StoredMessage[] {
  return readJsonFile<StoredMessage[]>(chatFile(userId), [])
}

export async function GET(req: NextRequest) {
  const userId = await getAuthUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const messages = readMessages(userId)

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

  // Whole-file overwrite — nothing is read first, so no lock is needed.
  writeJsonFileAtomic(chatFile(userId), body.messages.slice(-MAX_MESSAGES))
  return NextResponse.json({ ok: true })
}
