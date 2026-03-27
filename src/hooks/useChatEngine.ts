'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { AIMemory, CalendarEvent, Message, Task, UserProfile } from '@/types'

// ─── Calendar intent detector ──────────────────────────────────────────────
function hasCalendarIntent(text: string): boolean {
  const t = text.toLowerCase()
  const keywords = [
    'הוסף', 'צור', 'קבע', 'תזמן', 'תוסיף', 'תקבע', 'לוח שנה', 'לו"ז',
    'אירוע', 'פגישה', 'הגשה', 'דדליין', 'שבוע הבא',
    'כל שלישי', 'כל ראשון', 'כל שני', 'כל רביעי', 'כל חמישי', 'כל שישי',
    'בשעה ',
    'add to calendar', 'create event', 'schedule ', 'put on calendar',
    'calendar', 'meeting at', 'class at', 'exam on',
    'appointment', 'deadline', 'next week',
    'every monday', 'every tuesday', 'every wednesday', 'every thursday',
    'every friday', 'every saturday', 'every sunday',
  ]
  return keywords.some(k => t.includes(k))
}

// ─── Dynamic welcome builder ─────────────────────────────────────────────────
function buildDynamicWelcome(
  events: CalendarEvent[],
  memory: AIMemory[],
  lang: string,
): string {
  const now = new Date()
  const hour = now.getHours()
  const isHe = lang === 'he'

  const nameMem = memory.find(m => m.key === 'name' || m.key === 'personal_name')
  const name = nameMem?.value?.split(' ')[0]

  const todayStr = now.toDateString()
  const todayEvents = events
    .filter(e => new Date(e.start_time).toDateString() === todayStr)
    .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())

  const nextEvent = todayEvents.find(e => new Date(e.start_time) > now)

  const ongoingTask = memory.find(m => m.key === 'ongoing_task' || m.key === 'ongoing_project')?.value

  const urgentKw = ['מבחן', 'בחינה', 'exam', 'deadline', 'due', 'הגשה', 'test', 'quiz']
  const urgent = events
    .filter(e => {
      const d = new Date(e.start_time)
      const days = (d.getTime() - now.getTime()) / 86400000
      return days > 0 && days <= 7 && urgentKw.some(k => e.title.toLowerCase().includes(k))
    })
    .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())

  if (isHe) {
    const greet = hour < 12 ? 'בוקר טוב' : hour < 18 ? 'שלום' : 'ערב טוב'
    const nameStr = name ? ` ${name}` : ''
    let msg = `${greet}${nameStr}! 👋\n\n`
    if (todayEvents.length === 0) {
      msg += `היום הלוח שנה שלך פנוי לחלוטין.`
    } else {
      msg += `יש לך ${todayEvents.length} ${todayEvents.length === 1 ? 'אירוע' : 'אירועים'} היום`
      if (nextEvent) {
        const t = new Date(nextEvent.start_time).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })
        msg += ` — הבא: **${nextEvent.title}** ב-${t}`
      }
      msg += '.'
    }
    if (ongoingTask) {
      msg += `\n\n🔄 המשך מהשיחה הקודמת: **${ongoingTask}** — רוצה להמשיך?`
    } else if (urgent.length > 0) {
      const days = Math.ceil((new Date(urgent[0].start_time).getTime() - now.getTime()) / 86400000)
      msg += `\n\n⚠️ **${urgent[0].title}** בעוד ${days} ${days === 1 ? 'יום' : 'ימים'} — רוצה שנתכנן הכנה?`
    } else if (todayEvents.length === 0) {
      msg += ` רוצה שנתכנן את היום?`
    } else {
      msg += `\n\nאיך אוכל לעזור?`
    }
    return msg
  } else {
    const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Hey' : 'Good evening'
    const nameStr = name ? `, ${name}` : ''
    let msg = `${greet}${nameStr}! 👋\n\n`
    if (todayEvents.length === 0) {
      msg += `Your calendar is clear today.`
    } else {
      msg += `You have ${todayEvents.length} ${todayEvents.length === 1 ? 'event' : 'events'} today`
      if (nextEvent) {
        const t = new Date(nextEvent.start_time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
        msg += ` — next up: **${nextEvent.title}** at ${t}`
      }
      msg += '.'
    }
    if (ongoingTask) {
      msg += `\n\n🔄 Continuing from last time: **${ongoingTask}** — want to pick up where we left off?`
    } else if (urgent.length > 0) {
      const days = Math.ceil((new Date(urgent[0].start_time).getTime() - now.getTime()) / 86400000)
      msg += `\n\n⚠️ **${urgent[0].title}** is in ${days} ${days === 1 ? 'day' : 'days'} — want to plan prep sessions?`
    } else if (todayEvents.length === 0) {
      msg += ` Want to plan something?`
    } else {
      msg += `\n\nHow can I help?`
    }
    return msg
  }
}

export interface ToastItem {
  id: string
  type: 'event_created' | 'task_created' | 'message' | 'error'
  text: string
}

