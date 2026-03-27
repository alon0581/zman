'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Mic, MicOff, Send, X, Loader2 } from 'lucide-react'
import { UserProfile, AIMemory } from '@/types'

interface Props {
  profile: UserProfile
  memory: AIMemory[]
  language?: string
  onComplete: (updatedProfile: UserProfile) => void
  onSkip: () => void
}

type Msg = { role: 'user' | 'assistant'; content: string }
type RecState = 'idle' | 'recording' | 'processing'

const TRIGGER_HE = 'היי זמן, אני רוצה לבחור שיטת ניהול זמן שמתאימה לי'
const TRIGGER_EN = 'Hi Zman, I want to find the right time management method for me'

export default function MethodOnboardingModal({ profile, memory, language, onComplete, onSkip }: Props) {
  const isHe = language === 'he'
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [recState, setRecState] = useState<RecState>('idle')
  const [done, setDone] = useState(false)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef   = useRef<Blob[]>([])
  const streamRef   = useRef<MediaStream | null>(null)
  const bottomRef   = useRef<HTMLDivElement>(null)
  const historyRef  = useRef<Msg[]>([])

  // Sync historyRef with msgs
  useEffect(() => { historyRef.current = msgs }, [msgs])

  // Scroll to bottom on new message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [msgs, loading])

  // Kick off AI greeting on mount
  useEffect(() => {
    sendToAI(isHe ? TRIGGER_HE : TRIGGER_EN, true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sendToAI = useCallback(async (text: string, isSystem = false) => {
    const userMsg: Msg = { role: 'user', content: text }
    const history = historyRef.current
    const newHistory: Msg[] = isSystem ? history : [...history, userMsg]
    if (!isSystem) setMsgs(newHistory)
    setLoading(true)

    const messagesPayload = isSystem
      ? [{ role: 'user' as const, content: text }]
      : newHistory.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: messagesPayload,
          profile, memory, events: [], tasks: [],
          isOnboarding: true,
        }),
      })
      if (!res.ok || !res.body) return

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer    = ''
      let aiContent = ''
      let started   = false

      while (true) {
        const { done: streamDone, value } = await reader.read()
        if (streamDone) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''

        for (const part of parts) {
          const line = part.trim()
          if (!line.startsWith('data: ')) continue
          try {
            const parsed = JSON.parse(line.slice(6))

            if (parsed.type === 'text') {
              aiContent += parsed.content
              if (!started) {
                started = true
                setMsgs(prev => {
                  const next = [...prev, { role: 'assistant' as const, content: aiContent }]
                  historyRef.current = next
                  return next
                })
              } else {
                setMsgs(prev => {
                  const next = prev.map((m, i) => i === prev.length - 1 ? { ...m, content: aiContent } : m)
                  historyRef.current = next
                  return next
                })
              }
            } else if (parsed.type === 'memory_updated') {
              // complete_onboarding was called — refetch profile
              fetch('/api/profile').then(r => r.ok ? r.json() : null).then((updated: UserProfile | null) => {
                if (updated?.scheduling_method) {
                  setDone(true)
                  setTimeout(() => onComplete(updated), 1800)
                }
              }).catch(() => {})
            }
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [profile, memory, onComplete])

  const handleSend = () => {
    if (!input.trim() || loading || done) return
    const text = input.trim()
    setInput('')
    sendToAI(text)
  }

  // ── Mic recording ────────────────────────────────────────────────────────
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : ''
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {})
      chunksRef.current = []
      recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      recorder.onstop = async () => {
        streamRef.current?.getTracks().forEach(t => t.stop())
        streamRef.current = null
        const blob = new Blob(chunksRef.current, { type: mimeType || 'audio/webm' })
        if (blob.size < 1000) { setRecState('idle'); return }
        setRecState('processing')
        try {
          const fd = new FormData()
          fd.append('audio', blob, mimeType?.includes('mp4') ? 'rec.m4a' : 'rec.webm')
          fd.append('lang', language ?? 'en')
          const res = await fetch('/api/transcribe', { method: 'POST', body: fd })
          const { text } = await res.json()
          if (text?.trim()) sendToAI(text.trim())
        } catch { /* ignore */ }
        finally { setRecState('idle') }
      }
      recorder.start(250)
      recorderRef.current = recorder
      setRecState('recording')
    } catch { setRecState('idle') }
  }

  const stopRecording = () => {
    recorderRef.current?.stop()
    recorderRef.current = null
  }

  const toggleMic = () => {
    if (recState === 'recording') stopRecording()
    else if (recState === 'idle') startRecording()
  }

  const visibleMsgs = msgs.filter((m, i) => !(i === 0 && m.role === 'user'))

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 60,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.78)', backdropFilter: 'blur(8px)',
      padding: 16,
    }}>
      <div style={{
        width: '100%', maxWidth: 440,
        height: 'min(580px, 88vh)',
        background: 'var(--bg-card)',
        border: '1px solid var(--border-hi)',
        borderRadius: 24,
        boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* Gradient bar */}
        <div style={{ height: 4, background: 'linear-gradient(90deg,#3B7EF7,#6366F1,#34D399)', flexShrink: 0 }} />

        {/* Header */}
        <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 12, flexShrink: 0,
            background: 'linear-gradient(135deg,#3B7EF7,#6366F1)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 900, fontSize: 18, color: '#fff',
            boxShadow: '0 4px 12px rgba(59,126,247,0.4)',
          }}>Z</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
              {isHe ? 'בואו נמצא את השיטה שמתאימה לך' : 'Let\'s find your perfect method'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>
              {done
                ? (isHe ? '✅ נמצא! סוגר...' : '✅ Found! Closing...')
                : (isHe ? 'ספר לי קצת עליך — דבר או כתוב' : 'Tell me about yourself — talk or type')}
            </div>
          </div>
          <button
            onClick={onSkip}
            style={{ background: 'var(--bg-input)', border: 'none', borderRadius: 8, width: 30, height: 30, cursor: 'pointer', color: 'var(--text-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
          >
            <X size={14} />
          </button>
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {visibleMsgs.length === 0 && !loading && (
            <div style={{ textAlign: 'center', color: 'var(--text-2)', fontSize: 13, marginTop: 24, opacity: 0.6 }}>
              {isHe ? '...מתחיל' : 'Starting...'}
            </div>
          )}
          {visibleMsgs.map((m, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
              <div style={{
                maxWidth: '88%',
                padding: '9px 13px',
                background: m.role === 'user' ? '#3B7EF7' : 'var(--bg-input)',
                color: m.role === 'user' ? '#fff' : 'var(--text)',
                borderRadius: m.role === 'user'
                  ? (isHe ? '14px 4px 14px 14px' : '14px 14px 4px 14px')
                  : (isHe ? '4px 14px 14px 14px' : '14px 4px 14px 14px'),
                fontSize: 13, lineHeight: 1.55,
                border: m.role === 'assistant' ? '1px solid var(--border)' : 'none',
                whiteSpace: 'pre-wrap',
              }}>
                {m.content}
              </div>
            </div>
          ))}
          {loading && (
            <div style={{ display: 'flex', gap: 4, padding: '9px 13px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: isHe ? '4px 14px 14px 14px' : '14px 4px 14px 14px', width: 'fit-content' }}>
              {[0, 1, 2].map(i => (
                <div key={i} className="typing-dot" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--text-2)', animationDelay: `${i * 0.18}s` }} />
              ))}
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input bar */}
        <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)', display: 'flex', gap: 7, alignItems: 'flex-end', flexShrink: 0 }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
            placeholder={isHe ? 'כתוב כאן...' : 'Type here...'}
            rows={1}
            disabled={done}
            dir={isHe ? 'rtl' : 'ltr'}
            style={{
              flex: 1, background: 'var(--bg-input)', border: '1px solid var(--border)',
              borderRadius: 12, padding: '8px 12px', resize: 'none',
              fontSize: 13, color: 'var(--text)', outline: 'none', fontFamily: 'inherit',
              lineHeight: 1.5, maxHeight: 80, overflow: 'auto', transition: 'border-color 0.15s',
            }}
            onFocus={e => (e.currentTarget.style.borderColor = '#3B7EF7')}
            onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
          />

          {/* Mic button — hidden while user is typing */}
          {!input.trim() && (
          <button
            onClick={toggleMic}
            disabled={done || recState === 'processing' || loading}
            title={isHe ? 'הקלטה קולית' : 'Voice input'}
            style={{
              width: 38, height: 38, borderRadius: 12, border: 'none', cursor: 'pointer', flexShrink: 0,
              background: recState === 'recording' ? '#EF4444' : recState === 'processing' ? '#6366F1' : 'var(--bg-input)',
              color: recState !== 'idle' ? '#fff' : 'var(--text-2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'all 0.2s',
              boxShadow: recState === 'recording' ? '0 0 14px rgba(239,68,68,0.55)' : 'none',
            }}
          >
            {recState === 'processing'
              ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
              : recState === 'recording'
              ? <MicOff size={16} />
              : <Mic size={16} />}
          </button>
          )}

          {/* Send button */}
          <button
            onClick={handleSend}
            disabled={!input.trim() || loading || done}
            style={{
              width: 38, height: 38, borderRadius: 12, border: 'none', cursor: 'pointer', flexShrink: 0,
              background: input.trim() && !loading && !done ? '#3B7EF7' : 'var(--bg-input)',
              color: input.trim() && !loading && !done ? '#fff' : 'var(--text-2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'all 0.15s',
            }}
          >
            <Send size={15} />
          </button>
        </div>
      </div>
    </div>
  )
}
