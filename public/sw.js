const CACHE = 'zman-v1'
const PRECACHE = ['/app', '/manifest.json', '/api/icon/192']

// ── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE).catch(() => {}))
      .then(() => self.skipWaiting())
  )
})

// ── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

// ── Push notification received ───────────────────────────────────────────────
self.addEventListener('push', e => {
  let data = {}
  try { data = e.data?.json() ?? {} } catch {}

  const title   = data.title   ?? 'Zman'
  const body    = data.body    ?? ''
  const url     = data.url     ?? '/app'
  const tag     = data.tag     ?? 'zman'

  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon:    '/api/icon/192',
      badge:   '/api/icon/192',
      tag,
      renotify: true,
      data:    { url },
      vibrate: [200, 100, 200],
    })
  )
})

// ── Notification click ───────────────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close()
  const url = e.notification.data?.url ?? '/app'
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
      const existing = cs.find(c => c.url.includes('/app'))
      if (existing) return existing.focus()
      return clients.openWindow(url)
    })
  )
})
