'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { User } from '@supabase/supabase-js'
import { AIMemory, CalendarEvent, Message, Task, UserProfile } from '@/types'
import { Send, Mic, Square, RotateCcw } from 'lucide-react'

// ─── Dynamic welcome builder ─────────────────────────────────────────────────
function buildDynamicWelcome(
  events: CalendarEvent[],
  memory: AIMemory[],
  lang: string,
): string {
  const now = new Date()
  const hour = now.getHours()
  const isHe = lang === 'he'

  // Name from memory
  const nameMem = memory.find(m => m.key === 'name' || m.key === 'personal_name')
  const name = nameMem?.value?.split(' ')[0] // first name only

  // Today's events (sorted)
  const todayStr = now.toDateString()
  const todayEvents = events
    .filter(e => new Date(e.start_time).toDateString() === todayStr)
    .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())

  const nextEvent = todayEvents.find(e => new Date(e.start_time) > now)

  // Ongoing task from memory (for cross-device continuity)
  const ongoingTask = memory.find(m => m.key === 'ongoing_task' || m.key === 'ongoing_project')?.value

  // Upcoming urgent (exam / deadline) in next 7 days
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

// ─── Calendar intent detector (for smart onboarding bypass) ──────────────────
function hasCalendarIntent(text: string): boolean {
  const t = text.toLowerCase()
  const keywords = [
    // Hebrew — clear scheduling actions/nouns only
    'הוסף', 'צור', 'קבע', 'תזמן', 'תוסיף', 'תקבע', 'לוח שנה', 'לו"ז',
    'אירוע', 'פגישה', 'הגשה', 'דדליין', 'שבוע הבא',
    'כל שלישי', 'כל ראשון', 'כל שני', 'כל רביעי', 'כל חמישי', 'כל שישי',
    'בשעה ',
    // English — clear scheduling actions only
    'add to calendar', 'create event', 'schedule ', 'put on calendar',
    'calendar', 'meeting at', 'class at', 'exam on',
    'appointment', 'deadline', 'next week',
    'every monday', 'every tuesday', 'every wednesday', 'every thursday',
    'every friday', 'every saturday', 'every sunday',
  ]
  return keywords.some(k => t.includes(k))
}

interface Props {
  user: User
  profile: UserProfile | null
  events: CalendarEvent[]
  tasks?: Task[]
  language: string
  onEventsUpdate: (events: CalendarEvent[], addedIds?: string[]) => void
  onProfileUpdate: (profile: UserProfile) => void
  onTasksUpdate?: () => void
  isOnboarding?: boolean
  prefillInput?: string
  onPrefillConsumed?: () => void
}

const T = {
  en: {
    header: 'AI Assistant',
    subtitle: 'Talk or type to manage your schedule',
    welcome: `Hey! I'm Zman, your AI scheduler. Tell me what's on your plate — or just tap the mic and talk to me. 🎙️`,
    onboardingWelcome: `Hey! I'm Zman, your new AI scheduler 👋\n\nBefore we dive in, I'd love to take 2 minutes to get to know you — so I can actually be useful to you.\n\nLet's start simple: **What do you do?** Student? Working? Both?`,
    placeholder: 'Type a message…',
    holdMic: 'Hold to speak',
    recording: '🔴 Listening…',
    micDenied: '🎤 Microphone access denied. Please allow it in your browser settings.',
    error: 'Something went wrong. Please try again.',
    online: 'Online',
  },
  he: {
    header: 'עוזר AI',
    subtitle: 'דבר או כתוב כדי לנהל את הלוח זמנים שלך',
    welcome: `היי! אני זמן, המתזמן החכם שלך. ספר לי מה יש לך — או פשוט לחץ על המיק ודבר אליי. 🎙️`,
    onboardingWelcome: `היי! אני זמן, המתזמן החכם שלך 👋\n\nלפני שנתחיל, אשמח לקחת 2 דקות להכיר אותך — כדי שאוכל להיות שימושי באמת.\n\nנתחיל מהפשוט: **מה אתה עושה?** סטודנט? עובד? שניהם?`,
    placeholder: 'כתוב הודעה…',
    holdMic: 'לחץ לדיבור',
    recording: '🔴 מקשיב…',
    micDenied: '🎤 הגישה למיקרופון נדחתה. אפשר בהגדרות הדפדפן.',
    error: 'משהו השתבש. נסה שוב.',
    online: 'פעיל',
  },
} as const
type Lang = keyof typeof T
function tr(lang: string, k: keyof typeof T['en']) { return (T[lang as Lang] ?? T.en)[k] }

