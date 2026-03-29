import webpush from 'web-push'

// ── VAPID (Web Push for browser PWA) ─────────────────────────────────────────
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
  } catch (err) {
    console.error('[push] VAPID sendNotification failed:', err)
    throw err
  }
}

// ── Firebase FCM (native push for Capacitor Android/iOS) ─────────────────────
// Requires FIREBASE_SERVICE_ACCOUNT env var (JSON string from Firebase console
// → Project Settings → Service Accounts → Generate new private key)
let fcmApp: import('firebase-admin/app').App | null = null

async function getFcmApp() {
  if (fcmApp) return fcmApp
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) return null
  try {
    const { initializeApp, getApps, cert } = await import('firebase-admin/app')
    if (getApps().length > 0) { fcmApp = getApps()[0]; return fcmApp }
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    fcmApp = initializeApp({ credential: cert(serviceAccount) })
    return fcmApp
  } catch {
    return null
  }
}

export async function sendFcmPush(
  fcmToken: string,
  payload: { title: string; body: string; url?: string }
) {
  const app = await getFcmApp()
  if (!app) return  // Firebase not configured — silently skip
  try {
    const { getMessaging } = await import('firebase-admin/messaging')
    await getMessaging(app).send({
      token: fcmToken,
      notification: { title: payload.title, body: payload.body },
      data: { url: payload.url ?? '/' },
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default', badge: 1 } } },
    })
  } catch (err) {
    console.error('[push] FCM send failed:', err)
    throw err
  }
}
