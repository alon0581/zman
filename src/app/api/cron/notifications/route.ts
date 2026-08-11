/**
 * Cron endpoint for smart notifications.
 * Pinged every 5 minutes by an external cron service (e.g. cron-job.org).
 *
 * GET /api/cron/notifications?secret=CRON_SECRET
 */

import { NextRequest, NextResponse } from 'next/server'
import { UserProfile, CalendarEvent, Task } from '@/types'
import { computeNotifications } from '@/lib/notifications/scheduler'
import { DATA_DIR } from '@/lib/util/dataDir'
import { readJsonFile, writeJsonFileAtomic } from '@/lib/util/jsonStore'
import { withUserLock } from '@/lib/store/lock'
import { sendPush, sendFcmPush } from '@/lib/push'
import { sendNtfy, defaultTopicFor, isNtfyConfigured } from '@/lib/notifications/channels/ntfy'
import fs from 'fs'
import path from 'path'

export async function GET(req: NextRequest) {
  // Verify cron secret
  const secret = req.nextUrl.searchParams.get('secret')
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const results: { userId: string; sent: number }[] = []

  try {
    await processDemoUsers(results)
  } catch (err) {
    console.error('[CRON] notification error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }

  const totalSent = results.reduce((sum, r) => sum + r.sent, 0)
  return NextResponse.json({ ok: true, usersChecked: results.length, notificationsSent: totalSent, results })
}

// ── Demo mode: scan data/users/* ────────────────────────────────────────────

async function processDemoUsers(results: { userId: string; sent: number }[]) {
  const usersDir = path.join(DATA_DIR, 'users')
  if (!fs.existsSync(usersDir)) return

  const userIds = fs.readdirSync(usersDir).filter(f => {
    const stat = fs.statSync(path.join(usersDir, f))
    return stat.isDirectory()
  })

  for (const userId of userIds) {
    const profilePath = path.join(usersDir, userId, 'profile.json')
    if (!fs.existsSync(profilePath)) continue

    const profile = readJsonFile<UserProfile | null>(profilePath, null)
    if (!profile) continue

    // Skip if notifications disabled or no push token
    if (!profile.notifications_enabled) continue
    // A user with no FCM token and no browser subscription is still reachable via
    // ntfy, so the old "no token, skip" gate silently excluded everyone on this
    // deployment — which is precisely why nothing has ever been delivered.
    if (!profile.fcm_token && !profile.push_subscription && !isNtfyConfigured()) continue

    // Load events and tasks
    const eventsPath = path.join(usersDir, userId, 'events.json')
    const tasksPath = path.join(usersDir, userId, 'tasks.json')
    const events = readJsonFile<CalendarEvent[]>(eventsPath, [])
    const tasks = readJsonFile<Task[]>(tasksPath, [])

    const { notifications, profileUpdates } = computeNotifications(profile, events, tasks, profile.timezone)

    // Sending is network I/O and deliberately runs OUTSIDE the user lock. Holding
    // a lock across a push round-trip would stall that user's own requests — the
    // app's profile load takes the same lock — for as long as delivery takes.
    let sent = 0
    for (const n of notifications) {
      await sendToUser(profile, n)
      sent++
    }

    // Only the write is locked, and it merges into a FRESH read: a settings save
    // that landed while we were sending is preserved instead of being clobbered
    // by the copy we loaded minutes ago.
    if (Object.keys(profileUpdates).length > 0) {
      await withUserLock(userId, () => {
        const current = readJsonFile<UserProfile | null>(profilePath, null)
        if (!current) return
        writeJsonFileAtomic(profilePath, { ...current, ...profileUpdates })
      })
    }

    results.push({ userId, sent })
  }
}

// ── Send helper ─────────────────────────────────────────────────────────────

async function sendToUser(
  profile: UserProfile,
  payload: { title: string; body: string; url?: string; tag?: string }
) {
  // One channel per notification, never two — the moment a second one works the
  // user gets every reminder twice, which is worse than the channel being wrong.
  //
  // ntfy leads when it is configured because it is the only path that reaches a
  // phone on this deployment today: FCM needs a Firebase service account that was
  // never set up, and VAPID only reaches a browser tab the user has open. FCM
  // stays ahead of VAPID below for when that service account does get configured
  // — at which point leaving NTFY_TOPIC_SECRET unset hands delivery back to it.
  const topic = profile.ntfy_topic || defaultTopicFor(profile.user_id)
  if (topic && isNtfyConfigured()) {
    await sendNtfy(topic, payload)
    return
  }
  if (profile.fcm_token) {
    await sendFcmPush(profile.fcm_token, payload).catch(() => {})
  } else if (profile.push_subscription) {
    await sendPush(profile.push_subscription, payload).catch(() => {})
  }
}

export const dynamic = 'force-dynamic'
