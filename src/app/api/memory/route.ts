import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'
import { AIMemory } from '@/types'
import fs from 'fs'
import path from 'path'

const DEMO_MODE = !process.env.NEXT_PUBLIC_SUPABASE_URL?.startsWith('http')

function memoryFile(userId: string) {
  return path.join(process.cwd(), 'data', 'users', userId, 'memory.json')
}

function readMemory(userId: string): AIMemory[] {
  try {
    const file = memoryFile(userId)
    if (!fs.existsSync(file)) return []
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch { return [] }
}

function writeMemory(userId: string, memory: AIMemory[]) {
  const dir = path.dirname(memoryFile(userId))
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(memoryFile(userId), JSON.stringify(memory, null, 2))
}

async function getAuthUserId(req: NextRequest): Promise<string | null> {
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

export async function GET(req: NextRequest) {
  const userId = await getAuthUserId(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json(readMemory(userId))
}

export async function DELETE(req: NextRequest) {
  const userId = await getAuthUserId(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json() as { all?: boolean; keys?: string[] }
  if (body.all) {
    writeMemory(userId, [])
    return NextResponse.json({ deleted: 'all' })
  }
  const keys: string[] = body.keys ?? []
  const filtered = readMemory(userId).filter(m => !keys.includes(m.key))
  writeMemory(userId, filtered)
  return NextResponse.json(filtered)
}

export async function POST(req: NextRequest) {
  const userId = await getAuthUserId(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { entries, source = 'explicit' } = await req.json() as {
    entries: Array<{ key: string; value: string }>
    source?: AIMemory['learned_from']
  }
  const existing = readMemory(userId)
  for (const entry of entries) {
    const idx = existing.findIndex(m => m.key === entry.key)
    const item: AIMemory = {
      id: idx >= 0 ? existing[idx].id : crypto.randomUUID(),
      user_id: userId,
      key: entry.key,
      value: entry.value,
      learned_from: source,
      created_at: idx >= 0 ? existing[idx].created_at : new Date().toISOString(),
    }
    if (idx >= 0) existing[idx] = item
    else existing.push(item)
  }
  writeMemory(userId, existing)
  return NextResponse.json(existing)
}
