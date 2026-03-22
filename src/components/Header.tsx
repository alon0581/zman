'use client'

import { User } from '@supabase/supabase-js'
import { UserProfile } from '@/types'
import { createClient } from '@/lib/supabase/client'
import { Settings, Sun, Moon, LogOut, Bell, BellOff } from 'lucide-react'
import Link from 'next/link'
import { useState, useEffect } from 'react'

interface Props {
  user: User
  profile: UserProfile | null
  language: string
  onToggleTheme: () => void
  onOpenSettings?: () => void
}

export default function Header({ user, profile, language, onToggleTheme, onOpenSettings }: Props) {
  const supabase = createClient()
  const isDark = profile?.theme !== 'light'
  const isHe = language === 'he'

  // Push notification state
  const [notifState, setNotifState] = useState<'unsupported' | 'default' | 'granted' | 'denied'>('default')
  const [notifLoading, setNotifLoading] = useState(false)

  useEffect(() => {
    if (typeof Notification === 'undefined' || !('serviceWorker' in navigator)) {
      setNotifState('unsupported')
      return
    }
    setNotifState(Notification.permission as 'default' | 'granted' | 'denied')
  }, [])

  const subscribePush = async () => {
    if (notifLoading) return
    setNotifLoading(true)
    try {
      const permission = await Notification.requestPermission()
      setNotifState(permission as 'default' | 'granted' | 'denied')
      if (permission !== 'granted') return

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
    } catch { /* ignore */ }
    finally { setNotifLoading(false) }
  }

  const unsubscribePush = async () => {
    if (notifLoading) return
    setNotifLoading(true)
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) await sub.unsubscribe()
      await fetch('/api/push/subscribe', { method: 'DELETE' })
      setNotifState('default')
    } catch { /* ignore */ }
    finally { setNotifLoading(false) }
  }

  return (
    <header style={{
      height: 'calc(60px + env(safe-area-inset-top))',
      paddingTop: 'env(safe-area-inset-top)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: 'env(safe-area-inset-top) 24px 0', flexShrink: 0,
      background: 'var(--bg-panel)',
      backdropFilter: 'blur(28px) saturate(180%)',
      WebkitBackdropFilter: 'blur(28px) saturate(180%)',
      borderBottom: '1px solid var(--border)',
      position: 'sticky', top: 0, zIndex: 20,
      // Always LTR so logo is always on the left, actions on the right
      direction: 'ltr',
    }}>
      {/* Logo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <div style={{
          width: 34, height: 34, borderRadius: 10, background: 'linear-gradient(135deg,#3B7EF7,#6366F1)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 15, fontWeight: 900, color: '#fff',
          boxShadow: '0 4px 16px rgba(59,126,247,0.45)',
          letterSpacing: '-0.02em',
        }}>Z</div>
        <span style={{ fontWeight: 700, fontSize: 17, letterSpacing: '-0.03em', color: 'var(--text)' }}>
          Zman
        </span>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Btn onClick={onToggleTheme} title={isDark ? (isHe ? 'מצב בהיר' : 'Light mode') : (isHe ? 'מצב כהה' : 'Dark mode')}>
          {isDark ? <Sun size={17} /> : <Moon size={17} />}
        </Btn>

        {/* Notification bell — hidden if unsupported */}
        {notifState !== 'unsupported' && notifState !== 'denied' && (
          <Btn
            onClick={notifState === 'granted' ? unsubscribePush : subscribePush}
            title={notifState === 'granted'
              ? (isHe ? 'כבה התראות' : 'Disable notifications')
              : (isHe ? 'הפעל התראות' : 'Enable notifications')}
            style={notifState === 'granted' ? { color: '#3B7EF7' } : {}}
          >
            {notifLoading
              ? <span style={{ width: 17, height: 17, border: '2px solid var(--border-hi)', borderTopColor: 'var(--blue)', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />
              : notifState === 'granted' ? <Bell size={17} /> : <BellOff size={17} />
            }
          </Btn>
        )}

        <Btn onClick={onOpenSettings} title={isHe ? 'הגדרות' : 'Settings'}>
          <Settings size={17} />
        </Btn>

        {/* Divider */}
        <div style={{ width: 1, height: 20, background: 'var(--border-hi)', margin: '0 8px' }} />

        {/* Avatar */}
        {user.user_metadata?.avatar_url
          ? <img
              src={user.user_metadata.avatar_url}
              style={{ width: 32, height: 32, borderRadius: '50%', border: '1.5px solid var(--border-hi)', flexShrink: 0, boxShadow: '0 0 0 2px var(--border)' }}
              alt=""
            />
          : <div style={{
              width: 32, height: 32, borderRadius: '50%',
              background: 'linear-gradient(135deg,#3B7EF7,#6366F1)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 13, fontWeight: 800, color: '#fff', flexShrink: 0,
              boxShadow: '0 0 0 2px var(--border)',
            }}>
              {(user.email?.[0] ?? 'U').toUpperCase()}
            </div>
        }

        <Btn
          onClick={async () => {
            // Clear chat history from session storage before logout
            try { sessionStorage.removeItem('zman_chat') } catch { /* ignore */ }
            // Always clear the file-based session cookie
            await fetch('/api/auth/logout', { method: 'POST' })
            // Also sign out from Supabase if configured
            try { await supabase.auth.signOut() } catch { /* demo mode — no supabase */ }
            window.location.href = '/login'
          }}
          title={isHe ? 'יציאה' : 'Sign out'}
        >
          <LogOut size={16} />
        </Btn>
      </div>
    </header>
  )
}

function Btn({ children, onClick, title, style }: {
  children: React.ReactNode
  onClick?: () => void
  title?: string
  style?: React.CSSProperties
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 38, height: 38, borderRadius: 10, border: 'none',
        background: 'transparent', color: 'var(--text-2)', cursor: 'pointer',
        transition: 'background 0.15s, color 0.15s',
        ...style,
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLElement).style.background = 'var(--bg-card)'
        ;(e.currentTarget as HTMLElement).style.color = 'var(--text)'
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLElement).style.background = 'transparent'
        ;(e.currentTarget as HTMLElement).style.color = 'var(--text-2)'
      }}
    >
      {children}
    </button>
  )
}
