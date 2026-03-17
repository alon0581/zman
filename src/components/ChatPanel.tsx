'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { User } from '@supabase/supabase-js'
import { AIMemory, CalendarEvent, Message, UserProfile } from '@/types'
import { Send, Mic, Square } from 'lucide-react'

// ─── Session-storage persistence ────────────────────────────────────────────
const CHAT_KEY = 'zman_chat'

function loadStoredMessages(): Message[] | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(CHAT_KEY)
    if (!raw) return null
    const arr = JSON.parse(raw) as Array<{ id: string; role: string; content: string; timestamp: string }>
    if (!Array.isArray(arr) || arr.length === 0) return null
    return arr.map(m => ({ ...m, role: m.role as Message['role'], timestamp: new Date(m.timestamp) }))
  } catch { return null }
}

function persistMessages(msgs: Message[]) {
  try { sessionStorage.setItem(CHAT_KEY, JSON.stringify(msgs.slice(-100))) } catch { /* ignore */ }
}

function clearStoredMessages() {
  try { sessionStorage.removeItem(CHAT_KEY) } catch { /* ignore */ }
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

  // Name from memory
  const nameMem = memory.find(m => m.key === 'name' || m.key === 'personal_name')
  const name = nameMem?.value?.split(' ')[0] // first name only

  // Today's events (sorted)
  const todayStr = now.toDateString()
  const todayEvents = events
    .filter(e => new Date(e.start_time).toDateString() === todayStr)
    .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())

  const nextEvent = todayEvents.find(e => new Date(e.start_time) > now)

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

    if (urgent.length > 0) {
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

    if (urgent.length > 0) {
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

interface Props {
  user: User
  profile: UserProfile | null
  events: CalendarEvent[]
  language: string
  onEventsUpdate: (events: CalendarEvent[], addedIds?: string[]) => void
  onProfileUpdate: (profile: UserProfile) => void
  isOnboarding?: boolean
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

export default function ChatPanel({ user, profile: initProfile, events, language, onEventsUpdate, onProfileUpdate, isOnboarding: initIsOnboarding }: Props) {
  const [profile, setProfile] = useState<UserProfile | null>(initProfile)
  const [isOnboarding, setIsOnboarding] = useState(!!initIsOnboarding)
  const [memory, setMemory] = useState<AIMemory[]>([])

  // Restore conversation from sessionStorage (survives Settings navigation)
  const [messages, setMessages] = useState<Message[]>(() => {
    if (!initIsOnboarding) {
      const stored = loadStoredMessages()
      if (stored && stored.length > 0) return stored
    }
    return [{
      id: 'welcome', role: 'assistant' as const,
      content: initIsOnboarding
        ? (T[initProfile?.language as keyof typeof T]?.onboardingWelcome ?? T.en.onboardingWelcome)
        : tr(initProfile?.language ?? language, 'welcome'),
      timestamp: new Date(),
    }]
  })
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [streamingId, setStreamingId] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [micPending, setMicPending] = useState(false)

  const bottomRef        = useRef<HTMLDivElement>(null)
  const inputRef         = useRef<HTMLInputElement>(null)
  const recorderRef      = useRef<MediaRecorder | null>(null)
  const chunksRef        = useRef<Blob[]>([])
  const recordStartRef   = useRef<number>(0)
  const isHoldingRef     = useRef(false)   // pointer currently pressed?
  const holdModeRef      = useRef(false)   // recording started while pointer was down?
  const sendMsgRef       = useRef<(t: string) => void>(() => {})

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

      // Update welcome message only if still showing the initial placeholder
      // (i.e. we did NOT restore a conversation from sessionStorage)
      if (!initIsOnboarding) {
        setMessages(prev => {
          if (prev.length === 1 && prev[0].id === 'welcome') {
            const lang = loadedProfile?.language ?? language
            const dynamic = buildDynamicWelcome(loadedEvents, loadedMemory, lang)
            return [{ ...prev[0], content: dynamic }]
          }
          return prev
        })
      }
    })
  }, [])

  // Persist conversation in sessionStorage so it survives navigation to /settings and back
  useEffect(() => {
    if (!isOnboarding) persistMessages(messages)
  }, [messages, isOnboarding])

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

    try {
      const history = messages.filter(m => m.id !== 'welcome').map(m => ({ role: m.role, content: m.content }))
      const res = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [...history, { role: 'user', content: text.trim() }], events: eventsSnapshot, profile, isOnboarding, memory }),
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
            } else if (parsed.type === 'onboarding_complete') {
              setIsOnboarding(false)
              onProfileUpdate(parsed.profile)
              setMemory([]) // will reload on next fetch if needed
              clearStoredMessages() // fresh start after onboarding
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
  }, [loading, messages, events, profile, onEventsUpdate, language])

  // Keep ref current so mic onstop can call latest sendMessage without stale closure
  useEffect(() => { sendMsgRef.current = sendMessage }, [sendMessage])

  const lang  = profile?.language ?? language
  const isRTL = lang === 'he' || lang === 'ar'

  const startRecording = async () => {
    setMicPending(true)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream)
      chunksRef.current = []
      recordStartRef.current = Date.now()

      rec.ondataavailable = e => chunksRef.current.push(e.data)
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())

        // Ignore very short recordings (< 600ms)
        if (Date.now() - recordStartRef.current < 600) return

        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })

        // Ignore near-silent blobs (< 3 KB)
        if (blob.size < 3000) return

        const fd = new FormData()
        fd.append('audio', blob, 'rec.webm')
        if (lang && lang !== 'auto') fd.append('lang', lang)

        const res = await fetch('/api/transcribe', { method: 'POST', body: fd })
        if (res.ok) {
          const { text } = await res.json()
          if (text?.trim()) {
            if (holdModeRef.current) {
              // Hold mode: auto-send directly to chat
              sendMsgRef.current(text.trim())
            } else {
              // Toggle mode: put in input for user review
              setInput(text.trim())
              setTimeout(() => inputRef.current?.focus(), 50)
            }
          }
        }
      }
      recorderRef.current = rec
      // Capture hold mode at the moment recording actually starts
      holdModeRef.current = isHoldingRef.current
      setMicPending(false)
      rec.start()
      setRecording(true)
    } catch {
      setMicPending(false)
      setMessages(p => [...p, { id: crypto.randomUUID(), role: 'assistant' as const, content: tr(lang, 'micDenied'), timestamp: new Date() }])
    }
  }

  const stopRecording = () => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
    setRecording(false)
  }

  const handlePointerDown = () => {
    if (micPending) return
    if (recording) {
      // 2nd tap in toggle mode → stop → text goes to input
      holdModeRef.current = false
      stopRecording()
      return
    }
    isHoldingRef.current = true
    startRecording()
  }

  const handlePointerUp = () => {
    isHoldingRef.current = false
    if (recording) {
      // Released while recording → hold mode → auto-send
      holdModeRef.current = true
      stopRecording()
    }
  }

  return (
    <div dir={isRTL ? 'rtl' : 'ltr'} style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-panel)' }}>

      {/* Header */}
      <div style={{ padding: '20px 22px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text)' }}>
          {tr(lang, 'header')}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 3 }}>
          {isOnboarding
            ? (lang === 'he' ? 'ספר לי קצת עליך…' : 'Tell me a bit about yourself…')
            : tr(lang, 'subtitle')}
        </div>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 18px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {messages.map(msg => <Bubble key={msg.id} msg={msg} isRTL={isRTL} isStreaming={msg.id === streamingId} />)}
        {loading && !streamingId && <TypingBubble />}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{ flexShrink: 0, padding: '16px 18px 20px', borderTop: '1px solid var(--border)', position: 'relative' }}>
        {/* Floating mic */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
          <button
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            disabled={micPending}
            className={recording ? 'mic-recording' : ''}
            style={{
              width: 48, height: 48, borderRadius: '50%', border: 'none', cursor: micPending ? 'default' : 'pointer',
              background: recording ? 'linear-gradient(135deg,#EF4444,#DC2626)' : 'linear-gradient(135deg,#3B7EF7,#6366F1)',
              color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: recording ? '0 4px 20px rgba(239,68,68,0.5)' : '0 4px 20px rgba(59,126,247,0.45)',
              transition: 'background 0.2s, box-shadow 0.2s',
              opacity: micPending ? 0.5 : 1,
              userSelect: 'none',
            }}
          >
            {recording ? <Square size={14} fill="white" /> : <Mic size={18} />}
          </button>
        </div>

        {/* Text input */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input) } }}
            placeholder={tr(lang, 'placeholder')}
            disabled={loading || recording}
            dir={isRTL ? 'rtl' : 'ltr'}
            style={{
              flex: 1, padding: '11px 16px', borderRadius: 14, border: '1px solid var(--border-hi)',
              background: 'var(--bg-input)', color: 'var(--text)', fontSize: 14, outline: 'none',
              fontFamily: 'inherit', opacity: (loading || recording) ? 0.5 : 1,
            }}
            onFocus={e => { e.currentTarget.style.borderColor = 'var(--blue)'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(59,126,247,0.15)' }}
            onBlur={e => { e.currentTarget.style.borderColor = 'var(--border-hi)'; e.currentTarget.style.boxShadow = 'none' }}
          />
          <button
            onClick={() => sendMessage(input)}
            disabled={!input.trim() || loading}
            style={{
              width: 42, height: 42, borderRadius: 13, border: 'none', cursor: 'pointer',
              background: input.trim() ? 'linear-gradient(135deg,#3B7EF7,#6366F1)' : 'var(--bg-card)',
              color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: input.trim() ? '0 4px 14px rgba(59,126,247,0.4)' : 'none',
              opacity: (!input.trim() || loading) ? 0.4 : 1,
              transition: 'all 0.15s', flexShrink: 0,
            }}
          >
            <Send size={14} />
          </button>
        </div>

        {recording && (
          <div style={{ textAlign: 'center', fontSize: 11, color: '#F87171', marginTop: 8 }}>
            {tr(lang, 'recording')}
          </div>
        )}
      </div>
    </div>
  )
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
        background: isUser ? 'linear-gradient(135deg,#3B7EF7,#6366F1)' : 'var(--bg-card)',
        color: isUser ? '#fff' : 'var(--text)',
        border: isUser ? 'none' : '1px solid var(--border-hi)',
        fontSize: 14, lineHeight: 1.55, whiteSpace: 'pre-wrap', direction: isRTL ? 'rtl' : 'ltr',
        boxShadow: isUser ? '0 4px 16px rgba(59,126,247,0.35)' : '0 2px 8px rgba(0,0,0,0.25)',
      }}>
        {msg.content}
        {isStreaming && <span style={{ display: 'inline-block', width: 8, height: 14, background: 'var(--blue)', borderRadius: 2, marginLeft: 3, verticalAlign: 'middle', animation: 'blink 0.8s step-end infinite' }} />}
      </div>
    </div>
  )
}

function TypingBubble() {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
      <div style={{ width: 30, height: 30, borderRadius: 10, background: 'linear-gradient(135deg,#3B7EF7,#6366F1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 900, color: '#fff', flexShrink: 0 }}>Z</div>
      <div style={{ padding: '12px 16px', borderRadius: '18px 18px 18px 4px', background: 'var(--bg-card)', border: '1px solid var(--border-hi)', display: 'flex', gap: 5, alignItems: 'center', boxShadow: '0 2px 8px rgba(0,0,0,0.25)' }}>
        <div className="typing-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--blue)' }} />
        <div className="typing-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--blue)' }} />
        <div className="typing-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--blue)' }} />
      </div>
    </div>
  )
}