export default function ChatPanel({ user, profile: initProfile, events, tasks = [], language, onEventsUpdate, onProfileUpdate, onTasksUpdate, isOnboarding: initIsOnboarding, prefillInput, onPrefillConsumed }: Props) {
  const [profile, setProfile] = useState<UserProfile | null>(initProfile)
  const [isOnboarding, setIsOnboarding] = useState(!!initIsOnboarding)
  const [memory, setMemory] = useState<AIMemory[]>([])

  // Chat lives in React state only — fresh on every page load, persists within session
  const [messages, setMessages] = useState<Message[]>([{
    id: 'welcome', role: 'assistant' as const,
    content: initIsOnboarding
      ? (T[initProfile?.language as keyof typeof T]?.onboardingWelcome ?? T.en.onboardingWelcome)
      : tr(initProfile?.language ?? language, 'welcome'),
    timestamp: new Date(),
  }])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [streamingId, setStreamingId] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)

  const bottomRef         = useRef<HTMLDivElement>(null)
  const inputRef          = useRef<HTMLInputElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef    = useRef<any>(null)
  const isHoldingRef      = useRef(false)   // pointer currently pressed?
  const holdModeRef       = useRef(false)   // true = hold mode (auto-send on release)
  const sendMsgRef        = useRef<(t: string) => void>(() => {})
  const pressStartRef     = useRef<number>(0)         // timestamp of pointer-down
  const recordingRef      = useRef(false)              // mirror of `recording` state — always current in event handlers
  const lastTranscriptRef = useRef('')                 // accumulated Web Speech transcript
  const cachedStreamRef   = useRef<MediaStream | null>(null) // cached mic stream — keeps permission warm in session

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

      // Smart onboarding bypass: user has memory → they've been here before
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

      // Update welcome with personalized greeting (always fresh on load)
      if (!initIsOnboarding || loadedMemory.length > 0) {
        const lang = loadedProfile?.language ?? language
        const dynamic = buildDynamicWelcome(loadedEvents, loadedMemory, lang)
        setMessages([{ id: 'welcome', role: 'assistant', content: dynamic, timestamp: new Date() }])
      }
    })
  }, [])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || loading) return
    const um: Message = { id: crypto.randomUUID(), role: 'user', content: text.trim(), timestamp: new Date() }
    setMessages(p => [...p, um])
    setInput('')
    setLoading(true)

    const assistantId = crypto.randomUUID()
    // snapshot events for closure
    const eventsSnapshot = events

    // ── Smart onboarding bypass ──────────────────────────────────────────────
    // If user has memory OR is clearly trying to schedule something, exit
    // onboarding mode immediately — no button, no friction.
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
    // ────────────────────────────────────────────────────────────────────────

    try {
      // Include welcome message as first assistant turn so AI knows what it already asked.
      // Then limit history to last 40 messages to avoid context overflow.
      const welcomeMsg = messages.find(m => m.id === 'welcome')
      const history = messages.filter(m => m.id !== 'welcome').slice(-40).map(m => ({ role: m.role, content: m.content }))
      const contextMessages = [
        ...(welcomeMsg ? [{ role: 'assistant' as const, content: welcomeMsg.content }] : []),
        ...history,
        { role: 'user' as const, content: text.trim() },
      ]
      const res = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: contextMessages, events: eventsSnapshot, profile, isOnboarding: activeOnboarding, memory, tasks }),
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
              // AI called save_memory — re-fetch so next messages include new memory
              fetch('/api/memory').then(r => r.ok ? r.json() : []).then(data => {
                if (Array.isArray(data)) setMemory(data)
              }).catch(() => {})
            } else if (parsed.type === 'onboarding_complete') {
              setIsOnboarding(false)
              onProfileUpdate(parsed.profile)
              // Re-fetch memory saved during onboarding
              fetch('/api/memory').then(r => r.ok ? r.json() : []).then(data => {
                if (Array.isArray(data)) setMemory(data)
              }).catch(() => {})
              // Safety save: ensure onboarding_completed:true is persisted even if server write failed
              fetch('/api/profile', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...parsed.profile, onboarding_completed: true }),
              }).catch(() => { /* ignore */ })
            } else if (parsed.type === 'done') {
              // Apply event updates
              let next = [...eventsSnapshot]
              if (eventData.createdEvents?.length) next = [...next, ...eventData.createdEvents]
              if (eventData.updatedEvents?.length) next = next.map(e => eventData.updatedEvents!.find(u => u.id === e.id) ?? e)
              if (eventData.deletedEventIds?.length) next = next.filter(e => !eventData.deletedEventIds!.includes(e.id))
              onEventsUpdate(next, eventData.createdEvents?.map(e => e.id))
            }
          } catch { /* ignore parse errors */ }
        }
      }

      // Ensure message has content if streaming never started
      if (!streamingStarted) {
        setMessages(p => [...p, { id: assistantId, role: 'assistant', content: 'Done!', timestamp: new Date() }])
      }
      setMessages(p => p.map(m => m.id === assistantId && !m.content ? { ...m, content: 'Done!' } : m))

    } catch {
      setMessages(p => p.filter(m => m.id !== assistantId))
      setMessages(p => [...p, { id: crypto.randomUUID(), role: 'assistant', content: tr(language, 'error'), timestamp: new Date() }])
    } finally {
      setLoading(false)
      setStreamingId(null)
      inputRef.current?.focus()
    }
  }, [loading, messages, events, tasks, profile, memory, onEventsUpdate, onTasksUpdate, language])

  // Keep ref current so mic onstop can call latest sendMessage without stale closure
  useEffect(() => { sendMsgRef.current = sendMessage }, [sendMessage])
  // Mirror recording state into a ref so event handlers always see the latest value
  useEffect(() => { recordingRef.current = recording }, [recording])

  // When parent pre-fills the input (e.g. Schedule button from TasksPanel)
  useEffect(() => {
    if (prefillInput) {
      setInput(prefillInput)
      setTimeout(() => inputRef.current?.focus(), 100)
      onPrefillConsumed?.()
    }
  }, [prefillInput])

  // Mic permission note:
  // We do NOT pre-warm getUserMedia on mount (would show a popup before the user taps anything).
  // Instead, on first tap we request the stream and cache it for the rest of the session.
  // Chrome/Android permanently caches the permission grant per HTTPS domain — no repeat prompts.
  // iOS Safari re-prompts each session regardless (browser security limit, not fixable via code).

  const lang  = profile?.language ?? language
  const isRTL = lang === 'he' || lang === 'ar'

  const startRecording = async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) {
      setMessages(p => [...p, { id: crypto.randomUUID(), role: 'assistant' as const, content: tr(lang, 'micDenied'), timestamp: new Date() }])
      return
    }

    // Cache the MediaStream on first use so the browser keeps the permission warm
    // for the rest of this page session (avoids repeated prompts within same visit)
    if (!cachedStreamRef.current && navigator.mediaDevices?.getUserMedia) {
      try {
        cachedStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true })
      } catch {
        // Permission denied — Web Speech API will surface its own error via onerror
      }
    }

    const recognition = new SR()
    recognition.lang = lang === 'he' ? 'he-IL' : lang === 'ar' ? 'ar-SA' : 'en-US'
    recognition.continuous = true       // stay alive until explicitly stopped (no auto-stop on silence)
    recognition.interimResults = false
    recognition.maxAlternatives = 1
    recognitionRef.current = recognition
    holdModeRef.current = false          // default: toggle mode — set to true on long-press release
    lastTranscriptRef.current = ''

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognition.onresult = (e: any) => {
      // Accumulate all final results so far
      let text = ''
      for (let i = 0; i < e.results.length; i++) {
        if (e.results[i].isFinal) text += (text ? ' ' : '') + e.results[i][0].transcript
      }
      lastTranscriptRef.current = text.trim()
    }
    recognition.onerror = () => { setRecording(false); recognitionRef.current = null }
    recognition.onend = () => {
      setRecording(false)
      recognitionRef.current = null
      const text = lastTranscriptRef.current
      if (text) {
        if (holdModeRef.current) { sendMsgRef.current(text) }
        else { setInput(text); setTimeout(() => inputRef.current?.focus(), 50) }
      }
    }

    recognition.start()
    setRecording(true)
  }

  const stopRecording = () => {
    recognitionRef.current?.stop()
    recognitionRef.current = null
    setRecording(false)
  }

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault()  // prevent long-press text-selection popup on mobile
    if (recordingRef.current) {
      // 2nd tap → stop → text goes to input (toggle mode)
      holdModeRef.current = false
      stopRecording()
      return
    }
    pressStartRef.current = Date.now()
    isHoldingRef.current = true
    startRecording()  // async — permission/stream cached on first call
  }

  const handlePointerUp = () => {
    isHoldingRef.current = false
    const elapsed = Date.now() - pressStartRef.current
    if (recordingRef.current && elapsed >= 400) {
      // Long press (≥ 400 ms) → hold mode → auto-send on release
      holdModeRef.current = true
      stopRecording()
    }
    // Quick tap (< 400 ms): leave recording running — user taps again to stop (toggle mode)
  }

  return (
    <div dir={isRTL ? 'rtl' : 'ltr'} className="chat-panel-glass" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>

      {/* Header */}
      <div style={{ padding: '20px 22px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text)' }}>
            {tr(lang, 'header')}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {/* New chat button — resets conversation, memory stays intact */}
          {!isOnboarding && messages.filter(m => m.role === 'user').length >= 1 && (
            <button
              onClick={() => {
                const dynamic = buildDynamicWelcome(events, memory, profile?.language ?? language)
                setMessages([{ id: 'welcome', role: 'assistant', content: dynamic, timestamp: new Date() }])
              }}
              title={lang === 'he' ? 'שיחה חדשה' : 'New chat'}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 30, height: 30, borderRadius: 8, border: '1px solid var(--border-hi)',
                background: 'transparent', color: 'var(--text-2)', cursor: 'pointer',
                transition: 'background 0.15s, color 0.15s', flexShrink: 0,
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-card)'; (e.currentTarget as HTMLElement).style.color = 'var(--text)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = 'var(--text-2)' }}
            >
              <RotateCcw size={13} />
            </button>
          )}
          {/* Skip onboarding — shown after first user message so the user is never trapped */}
          {isOnboarding && messages.filter(m => m.role === 'user').length >= 1 && (
            <button
              onClick={async () => {
                const updatedProfile = { ...(profile ?? {}), onboarding_completed: true } as UserProfile
                await fetch('/api/profile', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(updatedProfile),
                }).catch(() => { /* ignore */ })
                setIsOnboarding(false)
                onProfileUpdate(updatedProfile)
              }}
              style={{
                fontSize: 12, fontWeight: 600, color: 'var(--blue)', background: 'transparent',
                border: '1px solid var(--border-hi)', borderRadius: 8, padding: '4px 10px',
                cursor: 'pointer', flexShrink: 0,
              }}
            >
              {lang === 'he' ? 'דלג ←' : 'Skip →'}
            </button>
          )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
          {!isOnboarding && (
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--green)', flexShrink: 0, animation: 'pulseOnline 2.5s ease-in-out infinite' }} />
          )}
          <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
            {isOnboarding
              ? (lang === 'he' ? 'ספר לי קצת עליך…' : 'Tell me a bit about yourself…')
              : tr(lang, 'subtitle')}
          </div>
        </div>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 18px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {messages.map(msg => <Bubble key={msg.id} msg={msg} isRTL={isRTL} isStreaming={msg.id === streamingId} />)}
        {loading && !streamingId && <TypingBubble />}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{ flexShrink: 0, padding: '12px 18px 20px', borderTop: '1px solid var(--border)' }}>

        {/* Mic button — always centered above input, never shifts layout */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}>
          <button
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            onContextMenu={e => e.preventDefault()}
            className={recording ? 'mic-recording' : ''}
            style={{
              width: 44, height: 44, borderRadius: 14, border: 'none', cursor: 'pointer', flexShrink: 0,
              background: recording ? 'linear-gradient(135deg,#EF4444,#DC2626)' : 'linear-gradient(135deg,#3B7EF7,#6366F1)',
              color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: recording ? '0 4px 20px rgba(239,68,68,0.5)' : '0 4px 20px rgba(59,126,247,0.45)',
              transition: 'background 0.2s, box-shadow 0.2s',
              WebkitUserSelect: 'none', userSelect: 'none', touchAction: 'manipulation',
            } as React.CSSProperties}
          >
            {recording ? <Square size={14} fill="white" /> : <Mic size={18} />}
          </button>
        </div>

        {/* Text input row */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input) } }}
            placeholder={recording ? tr(lang, 'recording') : tr(lang, 'placeholder')}
            disabled={loading}
            dir={isRTL ? 'rtl' : 'ltr'}
            style={{
              flex: 1, padding: '11px 16px', borderRadius: 14, outline: 'none', fontFamily: 'inherit',
              border: `1px solid ${recording ? 'rgba(239,68,68,0.45)' : 'var(--border-hi)'}`,
              background: recording ? 'rgba(239,68,68,0.06)' : 'var(--bg-input)',
              color: recording ? '#F87171' : 'var(--text)',
              fontSize: 16, opacity: loading ? 0.5 : 1,  /* 16px prevents iOS auto-zoom */
              transition: 'background 0.2s, border-color 0.2s, color 0.2s',
            }}
            onFocus={e => { if (!recording) { e.currentTarget.style.borderColor = 'var(--blue)'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(59,126,247,0.15)' } }}
            onBlur={e => { e.currentTarget.style.borderColor = recording ? 'rgba(239,68,68,0.45)' : 'var(--border-hi)'; e.currentTarget.style.boxShadow = 'none' }}
          />

          {/* Send — shown only when there's text and not recording */}
          {input.trim() && !recording && (
            <button
              onClick={() => sendMessage(input)}
              disabled={loading}
              style={{
                width: 42, height: 42, borderRadius: 13, border: 'none', cursor: 'pointer', flexShrink: 0,
                background: 'linear-gradient(135deg,#3B7EF7,#6366F1)', color: '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 4px 14px rgba(59,126,247,0.4)',
                opacity: loading ? 0.4 : 1, transition: 'all 0.15s',
              }}
            >
              <Send size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Markdown renderer (no external dependency) ──────────────────────────────
function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g)
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4)
      return <strong key={i}>{part.slice(2, -2)}</strong>
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2)
      return <em key={i}>{part.slice(1, -1)}</em>
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2)
      return <code key={i} style={{ background: 'rgba(255,255,255,0.12)', padding: '1px 5px', borderRadius: 4, fontSize: '0.88em', fontFamily: 'monospace' }}>{part.slice(1, -1)}</code>
    return part
  })
}

