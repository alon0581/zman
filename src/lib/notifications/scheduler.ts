/**
 * Smart notification scheduler — determines what to send to whom.
 *
 * Called by the cron endpoint every 5 minutes. For each user, checks:
 * 1. Pre-event reminders (varies by event type)
 * 2. Morning briefing (wake_time + 15 min)
 * 3. Evening review (sleep_time - 60 min)
 * 4. Task nudge (free now + pending tasks, max 1 per 3 hours)
 */

import { CalendarEvent, UserProfile, Task } from '@/types'
import { classifyMobility } from '@/lib/scheduling/mobilityClassifier'
import {
  preEventMessage,
  morningBriefingMessage,
  eveningReviewMessage,
  taskNudgeMessage,
} from './templates'

// ── Reminder lead-time by event category ────────────────────────────────────

const SPORT_KEYWORDS = [
  'ספורט', 'כושר', 'אימון', 'חדר כושר', 'ריצה', 'שחייה', 'יוגה',
  'gym', 'sport', 'fitness', 'workout', 'running', 'swimming', 'yoga',
]

/** How many minutes before the event to send a reminder */
export function getReminderMinutes(title: string, createdBy: 'user' | 'ai'): number {
  const lower = title.toLowerCase()

  // Sport/gym → 45 min (time to change, travel)
  for (const kw of SPORT_KEYWORDS) {
    if (lower.includes(kw)) return 45
  }

  // Fixed events (exam, lecture, flight) → 30 min
  const mobility = classifyMobility(title, createdBy)
  if (mobility === 'fixed') return 30

  // AI-created flexible sessions → 5 min
  if (mobility === 'flexible' && createdBy === 'ai') return 5

  // Default → 15 min
  return 15
}

// ── Time helpers ────────────────────────────────────────────────────────────

/** Parse "HH:MM" or "H:MM" into { hour, minute } */
function parseTime(s: string): { hour: number; minute: number } | null {
  const m = s.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  return { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10) }
}

/** Get current time in user's timezone as { hour, minute, dateStr } */
export function getUserLocalTime(timezone?: string): { hour: number; minute: number; dateStr: string } {
  const now = new Date()
  if (!timezone) {
    return {
      hour: now.getHours(),
      minute: now.getMinutes(),
      dateStr: now.toISOString().slice(0, 10),
    }
  }
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now)
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? '0'
    return {
      hour: parseInt(get('hour'), 10),
      minute: parseInt(get('minute'), 10),
      dateStr: `${get('year')}-${get('month')}-${get('day')}`,
    }
  } catch {
    return { hour: now.getHours(), minute: now.getMinutes(), dateStr: now.toISOString().slice(0, 10) }
  }
}

/** Convert hour:minute to total minutes since midnight */
function toMinutes(h: number, m: number): number { return h * 60 + m }

