'use client'

import { useState, useEffect } from 'react'
import { User } from '@supabase/supabase-js'
import { UserProfile, CalendarEvent, Task } from '@/types'
import CalendarPanel from './CalendarPanel'
import ChatPanel from './ChatPanel'
import TasksPanel from './TasksPanel'
import Header from './Header'
import SettingsClient from '@/app/settings/SettingsClient'
import { CalendarDays, MessageCircle, CheckSquare } from 'lucide-react'
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
  const [mobileTab, setMobileTab] = useState<'calendar' | 'tasks' | 'chat'>('calendar')
  const [leftTab, setLeftTab] = useState<'calendar' | 'tasks'>('calendar')
  const [showSettings, setShowSettings] = useState(false)
  // chatInput is used to pre-fill the chat input (e.g. from TasksPanel schedule button)
  const [chatInput, setChatInput] = useState<string | undefined>(undefined)

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

  // Register native push notifications when running inside Capacitor (Android/iOS)
  useEffect(() => {
    registerCapacitorPush(async (fcmToken) => {
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: fcmToken, type: 'fcm' }),
      })
    })
  }, [])

  // Fetch + poll tasks — same cross-device sync pattern as events
  const fetchTasks = () => fetch('/api/tasks')
    .then(r => r.ok ? r.json() : null)
    .then(data => { if (data?.tasks) setTasks(data.tasks) })
    .catch(() => {})

  useEffect(() => {
    fetchTasks()
    const id = setInterval(fetchTasks, 30_000)
    return () => clearInterval(id)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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

  const handleScheduleTask = (task: Task) => {
    // Pre-fill the chat input with a scheduling request
    const msg = language === 'he'
      ? `קבע זמן לעשות: "${task.title}"${task.estimated_hours ? `, ${task.estimated_hours} שעות` : ''}${task.deadline ? `, עד ${task.deadline}` : ''}`
      : `Schedule time for: "${task.title}"${task.estimated_hours ? `, ${task.estimated_hours}h` : ''}${task.deadline ? `, due ${task.deadline}` : ''}`
    setChatInput(msg)
    // Switch to chat
    if (isMobile) setMobileTab('chat')
  }

  const handleAddTask = (text: string) => {
    // Pre-fill chat with the task creation request and switch to chat
    const msg = language === 'he'
      ? `הוסף משימה: ${text}`
      : `Add task: ${text}`
    setChatInput(msg)
    if (isMobile) setMobileTab('chat')
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

  const calLabel   = language === 'he' ? 'לוח שנה' : 'Calendar'
  const tasksLabel = language === 'he' ? 'משימות'  : 'Tasks'
  const chatLabel  = language === 'he' ? 'עוזר AI'  : 'Assistant'

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

  const chatPanel = (
    <ChatPanel
      user={user}
      profile={profile}
      events={events}
      tasks={tasks}
      language={language}
      onEventsUpdate={handleEventsUpdate}
      onProfileUpdate={handleProfileUpdate}
      onTasksUpdate={fetchTasks}
      isOnboarding={needsOnboarding}
      prefillInput={chatInput}
      onPrefillConsumed={() => setChatInput(undefined)}
    />
  )

  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', height: '100vh',
        background: 'transparent',
        fontFamily: 'var(--font-inter, system-ui, sans-serif)',
      }}
    >
      <Header user={user} profile={profile} language={language} onToggleTheme={toggleTheme} onOpenSettings={() => setShowSettings(true)} />

      {/* Main content — always LTR so chat is always on the right */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', direction: 'ltr' }}>

        {/* ── Desktop layout ── */}
        {!isMobile && (
          <>
            {/* Left panel (Calendar or Tasks) */}
            <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              {/* Left tab bar */}
              <div style={{
                display: 'flex', gap: 2, padding: '10px 16px 0', flexShrink: 0,
                borderBottom: '1px solid var(--border)', background: 'var(--bg-panel)',
              }}>
                <LeftTabBtn
                  active={leftTab === 'calendar'}
                  label={calLabel}
                  icon={<CalendarDays size={14} />}
                  onClick={() => setLeftTab('calendar')}
                />
                <LeftTabBtn
                  active={leftTab === 'tasks'}
                  label={tasksLabel}
                  icon={<CheckSquare size={14} />}
                  onClick={() => setLeftTab('tasks')}
                  badge={tasks.filter(t => t.status !== 'done').length}
                />
              </div>
              <div style={{ flex: 1, overflow: 'hidden' }}>
                {leftTab === 'calendar' ? calendarPanel : tasksPanel}
              </div>
            </div>

            {/* Chat */}
            <div style={{ width: 420, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '-1px 0 0 var(--border), -12px 0 32px rgba(0,0,0,0.35)' }}>
              {chatPanel}
            </div>
          </>
        )}

        {/* ── Mobile layout ── */}
        {isMobile && (
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: mobileTab === 'calendar' ? 'block' : 'none', flex: 1, overflow: 'hidden', height: '100%' }}>
              {calendarPanel}
            </div>
            <div style={{ display: mobileTab === 'tasks' ? 'flex' : 'none', flex: 1, flexDirection: 'column', overflow: 'hidden', height: '100%' }}>
              {tasksPanel}
            </div>
            <div style={{ display: mobileTab === 'chat' ? 'flex' : 'none', flex: 1, flexDirection: 'column', overflow: 'hidden', height: '100%' }}>
              {chatPanel}
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
          <MobileTab
            active={mobileTab === 'tasks'}
            label={tasksLabel}
            icon={<CheckSquare size={22} />}
            onClick={() => setMobileTab('tasks')}
            badge={tasks.filter(t => t.status !== 'done').length}
          />
        </div>
      )}

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

function LeftTabBtn({ active, label, icon, onClick, badge }: {
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
        display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px 9px',
        border: 'none', cursor: 'pointer', borderRadius: '8px 8px 0 0',
        background: active ? 'var(--bg-card)' : 'transparent',
        borderBottom: active ? '2px solid var(--blue)' : '2px solid transparent',
        color: active ? 'var(--text)' : 'var(--text-2)',
        fontSize: 12, fontWeight: active ? 700 : 500,
        transition: 'all 0.15s', position: 'relative',
      }}
    >
      {icon}
      {label}
      {badge !== undefined && badge > 0 && (
        <span style={{
          background: 'var(--blue)', color: '#fff', borderRadius: 10,
          fontSize: 10, fontWeight: 700, padding: '1px 5px', lineHeight: '14px',
        }}>
          {badge}
        </span>
      )}
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
