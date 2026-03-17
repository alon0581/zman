'use client'

import { useState, useEffect } from 'react'
import { User } from '@supabase/supabase-js'
import { UserProfile, CalendarEvent } from '@/types'
import CalendarPanel from './CalendarPanel'
import ChatPanel from './ChatPanel'
import Header from './Header'
import { CalendarDays, MessageCircle } from 'lucide-react'

interface Props {
  user: User
  profile: UserProfile | null
  needsOnboarding: boolean
}

export default function AppShell({ user, profile: initialProfile, needsOnboarding }: Props) {
  const [profile, setProfile] = useState<UserProfile | null>(initialProfile)
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [newEventIds, setNewEventIds] = useState<Set<string>>(new Set())
  const [theme, setTheme] = useState<'dark' | 'light'>(initialProfile?.theme ?? 'dark')
  const [isMobile, setIsMobile] = useState(false)
  const [mobileTab, setMobileTab] = useState<'calendar' | 'chat'>('calendar')

  const language = profile?.language ?? 'en'
  const isRTL = language === 'he' || language === 'ar'

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  useEffect(() => {
    document.documentElement.setAttribute('lang', language)
    document.documentElement.setAttribute('dir', isRTL ? 'rtl' : 'ltr')
  }, [language, isRTL])

  // Responsive: detect mobile viewport
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  const handleEventsUpdate = (updatedEvents: CalendarEvent[], addedIds?: string[]) => {
    setEvents(updatedEvents)
    if (addedIds?.length) {
      const ids = new Set(addedIds)
      setNewEventIds(ids)
      setTimeout(() => setNewEventIds(new Set()), 3000)
    }
  }

  // Real-time sync: poll events every 30 s so changes on one device appear on others
  useEffect(() => {
    const poll = () => {
      fetch('/api/events')
        .then(r => r.ok ? r.json() : null)
        .then(data => { if (data?.events) setEvents(data.events) })
        .catch(() => { /* ignore network errors during poll */ })
    }
    const id = setInterval(poll, 30_000)
    return () => clearInterval(id)
  }, [])

  const handleEventUpdate = (id: string, changes: Partial<CalendarEvent>) => {
    setEvents(prev => prev.map(e => e.id === id ? { ...e, ...changes } : e))
  }

  const handleEventDelete = (id: string) => {
    setEvents(prev => prev.filter(e => e.id !== id))
  }

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    setProfile(prev => prev ? { ...prev, theme: next } : prev)
  }

  const handleProfileUpdate = (updated: UserProfile) => {
    setProfile(updated)
    const t = updated.theme ?? theme
    setTheme(t)
    document.documentElement.setAttribute('data-theme', t)
  }

  const calLabel  = language === 'he' ? 'לוח שנה' : 'Calendar'
  const chatLabel = language === 'he' ? 'עוזר AI'  : 'Assistant'

  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', height: '100vh',
        background: 'var(--bg)',
        fontFamily: 'var(--font-inter, system-ui, sans-serif)',
      }}
    >
      <Header user={user} profile={profile} language={language} onToggleTheme={toggleTheme} />

      {/* Main content — always LTR so chat is always on the right */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', direction: 'ltr' }}>

        {/* ── Desktop layout ── */}
        {!isMobile && (
          <>
            {/* Calendar */}
            <div style={{ flex: 1, overflow: 'hidden', borderRight: '1px solid var(--border)' }}>
              <CalendarPanel
                events={events}
                newEventIds={newEventIds}
                language={language}
                isMobile={false}
                onEventUpdate={handleEventUpdate}
                onEventDelete={handleEventDelete}
              />
            </div>

            {/* Chat */}
            <div style={{ width: 420, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderLeft: '1px solid var(--border)' }}>
              <ChatPanel
                user={user}
                profile={profile}
                events={events}
                language={language}
                onEventsUpdate={handleEventsUpdate}
                onProfileUpdate={handleProfileUpdate}
                isOnboarding={needsOnboarding}
              />
            </div>
          </>
        )}

        {/* ── Mobile layout ── */}
        {isMobile && (
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {/* Calendar tab */}
            <div style={{ display: mobileTab === 'calendar' ? 'block' : 'none', flex: 1, overflow: 'hidden', height: '100%' }}>
              <CalendarPanel
                events={events}
                newEventIds={newEventIds}
                language={language}
                isMobile={true}
                onEventUpdate={handleEventUpdate}
                onEventDelete={handleEventDelete}
              />
            </div>

            {/* Chat tab */}
            <div style={{ display: mobileTab === 'chat' ? 'flex' : 'none', flex: 1, flexDirection: 'column', overflow: 'hidden', height: '100%' }}>
              <ChatPanel
                user={user}
                profile={profile}
                events={events}
                language={language}
                onEventsUpdate={handleEventsUpdate}
                onProfileUpdate={handleProfileUpdate}
                isOnboarding={needsOnboarding}
              />
            </div>
          </div>
        )}
      </div>

      {/* ── Mobile bottom tab bar ── */}
      {isMobile && (
        <div style={{
          display: 'flex', flexShrink: 0,
          background: 'rgba(10,10,15,0.95)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          borderTop: '1px solid var(--border)',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        }}>
          <MobileTab
            active={mobileTab === 'calendar'}
            label={calLabel}
            icon={<CalendarDays size={22} />}
            onClick={() => setMobileTab('calendar')}
          />
          <MobileTab
            active={mobileTab === 'chat'}
            label={chatLabel}
            icon={<MessageCircle size={22} />}
            onClick={() => setMobileTab('chat')}
          />
        </div>
      )}

    </div>
  )
}

function MobileTab({ active, label, icon, onClick }: {
  active: boolean
  label: string
  icon: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 4, padding: '10px 0 12px',
        border: 'none', background: 'transparent', cursor: 'pointer',
        color: active ? 'var(--blue)' : 'var(--text-2)',
        transition: 'color 0.15s',
      }}
    >
      {icon}
      <span style={{ fontSize: 11, fontWeight: active ? 700 : 500, letterSpacing: '0.01em' }}>
        {label}
      </span>
    </button>
  )
}