/** Format hour:minute as "HH:MM" */
function fmt(h: number, m: number): string {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// ── Notification result type ────────────────────────────────────────────────

export interface NotificationPayload {
  title: string
  body: string
  url?: string
  tag?: string
}

export interface SchedulerResult {
  notifications: NotificationPayload[]
  profileUpdates: Partial<UserProfile>
}

// ── Main scheduler ──────────────────────────────────────────────────────────

export function computeNotifications(
  profile: UserProfile,
  events: CalendarEvent[],
  tasks: Task[],
  timezone?: string,
): SchedulerResult {
  const notifications: NotificationPayload[] = []
  const profileUpdates: Partial<UserProfile> = {}
  const isHe = (profile.language ?? 'en') === 'he'
  const { hour, minute, dateStr } = getUserLocalTime(timezone)
  const nowMin = toMinutes(hour, minute)

  // ── 1. Pre-event reminders ──────────────────────────────────────────────
  if (profile.notify_pre_event !== false) {
    // Clean sent list: keep only today's entries to avoid unbounded growth
    const sentToday = (profile.sent_event_notifications ?? [])
      .filter(s => s.endsWith(`-${dateStr}`))
    const sentSet = new Set(sentToday)

    const todayEvents = events.filter(e => e.start_time.startsWith(dateStr) && !e.is_all_day)
    const newSent: string[] = []

    for (const ev of todayEvents) {
      const sentKey = `${ev.id}-${dateStr}`
      if (sentSet.has(sentKey)) continue  // already sent today — skip

      const startMatch = ev.start_time.match(/T(\d{2}):(\d{2})/)
      if (!startMatch) continue
      const evStartMin = toMinutes(parseInt(startMatch[1], 10), parseInt(startMatch[2], 10))
      const reminderMin = getReminderMinutes(ev.title, ev.created_by)
      const diff = evStartMin - nowMin

      // 9-minute window: handles up to 4 min cron delay without missing
      // reminderMin-4 → reminderMin+5: any cron run within this range sends once
      if (diff >= reminderMin - 4 && diff < reminderMin + 5) {
        const msg = preEventMessage(ev.title, reminderMin, isHe)
        notifications.push({ ...msg, url: '/app', tag: `pre-event-${ev.id}` })
        newSent.push(sentKey)
      }
    }

    if (newSent.length > 0) {
      profileUpdates.sent_event_notifications = [...sentToday, ...newSent]
    }
  }

  // ── 2. Morning briefing ─────────────────────────────────────────────────
  if (profile.notify_morning_briefing !== false && profile.last_morning_briefing_date !== dateStr) {
    const wake = parseTime(profile.wake_time ?? '07:00')
    if (wake) {
      const targetMin = toMinutes(wake.hour, wake.minute) + 15
      if (nowMin >= targetMin - 4 && nowMin < targetMin + 5) {
        const todayEvents = events.filter(e => e.start_time.startsWith(dateStr) && !e.is_all_day)
        todayEvents.sort((a, b) => a.start_time.localeCompare(b.start_time))
        const first = todayEvents[0]
        const firstTime = first ? (() => {
          const m = first.start_time.match(/T(\d{2}):(\d{2})/)
          return m ? `${m[1]}:${m[2]}` : null
        })() : null
        const urgentTasks = tasks.filter(t =>
          t.status !== 'done' && t.deadline && t.deadline.startsWith(dateStr)
        )
        const msg = morningBriefingMessage(todayEvents.length, firstTime, urgentTasks.length, isHe)
        notifications.push({ ...msg, url: '/app', tag: 'morning-briefing' })
        profileUpdates.last_morning_briefing_date = dateStr
      }
    }
  }

  // ── 3. Evening review ───────────────────────────────────────────────────
  if (profile.notify_evening_review !== false && profile.last_evening_review_date !== dateStr) {
    const sleep = parseTime(profile.sleep_time ?? '23:00')
    if (sleep) {
      const targetMin = toMinutes(sleep.hour, sleep.minute) - 60
      if (nowMin >= targetMin - 4 && nowMin < targetMin + 5) {
        // Compute tomorrow's date
        const tomorrow = new Date()
        tomorrow.setDate(tomorrow.getDate() + 1)
        const tomorrowStr = tomorrow.toISOString().slice(0, 10)

        const tomorrowEvents = events.filter(e => e.start_time.startsWith(tomorrowStr) && !e.is_all_day)
        tomorrowEvents.sort((a, b) => a.start_time.localeCompare(b.start_time))
        const earliest = tomorrowEvents[0]
        const earliestTime = earliest ? (() => {
          const m = earliest.start_time.match(/T(\d{2}):(\d{2})/)
          return m ? `${m[1]}:${m[2]}` : null
        })() : null

        const unfinished = tasks.filter(t => t.status !== 'done' && t.deadline && t.deadline.startsWith(dateStr))
        const msg = eveningReviewMessage(
          tomorrowEvents.length, earliestTime, earliest?.title ?? null, unfinished.length, isHe
        )
        notifications.push({ ...msg, url: '/app', tag: 'evening-review' })
        profileUpdates.last_evening_review_date = dateStr
      }
    }
  }

  // ── 4. Task nudge ───────────────────────────────────────────────────────
  if (profile.notify_task_nudge !== false) {
    // Throttle: max 1 nudge per 3 hours
    const lastNudge = profile.last_nudge_at ? new Date(profile.last_nudge_at).getTime() : 0
    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000

    if (lastNudge < threeHoursAgo) {
      const pendingTasks = tasks.filter(t => t.status !== 'done')
      if (pendingTasks.length > 0) {
        // Check if user is free right now
        const todayEvents = events.filter(e => e.start_time.startsWith(dateStr) && !e.is_all_day)
        const busyNow = todayEvents.some(ev => {
          const startMatch = ev.start_time.match(/T(\d{2}):(\d{2})/)
          const endMatch = ev.end_time.match(/T(\d{2}):(\d{2})/)
          if (!startMatch || !endMatch) return false
          const s = toMinutes(parseInt(startMatch[1], 10), parseInt(startMatch[2], 10))
          const e = toMinutes(parseInt(endMatch[1], 10), parseInt(endMatch[2], 10))
          return nowMin >= s && nowMin < e
        })

        if (!busyNow) {
          // Find how long the free slot is (until next event or end of day)
          const upcoming = todayEvents
            .map(ev => {
              const m = ev.start_time.match(/T(\d{2}):(\d{2})/)
              return m ? toMinutes(parseInt(m[1], 10), parseInt(m[2], 10)) : null
            })
            .filter((m): m is number => m !== null && m > nowMin)
            .sort((a, b) => a - b)

          const sleepMin = toMinutes(
            parseInt(profile.sleep_time?.split(':')[0] ?? '23', 10),
            parseInt(profile.sleep_time?.split(':')[1] ?? '0', 10),
          )
          const nextBusy = upcoming[0] ?? sleepMin
          const freeMinutes = nextBusy - nowMin

          if (freeMinutes >= 30) {
            // Pick highest priority pending task
            const sorted = [...pendingTasks].sort((a, b) => {
              const prio = { high: 0, medium: 1, low: 2 }
              return (prio[a.priority] ?? 1) - (prio[b.priority] ?? 1)
            })
            const task = sorted[0]
            const msg = taskNudgeMessage(freeMinutes, task.title, isHe)
            notifications.push({ ...msg, url: '/app', tag: 'task-nudge' })
            profileUpdates.last_nudge_at = new Date().toISOString()
          }
        }
      }
    }
  }

  return { notifications, profileUpdates }
}
