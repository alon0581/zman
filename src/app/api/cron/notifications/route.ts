/**
 * Cron endpoint for smart notifications.
 * Pinged every 5 minutes by an external cron service (e.g. cron-job.org).
 *
 * GET /api/cron/notifications?secret=CRON_SECRET
 */

import { NextRequest, NextResponse } from 'next/server'
import { UserProfile, CalendarEvent, Task } from '@/types'
import { computeNotifications } from '@/lib/notifications/scheduler'
import { sendPush, sendFcmPush } from '@/lib/push'
import fs from 'fs'
import path from 'path'

const DEMO_MODE = !process.env.NEXT_PUBLIC_SUPABASE_URL?.startsWith('http')

export async function GET(req: NextRequest) {
  // Verify cron secret
  const secret = req.nextUrl.searchParams.get('secret')
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const results: { userId: string; sent: number }[] = []

  try {
    if (DEMO_MODE) {
      await processDemoUsers(results)
    } else {
      await processSupabaseUsers(results)
    }
  } catch (err) {
    console.error('[CRON] notification error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }

  const totalSent = results.reduce((sum, r) => sum + r.sent, 0)
  return NextResponse.json({ ok: true, usersChecked: results.length, notificationsSent: totalSent, results })
}

// ── Demo mode: scan data/users/* ────────────────────────────────────────────

async function processDemoUsers(results: { userId: string; sent: number }[]) {
  const usersDir = path.join(process.cwd(), 'data', 'users')
  if (!fs.existsSync(usersDir)) return

  const userIds = fs.readdirSync(usersDir).filter(f => {
    const stat = fs.statSync(path.join(usersDir, f))
    return stat.isDirectory()
  })

  for (const userId of userIds) {
    const profilePath = path.join(usersDir, userId, 'profile.json')
    if (!fs.existsSync(profilePath)) continue

    let profile: UserProfile
    try {
      profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8')) as UserProfile
    } catch { continue }

    // Skip if notifications disabled or no push token
    if (!profile.notifications_enabled) continue
    if (!profile.fcm_token && !profile.push_subscription) continue

    // Load events and tasks
    const eventsPath = path.join(usersDir, userId, 'events.json')
    const tasksPath = path.join(usersDir, userId, 'tasks.json')
    let events: CalendarEvent[] = []
    let tasks: Task[] = []
    try { events = JSON.parse(fs.readFileSync(eventsPath, 'utf-8')) } catch { /* empty */ }
    try { tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf-8')) } catch { /* empty */ }

    const { notifications, profileUpdates } = computeNotifications(profile, events, tasks, profile.timezone)

    // Send notifications
    let sent = 0
    for (const n of notifications) {
      await sendToUser(profile, n)
      sent++
    }

    // Update profile with tracking fields
    if (Object.keys(profileUpdates).length > 0) {
      const updated = { ...profile, ...profileUpdates }
      fs.writeFileSync(profilePath, JSON.stringify(updated, null, 2))
    }

    results.push({ userId, sent })
  }
}

// ── Supabase mode ───────────────────────────────────────────────────────────

async function processSupabaseUsers(results: { userId: string; sent: number }[]) {
  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()

  // Fetch all users with notifications enabled and a push token
  const { data: profiles } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('notifications_enabled', true)

  if (!profiles) return

  for (const profile of profiles as UserProfile[]) {
    if (!profile.fcm_token && !profile.push_subscription) continue

    // Load events (today ± 1 day)
    const now = new Date()
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
    const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2).toISOString()

    const { data: events } = await supabase
      .from('events')
      .select('*')
      .eq('user_id', profile.user_id)
      .gte('start_time', dayStart)
      .lte('start_time', dayEnd)

    const { data: tasks } = await supabase
      .from('tasks')
      .select('*')
      .eq('user_id', profile.user_id)
      .neq('status', 'done')

    const { notifications, profileUpdates } = computeNotifications(
      profile,
      (events ?? []) as CalendarEvent[],
      (tasks ?? []) as Task[],
      profile.timezone,
    )

    let sent = 0
    for (const n of notifications) {
      await sendToUser(profile, n)
      sent++
    }

    if (Object.keys(profileUpdates).length > 0) {
      await supabase.from('user_profiles').update(profileUpdates).eq('user_id', profile.user_id)
    }

    results.push({ userId: profile.user_id, sent })
  }
}

// ── Send helper ─────────────────────────────────────────────────────────────

async function sendToUser(
  profile: UserProfile,
  payload: { title: string; body: string; url?: string; tag?: string }
) {
  // FCM (native) takes priority — most reliable, works when app is closed
  if (profile.fcm_token) {
    await sendFcmPush(profile.fcm_token, payload).catch(() => {})
  } else if (profile.push_subscription) {
    await sendPush(profile.push_subscription, payload).catch(() => {})
  }
}

export const dynamic = 'force-dynamic'
