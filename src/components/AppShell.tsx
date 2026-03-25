'use client'

import { useState, useEffect, useCallback } from 'react'
import { User } from '@supabase/supabase-js'
import { UserProfile, CalendarEvent, Task } from '@/types'
import CalendarPanel from './CalendarPanel'
import TasksPanel from './TasksPanel'
import Header from './Header'
import SettingsClient from '@/app/settings/SettingsClient'
import VoiceFAB from './VoiceFAB'
import ChatOverlay from './ChatOverlay'
import ToastContainer from './Toast'
import { useChatEngine } from '@/hooks/useChatEngine'
import { CalendarDays, CheckSquare, Sun, Moon, Settings as SettingsIcon } from 'lucide-react'
import { AnimatePresence } from 'motion/react'
import { registerCapacitorPush } from '@/lib/capacitor-push'

interface Props {
  user: User
  profile: UserProfile | null
  needsOnboarding: boolean
}

export default function AppShell({ user, profile: initialProfile, needsOnboarding }: Props) {
  const [profile, setProfile] = useState<UserProfile | null>(initialProfile)
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [newEventIds, setNewEventIds] = useState<Set<string>>(new Set())
  const [theme, setTheme] = useState<'dark' | 'light'>(initialProfile?.theme ?? 'dark')
  const [isMobile, setIsMobile] = useState(false)
  const [mobileTab, setMobileTab] = useState<'calendar' | 'tasks'>('calendar')
  const [showSettings, setShowSettings] = useState(false)
  const [chatOverlayOpen, setChatOverlayOpen] = useState(false)
  const [aliveActive, setAliveActive] = useState(false)

  const language = profile?.language ?? 'en'
  const isRTL = language === 'he' || language === 'ar'

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  useEffect(() => {
    document.documentElement.setAttribute('lang', language)
    document.documentElement.setAttribute('dir', isRTL ? 'rtl' : 'ltr')
  }, [language, isRTL])

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  useEffect(() => {
    registerCapacitorPush(async (fcmToken) => {
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: fcmToken, type: 'fcm' }),
      })
    })
  }, [])

  const fetchTasks = () => fetch('/api/tasks')
    .then(r => r.ok ? r.json() : null)
    .then(data => { if (data?.tasks) setTasks(data.tasks) })
    .catch(() => {})

  useEffect(() => {
    fetchTasks()
    const id = setInterval(fetchTasks, 30_000)
    return () => clearInterval(id)
  }, [])

  const handleEventsUpdate = (updatedEvents: CalendarEvent[], addedIds?: string[]) => {
    setEvents(updatedEvents)
    if (addedIds?.length) {
      const ids = new Set(addedIds)
      setNewEventIds(ids)
      setTimeout(() => setNewEventIds(new Set()), 3000)
    }
  }

  useEffect(() => {
    const poll = () => {
      fetch('/api/events')
        .then(r => r.ok ? r.json() : null)
        .then(data => { if (data?.events) setEvents(data.events) })
        .catch(() => {})
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

  const handleTaskToggle = (id: string, newStatus: Task['status']) => {
    const completedAt = newStatus === 'done' ? new Date().toISOString() : undefined
    setTasks(prev => prev.map(t => t.id === id ? { ...t, status: newStatus, ...(completedAt ? { completed_at: completedAt } : { completed_at: undefined }) } : t))
    fetch(`/api/tasks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus, ...(completedAt ? { completed_at: completedAt } : {}) }),
    }).catch(() => {})
  }

  const handleProfileUpdate = (updated: UserProfile) => {
    setProfile(updated)
    const t = updated.theme ?? theme
    setTheme(t)
    document.documentElement.setAttribute('data-theme', t)
  }

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    setProfile(prev => prev ? { ...prev, theme: next } : prev)
  }

  // ─── Chat Engine (shared between VoiceFAB and ChatOverlay) ────────────────
  const chatEngine = useChatEngine({
    user,
    profile,
    events,
    tasks,
    language,
    onEventsUpdate: handleEventsUpdate,
    onProfileUpdate: handleProfileUpdate,
    onTasksUpdate: fetchTasks,
    isOnboarding: needsOnboarding,
    chatOverlayOpen,
  })

  // Task scheduling: auto-send via chat engine
  const handleScheduleTask = useCallback((task: Task) => {
    const msg = language === 'he'
      ? `קבע זמן לעשות: "${task.title}"${task.estimated_hours ? `, ${task.estimated_hours} שעות` : ''}${task.deadline ? `, עד ${task.deadline}` : ''}`
      : `Schedule time for: "${task.title}"${task.estimated_hours ? `, ${task.estimated_hours}h` : ''}${task.deadline ? `, due ${task.deadline}` : ''}`
    chatEngine.sendMessage(msg)
  }, [language, chatEngine])

  const handleAddTask = useCallback((text: string) => {
    const msg = language === 'he' ? `הוסף משימה: ${text}` : `Add task: ${text}`
    chatEngine.sendMessage(msg)
  }, [language, chatEngine])

  // Auto-open chat overlay for onboarding
  useEffect(() => {
    if (needsOnboarding && chatEngine.isOnboarding) {
      setChatOverlayOpen(true)
    }
  }, [needsOnboarding, chatEngine.isOnboarding])

  const handleAliveChange = useCallback((alive: boolean) => {
    setAliveActive(alive)
  }, [])

  const calLabel = language === 'he' ? 'לוח שנה' : 'Calendar'
  const tasksLabel = language === 'he' ? 'משימות' : 'Tasks'

  const calendarPanel = (
    <CalendarPanel
      events={events}
      newEventIds={newEventIds}
      language={language}
      isMobile={isMobile}
      onEventUpdate={handleEventUpdate}
      onEventDelete={handleEventDelete}
    />
  )

  const tasksPanel = (
    <TasksPanel
      tasks={tasks}
      events={events}
      language={language}
      onTaskToggle={handleTaskToggle}
      onScheduleTask={handleScheduleTask}
      onAddTask={handleAddTask}
    />
  )

  return (
    <div
      className={aliveActive ? 'alive-active' : ''}
      style={{
        display: 'flex', flexDirection: 'column',
        height: '100vh',
        background: 'transparent',
        fontFamily: 'var(--font-inter, system-ui, sans-serif)',
      }}
    >
      {/* Desktop header — hidden on mobile (too website-y on small screens) */}
      {!isMobile && (
        <Header user={user} profile={profile} language={language} onToggleTheme={toggleTheme} onOpenSettings={() => setShowSettings(true)} />
      )}

      {/* Mobile top bar — minimal native-style, replaces full Header */}
      {isMobile && (
        <div style={{
          height: 'calc(52px + env(safe-area-inset-top, 0px))',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'env(safe-area-inset-top, 0px) 16px 0',
          background: 'var(--bg-panel)',
          backdropFilter: 'blur(28px) saturate(180%)',
          WebkitBackdropFilter: 'blur(28px) saturate(180%)',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0, direction: 'ltr', zIndex: 20,
        } as React.CSSProperties}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 30, height: 30, borderRadius: 9, background: 'linear-gradient(135deg,#3B7EF7,#6366F1)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 13, fontWeight: 900, color: '#fff',
              boxShadow: '0 3px 10px rgba(59,126,247,0.45)',
            }}>Z</div>
            <span style={{ fontWeight: 700, fontSize: 17, letterSpacing: '-0.03em', color: 'var(--text)' }}>Zman</span>
          </div>
          <div style={{ display: 'flex', gap: 2 }}>
            <MobileIconBtn onClick={toggleTheme}>
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </MobileIconBtn>
            <MobileIconBtn onClick={() => setShowSettings(true)}>
              <SettingsIcon size={18} />
            </MobileIconBtn>
          </div>
        </div>
      )}

      {/* Main content — always LTR so calendar is always on the left */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', direction: 'ltr' }}>

        {/* ── Desktop layout: Calendar + Tasks side by side ── */}
        {!isMobile && (
          <>
            <div style={{ flex: 2, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              {calendarPanel}
            </div>
            <div style={{
              width: 340, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
              borderLeft: '1px solid var(--border)',
              boxShadow: '-4px 0 20px rgba(0,0,0,0.15)',
            }}>
              {tasksPanel}
            </div>
          </>
        )}

        {/* ── Mobile layout: Calendar or Tasks ── */}
        {isMobile && (
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: mobileTab === 'calendar' ? 'block' : 'none', flex: 1, overflow: 'hidden', height: '100%' }}>
              {calendarPanel}
            </div>
            <div style={{ display: mobileTab === 'tasks' ? 'flex' : 'none', flex: 1, flexDirection: 'column', overflow: 'hidden', height: '100%' }}>
              {tasksPanel}
            </div>
          </div>
        )}
      </div>

      {/* ── Mobile bottom tab bar (3 tabs: Calendar | Chat | Tasks) ── */}
      {isMobile && (
        <div style={{
          display: 'flex', flexShrink: 0,
          background: 'var(--bg-panel)',
          backdropFilter: 'blur(28px) saturate(180%)',
          WebkitBackdropFilter: 'blur(28px) saturate(180%)',
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
            active={mobileTab === 'tasks'}
            label={tasksLabel}
            icon={<CheckSquare size={22} />}
            onClick={() => setMobileTab('tasks')}
            badge={tasks.filter(t => t.status !== 'done').length}
          />
        </div>
      )}

      {/* ── Alive overlay (screen glow during recording) ── */}
      {aliveActive && <div className="alive-overlay" />}

      {/* ── Voice FAB — hidden on Tasks tab, and when Settings is open ── */}
      {(!isMobile || mobileTab !== 'tasks') && !showSettings && (
        <VoiceFAB
          onSendMessage={chatEngine.sendMessage}
          onOpenChat={() => setChatOverlayOpen(true)}
          language={language}
          isRTL={isRTL}
          isMobile={isMobile}
          onAliveChange={handleAliveChange}
          micSide={profile?.mic_position ?? 'right'}
        />
      )}

      {/* ── Toast notifications ── */}
      <ToastContainer
        toasts={chatEngine.toasts}
        onDismiss={chatEngine.dismissToast}
        onTap={() => setChatOverlayOpen(true)}
        isRTL={isRTL}
        isMobile={isMobile}
      />

      {/* ── Chat Overlay (double-tap to open) ── */}
      <AnimatePresence>
        {chatOverlayOpen && (
          <ChatOverlay
            messages={chatEngine.messages}
            input={chatEngine.input}
            setInput={chatEngine.setInput}
            loading={chatEngine.loading}
            streamingId={chatEngine.streamingId}
            isOnboarding={chatEngine.isOnboarding}
            language={language}
            isMobile={isMobile}
            onSend={chatEngine.sendMessage}
            onClose={() => setChatOverlayOpen(false)}
            onReset={chatEngine.resetChat}
          />
        )}
      </AnimatePresence>

      {showSettings && (
        <SettingsClient
          user={user}
          profile={profile}
          onClose={() => setShowSettings(false)}
          onProfileUpdate={handleProfileUpdate}
        />
      )}
    </div>
  )
}

function MobileIconBtn({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  return (
    <button onClick={onClick} style={{
      width: 38, height: 38, borderRadius: 10, border: 'none',
      background: 'transparent', color: 'var(--text-2)', cursor: 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {children}
    </button>
  )
}

function MobileTab({ active, label, icon, onClick, badge }: {
  active: boolean
  label: string
  icon: React.ReactNode
  onClick: () => void
  badge?: number
}) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 4, padding: '10px 0 12px',
        border: 'none', background: 'transparent', cursor: 'pointer',
        color: active ? 'var(--blue)' : 'var(--text-2)',
        transition: 'color 0.15s', position: 'relative',
      }}
    >
      {icon}
      <span style={{ fontSize: 11, fontWeight: active ? 700 : 500, letterSpacing: '0.01em' }}>
        {label}
      </span>
      {badge !== undefined && badge > 0 && (
        <span style={{
          position: 'absolute', top: 6, right: '50%', transform: 'translateX(10px)',
          background: 'var(--blue)', color: '#fff', borderRadius: 10,
          fontSize: 9, fontWeight: 700, padding: '1px 4px', lineHeight: '13px',
        }}>
          {badge}
        </span>
      )}
    </button>
  )
}
