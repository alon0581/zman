'use client'

/**
 * Native push notification registration via Capacitor.
 * Called on app mount when running as a native Android/iOS app.
 * Falls back silently in browser (uses VAPID web-push instead).
 */
export async function registerCapacitorPush(
  onToken: (fcmToken: string) => Promise<void>
): Promise<void> {
  // Only run in native Capacitor context
  if (typeof window === 'undefined') return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!(window as any).Capacitor?.isNativePlatform?.()) return

  try {
    const { PushNotifications } = await import('@capacitor/push-notifications')

    const perm = await PushNotifications.requestPermissions()
    if (perm.receive !== 'granted') return

    await PushNotifications.register()

    PushNotifications.addListener('registration', async ({ value }) => {
      // value = FCM token (Android) or APNs token (iOS)
      try { await onToken(value) } catch { /* ignore */ }
    })

    PushNotifications.addListener('registrationError', err => {
      console.warn('[Zman] Push registration error:', err)
    })
  } catch {
    // @capacitor/push-notifications not available or init error — ignore
  }
}
