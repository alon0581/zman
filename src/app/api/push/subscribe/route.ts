import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import { getUserIdFromCookie } from '@/lib/auth'
import { assertSafeUserId } from '@/lib/util/safeUserId'
import { readJsonFile, writeJsonFileAtomic } from '@/lib/util/jsonStore'
import { DATA_DIR } from '@/lib/util/dataDir'

function getUserId(req: NextRequest): string | null {
  return getUserIdFromCookie(req.cookies.get('zman_session')?.value)
}

function profilePath(userId: string) {
  return path.join(DATA_DIR, 'users', assertSafeUserId(userId), 'profile.json')
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { subscription: string; type?: string }
  const { subscription, type } = body
  if (!subscription) return NextResponse.json({ error: 'missing subscription' }, { status: 400 })

  // type='fcm' means this is a native Capacitor FCM token (Android/iOS)
  // type='vapid' or undefined means this is a Web Push subscription object
  const isFcm = type === 'fcm'
  const field = isFcm ? 'fcm_token' : 'push_subscription'

  const userId = getUserId(req)
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const p = profilePath(userId)
  const profile = readJsonFile<Record<string, unknown> | null>(p, null)
  if (!profile) return NextResponse.json({ error: 'profile not found' }, { status: 404 })
  profile[field] = subscription
  writeJsonFileAtomic(p, profile)
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const userId = getUserId(req)
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const p = profilePath(userId)
  const profile = readJsonFile<Record<string, unknown> | null>(p, null)
  if (profile) {
    delete profile.push_subscription
    delete profile.fcm_token
    writeJsonFileAtomic(p, profile)
  }
  return NextResponse.json({ ok: true })
}