export interface ChatEngineResult {
  messages: Message[]
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>
  input: string
  setInput: React.Dispatch<React.SetStateAction<string>>
  loading: boolean
  streamingId: string | null
  memory: AIMemory[]
  isOnboarding: boolean
  sendMessage: (text: string) => Promise<void>
  resetChat: () => void
  toasts: ToastItem[]
  dismissToast: (id: string) => void
}

const T = {
  en: { error: 'Something went wrong. Please try again.' },
  he: { error: 'משהו השתבש. נסה שוב.' },
} as const

export function useChatEngine({
  user,
  profile: initProfile,
  events,
  tasks,
  language,
  onEventsUpdate,
  onProfileUpdate,
  onTasksUpdate,
  isOnboarding: initIsOnboarding,
  chatOverlayOpen,
}: {
  user: { id: string }
  profile: UserProfile | null
  events: CalendarEvent[]
  tasks: Task[]
  language: string
  onEventsUpdate: (events: CalendarEvent[], addedIds?: string[]) => void
  onProfileUpdate: (profile: UserProfile) => void
  onTasksUpdate?: () => void
  isOnboarding?: boolean
  chatOverlayOpen?: boolean
}): ChatEngineResult {
  const [profile, setProfile] = useState<UserProfile | null>(initProfile)
  const [isOnboarding, setIsOnboarding] = useState(!!initIsOnboarding)
  const [memory, setMemory] = useState<AIMemory[]>([])
  const [messages, setMessages] = useState<Message[]>([{
    id: 'welcome', role: 'assistant' as const,
    content: initIsOnboarding
      ? (language === 'he'
        ? `היי! אני זמן, המתזמן החכם שלך 👋\n\nלפני שנתחיל, אשמח לקחת 2 דקות להכיר אותך — כדי שאוכל להיות שימושי באמת.\n\nנתחיל מהפשוט: **מה אתה עושה?** סטודנט? עובד? שניהם?`
        : `Hey! I'm Zman, your new AI scheduler 👋\n\nBefore we dive in, I'd love to take 2 minutes to get to know you — so I can actually be useful to you.\n\nLet's start simple: **What do you do?** Student? Working? Both?`)
      : (language === 'he'
        ? `היי! אני זמן, המתזמן החכם שלך. ספר לי מה יש לך — או פשוט לחץ על המיק ודבר אליי. 🎙️`
        : `Hey! I'm Zman, your AI scheduler. Tell me what's on your plate — or just tap the mic and talk to me. 🎙️`),
    timestamp: new Date(),
  }])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [streamingId, setStreamingId] = useState<string | null>(null)
  const [toasts, setToasts] = useState<ToastItem[]>([])

  // Auto-dismiss toasts
  useEffect(() => {
    if (toasts.length === 0) return
    const timer = setTimeout(() => {
      setToasts(p => p.slice(1))
    }, 4000)
    return () => clearTimeout(timer)
  }, [toasts])

  const dismissToast = useCallback((id: string) => {
    setToasts(p => p.filter(t => t.id !== id))
  }, [])

  const addToast = useCallback((type: ToastItem['type'], text: string) => {
    setToasts(p => [...p.slice(-2), { id: crypto.randomUUID(), type, text }])
  }, [])

  // On mount: load events, profile, memory — then build smart welcome
  useEffect(() => {
    Promise.all([
      fetch('/api/events').then(r => r.ok ? r.json() : null),
      fetch('/api/profile').then(r => r.ok ? r.json() : null),
      fetch('/api/memory').then(r => r.ok ? r.json() : []),
    ]).then(([evData, profData, memData]) => {
      const loadedEvents: CalendarEvent[] = evData?.events ?? []
      const loadedMemory: AIMemory[] = Array.isArray(memData) ? memData : []
      const loadedProfile: UserProfile | null = profData ?? null

      if (evData) onEventsUpdate(loadedEvents)
      if (loadedProfile) { setProfile(loadedProfile); onProfileUpdate(loadedProfile) }
      if (loadedMemory.length > 0) setMemory(loadedMemory)

      if (initIsOnboarding && loadedMemory.length > 0) {
        setIsOnboarding(false)
        const baseProfile = loadedProfile ?? initProfile
        if (baseProfile && !baseProfile.onboarding_completed) {
          const fixed = { ...baseProfile, onboarding_completed: true }
          fetch('/api/profile', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(fixed),
          }).catch(() => {})
          onProfileUpdate(fixed)
        }
      }

      if (!initIsOnboarding || loadedMemory.length > 0) {
        const lang = loadedProfile?.language ?? language
        const dynamic = buildDynamicWelcome(loadedEvents, loadedMemory, lang)
        setMessages([{ id: 'welcome', role: 'assistant', content: dynamic, timestamp: new Date() }])
      }
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || loading) return
    const um: Message = { id: crypto.randomUUID(), role: 'user', content: text.trim(), timestamp: new Date() }
    setMessages(p => [...p, um])
    setInput('')
    setLoading(true)

    const assistantId = crypto.randomUUID()
    const eventsSnapshot = events

    let activeOnboarding = isOnboarding
    if (isOnboarding && (memory.length > 0 || hasCalendarIntent(text))) {
      activeOnboarding = false
      setIsOnboarding(false)
      const updatedProfile = { ...(profile ?? {}), onboarding_completed: true } as UserProfile
      fetch('/api/profile', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedProfile),
      }).catch(() => {})
      onProfileUpdate(updatedProfile)
    }

    const lang = profile?.language ?? language
    const isHe = lang === 'he'

    try {
      const welcomeMsg = messages.find(m => m.id === 'welcome')
      const history = messages.filter(m => m.id !== 'welcome').slice(-40).map(m => ({ role: m.role, content: m.content }))
      const contextMessages = [
        ...(welcomeMsg ? [{ role: 'assistant' as const, content: welcomeMsg.content }] : []),
        ...history,
        { role: 'user' as const, content: text.trim() },
      ]
      const res = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: contextMessages, events: eventsSnapshot, profile, isOnboarding: activeOnboarding, memory, tasks, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
      })
      if (!res.ok || !res.body) throw new Error()

      let eventData: { createdEvents?: CalendarEvent[]; updatedEvents?: CalendarEvent[]; deletedEventIds?: string[] } = {}
      let streamingStarted = false

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''

        for (const part of parts) {
          const line = part.trim()
          if (!line.startsWith('data: ')) continue
          try {
            const parsed = JSON.parse(line.slice(6))
            if (parsed.type === 'events') {
              eventData = parsed
            } else if (parsed.type === 'text') {
              if (!streamingStarted) {
                streamingStarted = true
                setStreamingId(assistantId)
                setMessages(p => [...p, { id: assistantId, role: 'assistant', content: parsed.content, timestamp: new Date() }])
              } else {
                setMessages(p => p.map(m => m.id === assistantId ? { ...m, content: m.content + parsed.content } : m))
              }
            } else if (parsed.type === 'tasks_updated') {
              onTasksUpdate?.()
            } else if (parsed.type === 'memory_updated') {
              fetch('/api/memory').then(r => r.ok ? r.json() : []).then(data => {
                if (Array.isArray(data)) setMemory(data)
              }).catch(() => {})
            } else if (parsed.type === 'onboarding_complete') {
              setIsOnboarding(false)
              onProfileUpdate(parsed.profile)
              fetch('/api/memory').then(r => r.ok ? r.json() : []).then(data => {
                if (Array.isArray(data)) setMemory(data)
              }).catch(() => {})
              fetch('/api/profile', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...parsed.profile, onboarding_completed: true }),
              }).catch(() => {})
            } else if (parsed.type === 'done') {
              let next = [...eventsSnapshot]
              if (eventData.createdEvents?.length) next = [...next, ...eventData.createdEvents]
              if (eventData.updatedEvents?.length) next = next.map(e => eventData.updatedEvents!.find(u => u.id === e.id) ?? e)
              if (eventData.deletedEventIds?.length) next = next.filter(e => !eventData.deletedEventIds!.includes(e.id))
              onEventsUpdate(next, eventData.createdEvents?.map(e => e.id))

              // Toasts — only when chat overlay is closed
              if (!chatOverlayOpen) {
                if (eventData.createdEvents?.length) {
                  const names = eventData.createdEvents.map(e => e.title).join(', ')
                  addToast('event_created', isHe ? `נוצר: ${names}` : `Created: ${names}`)
                }
                if (eventData.deletedEventIds?.length) {
                  addToast('event_created', isHe ? `נמחקו ${eventData.deletedEventIds.length} אירועים` : `Deleted ${eventData.deletedEventIds.length} events`)
                }
              }
            }
          } catch { /* ignore parse errors */ }
        }
      }

      if (!streamingStarted) {
        setMessages(p => [...p, { id: assistantId, role: 'assistant', content: 'Done!', timestamp: new Date() }])
      }

      // Toast for text response when overlay is closed
      if (!chatOverlayOpen && streamingStarted) {
        setMessages(prev => {
          const lastMsg = prev.find(m => m.id === assistantId)
          if (lastMsg && !eventData.createdEvents?.length && !eventData.deletedEventIds?.length) {
            const truncated = lastMsg.content.length > 80 ? lastMsg.content.slice(0, 80) + '…' : lastMsg.content
            addToast('message', truncated)
          }
          return prev
        })
      }

    } catch {
      const errMsg = lang === 'he' ? T.he.error : T.en.error
      setMessages(p => [...p, { id: crypto.randomUUID(), role: 'assistant', content: errMsg, timestamp: new Date() }])
      addToast('error', errMsg)
    } finally {
      setLoading(false)
      setStreamingId(null)
    }
  }, [loading, messages, events, tasks, profile, memory, onEventsUpdate, onTasksUpdate, language, isOnboarding, onProfileUpdate, chatOverlayOpen, addToast])

  const resetChat = useCallback(() => {
    const lang = profile?.language ?? language
    const dynamic = buildDynamicWelcome(events, memory, lang)
    setMessages([{ id: 'welcome', role: 'assistant', content: dynamic, timestamp: new Date() }])
  }, [events, memory, profile, language])

  return {
    messages, setMessages, input, setInput,
    loading, streamingId, memory, isOnboarding,
    sendMessage, resetChat, toasts, dismissToast,
  }
}
