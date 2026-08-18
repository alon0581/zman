'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { UserProfile, CalendarEvent, Task, AppUser, Project } from '@/types'
import CalendarPanel from './CalendarPanel'
import TasksPanel from './TasksPanel'
import ProjectsPanel, { ProjectHealthMap } from './projects/ProjectsPanel'
import ProjectBoard from './projects/ProjectBoard'
import { BoardRules } from '@/lib/projects/types'
import Header from './Header'
import SettingsClient from '@/app/settings/SettingsClient'
import VoiceFAB from './VoiceFAB'
import ChatOverlay from './ChatOverlay'
import MethodOnboardingModal from './MethodOnboardingModal'
import ToastContainer from './Toast'
import { useChatEngine } from '@/hooks/useChatEngine'
import { CalendarDays, CheckSquare, FolderKanban, Sun, Moon, Settings as SettingsIcon } from 'lucide-react'
import { AnimatePresence } from 'motion/react'
import { registerCapacitorPush } from '@/lib/capacitor-push'

interface Props {
  user: AppUser
  profile: UserProfile | null
  needsOnboarding: boolean
  /** Server-resolved PROJECTS flag. One env var, one reader — no NEXT_PUBLIC twin. */
  projectsEnabled?: boolean
}

export default function AppShell({ user, profile: initialProfile, needsOnboarding, projectsEnabled = false }: Props) {
  const [profile, setProfile] = useState<UserProfile | null>(initialProfile)
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [newEventIds, setNewEventIds] = useState<Set<string>>(new Set())
  const [theme, setTheme] = useState<'dark' | 'light'>(initialProfile?.theme ?? 'dark')
  const [isMobile, setIsMobile] = useState(false)
  const [mobileTab, setMobileTab] = useState<'calendar' | 'tasks' | 'projects'>('calendar')
  const [desktopPanel, setDesktopPanel] = useState<'tasks' | 'projects'>('tasks')
  const [projects, setProjects] = useState<Project[]>([])
  const [projectHealth, setProjectHealth] = useState<ProjectHealthMap>({})
  const [boardRules, setBoardRules] = useState<BoardRules | null>(null)
  const [openProjectId, setOpenProjectId] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [chatOverlayOpen, setChatOverlayOpen] = useState(false)
  const [showMethodModal, setShowMethodModal] = useState(false)
  const [aliveActive, setAliveActive] = useState(false)

  const language = profile?.language ?? 'en'
  const isRTL = language === 'he' || language === 'ar'

  // Background pollers must not clobber an event/task the user or AI just changed.
  // We pause polling briefly after any local mutation and while the chat is working.
  const lastLocalMutationRef = useRef(0)
  const chatBusyRef = useRef(false)
  const markLocalMutation = () => { lastLocalMutationRef.current = Date.now() }
  const pollAllowed = () => !chatBusyRef.current && Date.now() - lastLocalMutationRef.current > 12_000

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

  // Guards fetchProjectHealth against overlapping requests: a rapid sequence of
  // task-status taps (each wanting a fresh signal strip) must not open one
  // health request per tap. A fetch already in flight absorbs later callers by
  // queuing a single follow-up, so the result always catches up to the latest
  // write without ever running two requests at once.
  const healthFetchStateRef = useRef({ inFlight: false, queued: false })
  const fetchProjectHealth = useCallback(() => {
    if (!projectsEnabled) return
    if (healthFetchStateRef.current.inFlight) {
      healthFetchStateRef.current.queued = true
      return
    }
    // The drain loop lives inside the callback rather than the callback calling
    // itself from .finally() — a self-reference would read the binding before it
    // is declared, so a later render's version would never be the one that runs.
    const drain = async () => {
      healthFetchStateRef.current.inFlight = true
      try {
        do {
          healthFetchStateRef.current.queued = false
          const res = await fetch('/api/projects/health')
          if (!res.ok) continue
          const data = await res.json()
          if (!data?.health) continue
          setProjectHealth(data.health as ProjectHealthMap)
          const first = Object.values(data.health)[0] as { board?: BoardRules } | undefined
          if (first?.board) setBoardRules(first.board)
        } while (healthFetchStateRef.current.queued)
      } catch { /* the 30s poller is the fallback */ }
      finally { healthFetchStateRef.current.inFlight = false }
    }
    void drain()
  }, [projectsEnabled])

  // Two calls on purpose: the list paints immediately, while health runs the real
  // scheduling engine server-side and arrives a beat later. Bundling them would
  // make every project list wait on a placement pass.
  const fetchProjects = useCallback(() => {
    if (!projectsEnabled) return
    fetch('/api/projects')
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.projects) setProjects(data.projects) })
      .catch(() => {})
    fetchProjectHealth()
  }, [projectsEnabled, fetchProjectHealth])

  useEffect(() => {
    fetchTasks()
    fetchProjects()
  }, [fetchProjects])

  const handleEventsUpdate = (updatedEvents: CalendarEvent[], addedIds?: string[]) => {
    markLocalMutation()
    setEvents(updatedEvents)
    if (addedIds?.length) {
      const ids = new Set(addedIds)
      setNewEventIds(ids)
      setTimeout(() => setNewEventIds(new Set()), 3000)
    }
  }

  // One timer for both events and tasks. They used to have a timer each, firing
  // independently 30s apart, so a phone woke the radio twice per cycle for two
  // requests that always want the same freshness. Also skipped entirely while the
  // tab is hidden — polling a screen nobody is looking at is pure battery cost.
  useEffect(() => {
    const poll = () => {
      if (!pollAllowed() || document.hidden) return
      fetch('/api/events')
        .then(r => r.ok ? r.json() : null)
        .then(data => { if (data?.events && pollAllowed()) setEvents(data.events) })
        .catch(() => {})
      fetchTasks()
      fetchProjects()
    }
    const id = setInterval(poll, 30_000)
    // Coming back to the tab should show current data immediately rather than
    // waiting out the rest of an interval that was skipped while hidden.
    const onVisible = () => { if (!document.hidden) poll() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
    // fetchProjects is useCallback'd on the flag alone, so it is stable for the
    // life of the session and this does not re-create the timer.
  }, [fetchProjects])

  const handleEventUpdate = (id: string, changes: Partial<CalendarEvent>) => {
    markLocalMutation()
    setEvents(prev => prev.map(e => e.id === id ? { ...e, ...changes } : e))
  }

  const handleEventDelete = (id: string) => {
    markLocalMutation()
    setEvents(prev => prev.filter(e => e.id !== id))
  }

  const handleTaskToggle = (id: string, newStatus: Task['status']) => {
    markLocalMutation()
    const prevTask = tasks.find(t => t.id === id)
    const completedAt = newStatus === 'done' ? new Date().toISOString() : undefined
    setTasks(prev => prev.map(t => t.id === id ? { ...t, status: newStatus, ...(completedAt ? { completed_at: completedAt } : { completed_at: undefined }) } : t))
    fetch(`/api/tasks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus, ...(completedAt ? { completed_at: completedAt } : {}) }),
    }).then(res => {
      if (!res.ok) throw new Error('task_update_failed')
      // The board's columns already re-sorted from local state above; the signal
      // strip reads project health, which only the server can recompute.
      fetchProjectHealth()
    }).catch(() => {
      // Roll back the optimistic update — the write never actually landed.
      if (prevTask) setTasks(prev => prev.map(t => t.id === id ? prevTask : t))
      chatEngine.addToast('error', language === 'he' ? 'עדכון המשימה נכשל. השינוי בוטל.' : 'Failed to update task. Change reverted.')
    })
  }

  const handleDeleteTask = (id: string) => {
    markLocalMutation()
    const prevTask = tasks.find(t => t.id === id)
    const prevIndex = tasks.findIndex(t => t.id === id)
    setTasks(prev => prev.filter(t => t.id !== id))
    fetch(`/api/tasks/${id}`, { method: 'DELETE' }).then(res => {
      if (!res.ok) throw new Error('task_delete_failed')
    }).catch(() => {
      // Roll back the optimistic removal — restore at its original position.
      if (prevTask) {
        setTasks(prev => {
          const next = [...prev]
          next.splice(Math.min(prevIndex, next.length), 0, prevTask)
          return next
        })
      }
      chatEngine.addToast('error', language === 'he' ? 'מחיקת המשימה נכשלה. המשימה שוחזרה.' : 'Failed to delete task. Task restored.')
    })
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
    onProjectsUpdate: fetchProjects,
    isOnboarding: needsOnboarding,
    chatOverlayOpen,
  })

  // Keep the poller guard in sync with chat activity (a chat turn may create/move events)
  useEffect(() => {
    chatBusyRef.current = chatEngine.loading
    if (chatEngine.loading) markLocalMutation()
  }, [chatEngine.loading])

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

  // Show method selection modal when the user has no scheduling method yet.
  // `method_prompt_dismissed` is what stops this from returning on every login
  // for someone who closed it without choosing — the backfill used to prevent
  // that by writing a guessed method, which is the behaviour we removed.
  useEffect(() => {
    if (profile && profile.onboarding_completed && !profile.scheduling_method
        && !profile.method_prompt_dismissed && !needsOnboarding) {
      const timer = setTimeout(() => setShowMethodModal(true), 800)
      return () => clearTimeout(timer)
    }
  }, [profile, needsOnboarding])

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
      onDeleteTask={handleDeleteTask}
    />
  )

  const projectsPanel = (
    <ProjectsPanel
      projects={projects}
      health={projectHealth}
      language={language}
      onOpenProject={setOpenProjectId}
      onCreated={() => { markLocalMutation(); fetchProjects(); fetchTasks() }}
      onAskAi={chatEngine.sendMessage}
    />
  )

  const openProject = projects.find(p => p.id === openProjectId) ?? null

  /** Desktop Tasks/Projects switch. Mobile uses the bottom bar — two switchers for
   *  one thing is a bug, so this is desktop-only. */
  const desktopToggle = (
    <div style={{
      display: 'flex', gap: 3, margin: '10px 12px 0', padding: 3,
      background: 'var(--bg-input)', borderRadius: 9, flexShrink: 0,
    }}>
      {(['tasks', 'projects'] as const).map(key => {
        const active = desktopPanel === key
        return (
          <button
            key={key}
            onClick={() => setDesktopPanel(key)}
            style={{
              flex: 1, padding: '6px 8px', borderRadius: 7, border: 'none', cursor: 'pointer',
              background: active ? 'var(--bg-card)' : 'transparent',
              boxShadow: active ? 'var(--shadow-sm)' : 'none',
              color: active ? 'var(--blue)' : 'var(--text-2)',
              fontSize: 12, fontWeight: active ? 700 : 500,
            }}
          >
            {key === 'tasks'
              ? (language === 'he' ? 'משימות' : 'Tasks')
              : (language === 'he' ? 'פרויקטים' : 'Projects')}
          </button>
        )
      })}
    </div>
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
            <MobileIconBtn onClick={toggleTheme} label={language === 'he' ? 'החלף ערכת נושא' : 'Toggle theme'}>
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </MobileIconBtn>
            <MobileIconBtn onClick={() => setShowSettings(true)} label={language === 'he' ? 'הגדרות' : 'Settings'}>
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
              width: 'var(--panel-w)', flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
              borderLeft: '1px solid var(--border)',
              boxShadow: '-4px 0 20px rgba(0,0,0,0.15)',
            }}>
              {projectsEnabled && desktopToggle}
              <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                {projectsEnabled && desktopPanel === 'projects' ? projectsPanel : tasksPanel}
              </div>
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
            {projectsEnabled && (
              <div style={{ display: mobileTab === 'projects' ? 'flex' : 'none', flex: 1, flexDirection: 'column', overflow: 'hidden', height: '100%' }}>
                {projectsPanel}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Mobile bottom tab bar (2 tabs: Calendar | Tasks — chat opens via VoiceFAB double-tap) ── */}
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
          {projectsEnabled && (
            <MobileTab
              active={mobileTab === 'projects'}
              label={language === 'he' ? 'פרויקטים' : 'Projects'}
              icon={<FolderKanban size={22} />}
              onClick={() => setMobileTab('projects')}
              // A badge that means something: how many projects are actually at
              // risk, not how many exist.
              badge={Object.values(projectHealth).filter(h =>
                h.signals.some(s => s.signal === 'deadline' && s.state === 'risk')).length}
            />
          )}
        </div>
      )}

      {/* ── Alive overlay (screen glow during recording) ── */}
      {aliveActive && <div className="alive-overlay" />}

      {/* ── Voice FAB — only over the calendar, and never on top of a sheet.
             Tasks and Projects both have their own bottom bar, and the board has
             its own primary action, so the mic would sit on top of them. ── */}
      {(!isMobile || mobileTab === 'calendar') && !showSettings && !openProjectId && (
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

      {/* ── Project board overlay ── */}
      <AnimatePresence>
        {openProject && boardRules && (
          <ProjectBoard
            project={openProject}
            tasks={tasks}
            rules={boardRules}
            signals={projectHealth[openProject.id]?.signals ?? []}
            language={language}
            isMobile={isMobile}
            onClose={() => setOpenProjectId(null)}
            onTaskStatus={handleTaskToggle}
            onAskAi={(msg) => { setOpenProjectId(null); chatEngine.sendMessage(msg) }}
          />
        )}
      </AnimatePresence>

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
            onRetry={chatEngine.retryLast}
            onStop={chatEngine.stop}
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

      {showMethodModal && profile && (
        <MethodOnboardingModal
          profile={profile}
          memory={chatEngine.memory}
          language={language}
          onComplete={(updated) => {
            handleProfileUpdate(updated)
            setShowMethodModal(false)
          }}
          onSkip={() => {
            setShowMethodModal(false)
            // Persist the decline, or this returns on the next load. Fire and
            // forget: the worst case is being asked once more, which is a far
            // smaller failure than silently scheduling them by a guess.
            fetch('/api/profile', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ method_prompt_dismissed: true }),
            })
              .then(res => { if (res.ok) handleProfileUpdate({ ...profile, method_prompt_dismissed: true }) })
              .catch(() => { /* asked again next time; nothing is lost */ })
          }}
        />
      )}
    </div>
  )
}

function MobileIconBtn({ children, onClick, label }: { children: React.ReactNode; onClick?: () => void; label?: string }) {
  return (
    <button onClick={onClick} aria-label={label} title={label} style={{
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
