/**
 * ntfy delivery channel.
 *
 * Why this exists: the two push paths that came before it both depend on
 * infrastructure that isn't set up. VAPID needs browser keys and only reaches a
 * tab the user has open; FCM needs a Firebase service account that has never
 * been configured on this deployment. So the entire notification feature — 259
 * lines of scheduler logic — has never actually delivered a single message.
 *
 * ntfy needs none of that: an HTTP POST to a topic URL, and the phone app
 * subscribed to that topic rings. No account, no keys, no build step.
 *
 * The trade-off is honest and worth stating: a topic name IS the credential.
 * Anyone who learns it can publish to it (and, on the public server, read it).
 * That is why `defaultTopicFor` derives a long unguessable topic from the user
 * id and a server-side secret rather than using anything human-readable — a
 * topic like "zman-alon" would be trivially guessable by anyone who wanted to
 * push fake reminders at this user.
 */

import crypto from 'crypto'

/** Public server unless NTFY_SERVER points at a self-hosted one. */
const DEFAULT_SERVER = 'https://ntfy.sh'

export interface NtfyPayload {
  title: string
  body: string
  /** Opened when the notification is tapped. */
  url?: string
  /** Collapses repeats of the same kind of reminder on the device. */
  tag?: string
  /** 1 = min … 5 = max. Morning briefings are quieter than a "starts in 10 min". */
  priority?: 1 | 2 | 3 | 4 | 5
}

function server(): string {
  return (process.env.NTFY_SERVER || DEFAULT_SERVER).replace(/\/+$/, '')
}

/**
 * A stable, unguessable topic for a user.
 *
 * Derived rather than stored so it survives a profile reset, and HMAC'd with the
 * server secret so knowing a user id is not enough to publish to their topic.
 * Returns null when there is no secret to derive from — better to send nothing
 * than to fall back to a predictable topic anyone could hijack.
 */
export function defaultTopicFor(userId: string): string | null {
  const secret = process.env.NTFY_TOPIC_SECRET || process.env.AUTH_SECRET
  if (!secret) return null
  const digest = crypto.createHmac('sha256', secret).update(`ntfy:${userId}`).digest('base64url')
  return `zman-${digest.slice(0, 24)}`
}

/** Whether this deployment can deliver via ntfy at all. */
export function isNtfyConfigured(): boolean {
  return !!(process.env.NTFY_TOPIC_SECRET || process.env.AUTH_SECRET)
}

/**
 * Publish one notification. Never throws — a failed reminder must not take down
 * the cron run that is delivering reminders to everyone else.
 *
 * Headers carry the metadata rather than the body, because the body IS the text
 * the user sees on their lock screen. They are latin-1 only on the wire, so the
 * Hebrew title goes out base64-encoded via ntfy's RFC 2047 support.
 */
export async function sendNtfy(topic: string, payload: NtfyPayload): Promise<boolean> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'text/plain; charset=utf-8',
      // Hebrew titles are not latin-1 representable; ntfy accepts RFC 2047.
      Title: `=?UTF-8?B?${Buffer.from(payload.title, 'utf-8').toString('base64')}?=`,
    }
    if (payload.url) headers.Click = payload.url
    if (payload.tag) headers.Tags = payload.tag
    if (payload.priority) headers.Priority = String(payload.priority)

    const res = await fetch(`${server()}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers,
      body: payload.body,
    })
    if (!res.ok) {
      console.warn('[ntfy] delivery failed:', res.status, await res.text().catch(() => ''))
      return false
    }
    return true
  } catch (err) {
    console.warn('[ntfy] delivery threw:', (err as Error)?.message)
    return false
  }
}
