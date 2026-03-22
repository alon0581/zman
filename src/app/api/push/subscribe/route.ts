import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServerClient } from '@/lib/supabase/server'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const DEMO_MODE = !process.env.NEXT_PUBLIC_SUPABASE_URL?.startsWith('http')

function getUserId(req: NextRequest): string | null {
  const cookie = req.cookies.get('zman_session')?.value
  if (!cookie) return null
  try {
    const [payload] = cookie.split('.')
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString())
    return data.userId ?? null
  } catch { return null }
}

function profilePath(userId: string) {
  return path.join(process.cwd(), 'data', 'users', userId, 'profile.json')
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { subscription: string; type?: string }
  const { subscription, type } = body
  if (!subscription) return NextResponse.json({ error: 'missing subscription' }, { status: 400 })

  // type='fcm' means this is a native Capacitor FCM token (Android/iOS)
  // type='vapid' or undefined means this is a Web Push subscription object
  const isFcm = type === 'fcm'
  const field = isFcm ? 'fcm_token' : 'push_subscription'

  if (DEMO_MODE) {
    const userId = getUserId(req)
    if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    const p = profilePath(userId)
    try {
      const profile = JSON.parse(fs.readFileSync(p, 'utf8'))
      profile[field] = subscription
      fs.writeFileSync(p, JSON.stringify(profile, null, 2))
    } catch { return NextResponse.json({ error: 'profile not found' }, { status: 404 }) }
    return NextResponse.json({ ok: true })
  }

  // Supabase mode
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  await supabase.from('user_profiles').upsert({ user_id: user.id, [field]: subscription })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  if (DEMO_MODE) {
    const userId = getUserId(req)
    if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    const p = profilePath(userId)
    try {
      const profile = JSON.parse(fs.readFileSync(p, 'utf8'))
      delete profile.push_subscription
      fs.writeFileSync(p, JSON.stringify(profile, null, 2))
    } catch {}
    return NextResponse.json({ ok: true })
  }
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  await supabase.from('user_profiles').upsert({ user_id: user.id, push_subscription: null })
  return NextResponse.json({ ok: true })
}