function renderMarkdown(text: string, isUser: boolean): React.ReactNode {
  const lines = text.split('\n')
  const nodes: React.ReactNode[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    // Bullet list item
    if (/^[\-\*•]\s+/.test(line)) {
      nodes.push(
        <div key={i} style={{ display: 'flex', gap: 7, marginTop: nodes.length ? 3 : 0 }}>
          <span style={{ opacity: 0.6, flexShrink: 0, lineHeight: 1.55 }}>•</span>
          <span>{renderInline(line.replace(/^[\-\*•]\s+/, ''))}</span>
        </div>
      )
    } else if (line === '') {
      // Only add spacing if there's something before and after
      if (nodes.length > 0 && i < lines.length - 1) {
        nodes.push(<div key={i} style={{ height: 5 }} />)
      }
    } else {
      nodes.push(
        <div key={i} style={{ marginTop: nodes.length && lines[i - 1] !== '' ? 3 : 0 }}>
          {renderInline(line)}
        </div>
      )
    }
    i++
  }
  return isUser ? <span>{nodes}</span> : <>{nodes}</>
}

function Bubble({ msg, isRTL, isStreaming }: { msg: Message; isRTL: boolean; isStreaming?: boolean }) {
  const isUser = msg.role === 'user'
  return (
    <div style={{ display: 'flex', flexDirection: isUser ? 'row-reverse' : 'row', gap: 10, alignItems: 'flex-end' }}>
      {!isUser && (
        <div style={{
          width: 30, height: 30, borderRadius: 10, background: 'linear-gradient(135deg,#3B7EF7,#6366F1)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, fontWeight: 900, color: '#fff', flexShrink: 0,
          boxShadow: '0 2px 10px rgba(59,126,247,0.35)',
        }}>Z</div>
      )}
      <div style={{
        maxWidth: '75%', padding: '11px 15px', borderRadius: isUser ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
        background: isUser ? 'linear-gradient(135deg,#3B7EF7,#6366F1)' : 'rgba(22,22,38,0.88)',
        backdropFilter: isUser ? undefined : 'blur(12px)',
        WebkitBackdropFilter: isUser ? undefined : 'blur(12px)',
        color: isUser ? '#fff' : 'var(--text)',
        border: isUser ? 'none' : '1px solid rgba(255,255,255,0.09)',
        fontSize: 14, lineHeight: 1.55, direction: isRTL ? 'rtl' : 'ltr',
        boxShadow: isUser ? '0 4px 20px rgba(59,126,247,0.45), 0 2px 8px rgba(0,0,0,0.3)' : '0 2px 16px rgba(0,0,0,0.4)',
      }}>
        {renderMarkdown(msg.content, isUser)}
        {isStreaming && <span style={{ display: 'inline-block', width: 8, height: 14, background: 'var(--blue)', borderRadius: 2, marginLeft: 3, verticalAlign: 'middle', animation: 'blink 0.8s step-end infinite' }} />}
      </div>
    </div>
  )
}

function TypingBubble() {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
      <div style={{ width: 30, height: 30, borderRadius: 10, background: 'linear-gradient(135deg,#3B7EF7,#6366F1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 900, color: '#fff', flexShrink: 0 }}>Z</div>
      <div style={{ padding: '12px 16px', borderRadius: '18px 18px 18px 4px', background: 'rgba(22,22,38,0.88)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.09)', display: 'flex', gap: 5, alignItems: 'center', boxShadow: '0 2px 16px rgba(0,0,0,0.4)' }}>
        <div className="typing-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--blue)' }} />
        <div className="typing-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--blue)' }} />
        <div className="typing-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--blue)' }} />
      </div>
    </div>
  )
}
