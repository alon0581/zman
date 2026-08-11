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
  stop: () => void
  resetChat: () => void
  retryLast: () => void
  toasts: ToastItem[]
  dismissToast: (id: string) => void
  addToast: (type: ToastItem['type'], text: string) => void
}

// Wall-clock ceiling on a single chat turn. If the server accepts the
// connection and then stalls (no more SSE chunks), we'd otherwise be stuck
// in `loading` forever with no way out but a page reload.
const STREAM_TIMEOUT_MS = 90_000

const T = {
  en: {
    error: 'Something went wrong. Please try again.',
    timeout: 'The request took too long. Please try again.',
    emptyReply: "I finished handling that, but didn't get a full reply back this time.",
  },
  he: {
    error: 'משהו השתבש. נסה שוב.',
    timeout: 'הבקשה ארכה זמן רב מדי. נסה שוב.',
    emptyReply: 'סיימתי לטפל בבקשה, אבל הפעם לא קיבלתי ניסוח מלא מהשרת.',
  },
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
  const lastUserTextRef = useRef('')  // last sent text, for retry-on-error
  const abortControllerRef = useRef<AbortController | null>(null)
  // Distinguishes *why* the in-flight request was aborted, so the catch block
  // can tell "user tapped stop" (silent) apart from "watchdog timed out" (real error).
  const abortReasonRef = useRef<'user' | 'timeout' | null>(null)

  // Never leave a request dangling past unmount
  useEffect(() => {
    return () => { abortControllerRef.current?.abort() }
  }, [])

  // ── Conversation persistence ──────────────────────────────────────────────
  // The server has stored chat history all along (`/api/chat-history`, capped at
  // 100 messages) — but nothing on the client ever called it, so every reload
  // silently threw the conversation away. For an assistant whose whole premise is
  // that it knows you, losing the thread on refresh is the wrong behaviour.
  const historyLoadedRef = useRef(false)
  // Serialized copy of what the server already has, so we never rewrite it unchanged.
  const lastSavedRef = useRef('')

  useEffect(() => {
    // Onboarding starts from a scripted greeting; restoring an old thread there
    // would drop the user into the middle of a conversation they aren't having.
    if (initIsOnboarding) { historyLoadedRef.current = true; return }

    let cancelled = false
    fetch('/api/chat-history')
      .then(res => res.ok ? res.json() : null)
      .then((data: { messages?: Array<{ id: string; role: string; content: string; timestamp: string }> } | null) => {
        if (cancelled || !data?.messages?.length) return
        const restored: Message[] = data.messages.map(m => ({
          id: m.id,
          role: m.role === 'user' ? 'user' as const : 'assistant' as const,
          content: m.content,
          timestamp: new Date(m.timestamp),
        }))
        // Mark what we just loaded as already-saved, so restoring the thread
        // doesn't immediately write the identical file straight back.
        lastSavedRef.current = JSON.stringify(restored)
        setMessages(restored)
      })
      .catch(() => { /* keep the welcome message — a missing history is not an error */ })
      .finally(() => { if (!cancelled) historyLoadedRef.current = true })

    return () => { cancelled = true }
  }, [initIsOnboarding])

  // Write back only once a turn has settled: saving mid-stream would POST on
  // every token. The welcome message alone is not worth persisting.
  useEffect(() => {
    if (!historyLoadedRef.current || loading || isOnboarding) return
    if (messages.length <= 1) return

    // Loading the history sets state, which fires this effect — without this
    // check every app start would write the file back unchanged.
    const serialized = JSON.stringify(messages)
    if (serialized === lastSavedRef.current) return
    lastSavedRef.current = serialized

    fetch('/api/chat-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
    })
      .then(res => { if (!res.ok) console.warn('[chat] history save failed:', res.status) })
      .catch(err => console.warn('[chat] history save failed:', err))
  }, [messages, loading, isOnboarding])

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
    lastUserTextRef.current = text.trim()
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

    // Fresh controller per turn — aborted either by the user (stop()) or by
    // the watchdog timeout below. abortReasonRef records which, so the catch
    // block can tell a deliberate cancel apart from a real failure.
    abortReasonRef.current = null
    const controller = new AbortController()
    abortControllerRef.current = controller
    const timeoutId = setTimeout(() => {
      abortReasonRef.current = 'timeout'
      controller.abort()
    }, STREAM_TIMEOUT_MS)

    try {
      const welcomeMsg = messages.find(m => m.id === 'welcome')
      // Keep recent turns only — calendar/memory state is injected fresh server-side,
      // so old chat is rarely load-bearing. Smaller history = much lower token cost
      // (re-sent on every tool-loop iteration).
      const history = messages.filter(m => m.id !== 'welcome').slice(-14).map(m => ({ role: m.role, content: m.content }))
      const contextMessages = [
        ...(welcomeMsg ? [{ role: 'assistant' as const, content: welcomeMsg.content }] : []),
        ...history,
        { role: 'user' as const, content: text.trim() },
      ]
      const res = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: contextMessages, events: eventsSnapshot, profile, isOnboarding: activeOnboarding, memory, tasks, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
        signal: controller.signal,
      })
      if (!res.ok || !res.body) throw new Error()

      let eventData: { createdEvents?: CalendarEvent[]; updatedEvents?: CalendarEvent[]; deletedEventIds?: string[] } = {}
      let streamingStarted = false
      let streamErrored = false

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
                // Don't open the bubble on a blank/whitespace-only first chunk —
                // otherwise the user is left staring at a permanently empty reply
                // if the server's final text turns out blank (see fallback below).
                if (!parsed.content || !String(parsed.content).trim()) continue
                streamingStarted = true
                setStreamingId(assistantId)
                setMessages(p => [...p, { id: assistantId, role: 'assistant', content: parsed.content, timestamp: new Date() }])
              } else {
                setMessages(p => p.map(m => m.id === assistantId ? { ...m, content: m.content + parsed.content } : m))
              }
            } else if (parsed.type === 'error') {
              // Server signalled a stream failure — flag it (can't throw here; the
              // inner catch below swallows errors). Handled after the loop.
              streamErrored = true
            } else if (parsed.type === 'tasks_updated') {
              onTasksUpdate?.()
            } else if (parsed.type === 'memory_updated') {
              fetch('/api/memory').then(r => {
                if (!r.ok) { console.warn('[useChatEngine] memory refetch failed:', r.status); return [] }
                return r.json()
              }).then(data => {
                if (Array.isArray(data)) setMemory(data)
              }).catch(err => console.warn('[useChatEngine] memory refetch failed:', err))
            } else if (parsed.type === 'onboarding_complete') {
              setIsOnboarding(false)
              onProfileUpdate(parsed.profile)
              fetch('/api/memory').then(r => {
                if (!r.ok) { console.warn('[useChatEngine] memory refetch failed:', r.status); return [] }
                return r.json()
              }).then(data => {
                if (Array.isArray(data)) setMemory(data)
              }).catch(err => console.warn('[useChatEngine] memory refetch failed:', err))
              fetch('/api/profile', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...parsed.profile, onboarding_completed: true }),
              }).then(r => {
                if (!r.ok) console.warn('[useChatEngine] onboarding profile save failed:', r.status)
              }).catch(err => console.warn('[useChatEngine] onboarding profile save failed:', err))
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
          if (streamErrored) break
        }
        if (streamErrored) break
      }

      if (streamErrored) throw new Error('stream_error')

      if (!streamingStarted) {
        const emptyReply = isHe ? T.he.emptyReply : T.en.emptyReply
        setMessages(p => [...p, { id: assistantId, role: 'assistant', content: emptyReply, timestamp: new Date() }])
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

    } catch (err) {
      const wasAborted = err instanceof DOMException && err.name === 'AbortError'
      if (wasAborted && abortReasonRef.current === 'user') {
        // The user tapped "stop" — this is a deliberate action, not a failure.
        // No error bubble, no toast; whatever streamed in so far stays as-is.
      } else if (wasAborted && abortReasonRef.current === 'timeout') {
        const errMsg = isHe ? T.he.timeout : T.en.timeout
        setMessages(p => [...p, { id: crypto.randomUUID(), role: 'assistant', content: errMsg, timestamp: new Date(), isError: true }])
        addToast('error', errMsg)
      } else {
        const errMsg = isHe ? T.he.error : T.en.error
        setMessages(p => [...p, { id: crypto.randomUUID(), role: 'assistant', content: errMsg, timestamp: new Date(), isError: true }])
        addToast('error', errMsg)
      }
    } finally {
      clearTimeout(timeoutId)
      abortControllerRef.current = null
      setLoading(false)
      setStreamingId(null)
    }
  }, [loading, messages, events, tasks, profile, memory, onEventsUpdate, onTasksUpdate, language, isOnboarding, onProfileUpdate, chatOverlayOpen, addToast])

  // Aborts the in-flight request (if any) and clears loading state. Used by
  // the ChatOverlay "stop" affordance to escape a stalled/stuck response.
  const stop = useCallback(() => {
    if (abortControllerRef.current) {
      abortReasonRef.current = 'user'
      abortControllerRef.current.abort()
    }
  }, [])

  const resetChat = useCallback(() => {
    const lang = profile?.language ?? language
    const dynamic = buildDynamicWelcome(events, memory, lang)
    setMessages([{ id: 'welcome', role: 'assistant', content: dynamic, timestamp: new Date() }])
  }, [events, memory, profile, language])

  // Retry the last user message after a failure (drops the trailing error bubble)
  const retryLast = useCallback(() => {
    const text = lastUserTextRef.current
    if (!text || loading) return
    setMessages(p => p.filter(m => !m.isError))
    void sendMessage(text)
  }, [loading, sendMessage])

  return {
    messages, setMessages, input, setInput,
    loading, streamingId, memory, isOnboarding,
    sendMessage, stop, resetChat, retryLast, toasts, dismissToast, addToast,
  }
}
