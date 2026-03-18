import webpush from 'web-push'

if (process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:zman@zman.app',
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  )
}

export async function sendPush(
  subscription: string,
  payload: { title: string; body: string; url?: string; tag?: string }
) {
  if (!process.env.VAPID_PRIVATE_KEY) return
  try {
    const sub = JSON.parse(subscription) as webpush.PushSubscription
    await webpush.sendNotification(sub, JSON.stringify(payload))
  } catch {
    // Subscription expired or invalid — caller should clear it
  }
}
