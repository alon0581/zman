/**
 * Client-side push notification helpers.
 * Used by both Header.tsx (bell icon) and SettingsClient.tsx (notifications toggle).
 */

export async function subscribePushNotifications(): Promise<boolean> {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return false
  try {
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return false

    const reg = await navigator.serviceWorker.ready
    const existing = await reg.pushManager.getSubscription()
    const sub = existing ?? await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
    })
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: JSON.stringify(sub) }),
    })
    return true
  } catch {
    return false
  }
}

export async function unsubscribePushNotifications(): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (sub) await sub.unsubscribe()
    await fetch('/api/push/subscribe', { method: 'DELETE' })
  } catch { /* ignore */ }
}

/** Returns current browser notification permission state */
export function getNotificationPermission(): NotificationPermission | 'unsupported' {
  if (!('Notification' in window)) return 'unsupported'
  return Notification.permission
}
