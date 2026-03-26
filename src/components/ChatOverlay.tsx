'use client'

import { useRef, useEffect } from 'react'
import { motion } from 'motion/react'
import { Send, X, RotateCcw } from 'lucide-react'
import type { Message } from '@/types'

interface Props {
  messages: Message[]
  input: string
  setInput: (v: string) => void
  loading: boolean
  streamingId: string | null
  isOnboarding: boolean
  language: string
  isMobile: boolean
  onSend: (text: string) => void
  onClose: () => void
  onReset: () => void
}

const T = {
  en: { header: 'AI Assistant', placeholder: 'Type a message…', online: 'Online', subtitle: 'Talk or type to manage your schedule' },
  he: { header: 'עוזר AI', placeholder: 'כתוב הודעה…', online: 'פעיל', subtitle: 'דבר או כתוב כדי לנהל את הלוח זמנים שלך' },
} as const

export default function ChatOverlay({ messages, input, setInput, loading, streamingId, isOnboarding, language, isMobile, onSend, onClose, onReset }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const lang = (language === 'he' ? 'he' : 'en') as keyof typeof T
  const isRTL = language === 'he' || language === 'ar'
  const t = T[lang]
  // Guard: ignore backdrop clicks for the first 250ms after mount.
  // Prevents residual click events from a double-tap on the FAB from
  // immediately closing the overlay that was just opened by that same tap.
  const mountTimeRef = useRef(Date.now())

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  return (
    <>
      {/* Backdrop — closes overlay, but ignores stray events in the first 250ms */}
      <motion.div
        onClick={() => { if (Date.now() - mountTimeRef.current > 250) onClose() }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        style={{
          position: 'fixed', inset: 0, zIndex: 9991,
          background: 'rgba(0,0,0,0.5)',
        }}
      />

      {/* Panel */}
      <motion.div
        dir={isRTL ? 'rtl' : 'ltr'}
        className="chat-panel-glass"
        initial={isMobile ? { y: '100%' } : { x: isRTL ? -420 : 420 }}
        animate={isMobile ? { y: 0 } : { x: 0 }}
        exit={isMobile ? { y: '100%' } : { x: isRTL ? -420 : 420 }}
        transition={{ type: 'spring', stiffness: 280, damping: 30 }}
        style={{
          position: 'fixed',
          zIndex: 9992,
          display: 'flex',
          flexDirection: 'column',
          ...(isMobile ? {
            bottom: 0, left: 0, right: 0,
            height: '85vh',
            borderRadius: '24px 24px 0 0',
            boxShadow: '0 -12px 40px rgba(0,0,0,0.4)',
          } : {
            top: 60, [isRTL ? 'left' : 'right']: 0,
            width: 420, bottom: 0,
            boxShadow: '-12px 0 40px rgba(0,0,0,0.4)',
          }),
        }}
      >
        {/* Drag handle (mobile) */}
        {isMobile && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 4px', flexShrink: 0 }}>
            <div style={{ width: 36, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.2)' }} />
          </div>
        )}

        {/* Header */}
        <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>{t.header}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
              {!isOnboarding && <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', animation: 'pulseOnline 2.5s ease-in-out infinite' }} />}
              <div style={{ fontSize: 11, color: 'var(--text-2)' }}>{t.subtitle}</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {messages.filter(m => m.role === 'user').length >= 1 && (
              <button onClick={onReset} title={lang === 'he' ? 'שיחה חדשה' : 'New chat'}
                style={{ width: 30, height: 30, borderRadius: 8, border: '1px solid var(--border-hi)', background: 'transparent', color: 'var(--text-2)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <RotateCcw size={13} />
              </button>
            )}
            <button onClick={onClose}
              style={{ width: 30, height: 30, borderRadius: 8, border: '1px solid var(--border-hi)', background: 'transparent', color: 'var(--text-2)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {messages.map(msg => <Bubble key={msg.id} msg={msg} isRTL={isRTL} isStreaming={msg.id === streamingId} />)}
          {loading && !streamingId && <TypingBubble />}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div style={{ flexShrink: 0, padding: '10px 16px 16px', borderTop: '1px solid var(--border)', paddingBottom: isMobile ? 'calc(16px + env(safe-area-inset-bottom, 0px))' : 16 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(input) } }}
              placeholder={t.placeholder}
              disabled={loading}
              dir={isRTL ? 'rtl' : 'ltr'}
              style={{
                flex: 1, padding: '11px 16px', borderRadius: 14, outline: 'none', fontFamily: 'inherit',
                border: '1px solid var(--border-hi)', background: 'var(--bg-input)', color: 'var(--text)',
                fontSize: 16, opacity: loading ? 0.5 : 1,
              }}
            />
            {input.trim() && (
              <button
                onClick={() => onSend(input)}
                disabled={loading}
                style={{
                  width: 42, height: 42, borderRadius: 13, border: 'none', cursor: 'pointer', flexShrink: 0,
                  background: 'linear-gradient(135deg,#3B7EF7,#6366F1)', color: '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxShadow: '0 4px 14px rgba(59,126,247,0.4)',
                  opacity: loading ? 0.4 : 1,
                }}
              >
                <Send size={14} />
              </button>
            )}
          </div>
        </div>
      </motion.div>
    </>
  )
}

// ─── Markdown renderer ──────────────────────────────────────────
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
    if (/^[\-\*•]\s+/.test(line)) {
      nodes.push(<div key={i} style={{ display: 'flex', gap: 7, marginTop: nodes.length ? 3 : 0 }}><span style={{ opacity: 0.6, flexShrink: 0, lineHeight: 1.55 }}>•</span><span>{renderInline(line.replace(/^[\-\*•]\s+/, ''))}</span></div>)
    } else if (line === '') {
      if (nodes.length > 0 && i < lines.length - 1) nodes.push(<div key={i} style={{ height: 5 }} />)
    } else {
      nodes.push(<div key={i} style={{ marginTop: nodes.length && lines[i - 1] !== '' ? 3 : 0 }}>{renderInline(line)}</div>)
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
        <div style={{ width: 28, height: 28, borderRadius: 9, background: 'linear-gradient(135deg,#3B7EF7,#6366F1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 900, color: '#fff', flexShrink: 0, boxShadow: '0 2px 10px rgba(59,126,247,0.35)' }}>Z</div>
      )}
      <div style={{
        maxWidth: '78%', padding: '10px 14px', borderRadius: isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
        background: isUser ? 'linear-gradient(135deg,#3B7EF7,#6366F1)' : 'rgba(22,22,38,0.88)',
        backdropFilter: isUser ? undefined : 'blur(12px)',
        WebkitBackdropFilter: isUser ? undefined : 'blur(12px)',
        color: isUser ? '#fff' : 'var(--text)',
        border: isUser ? 'none' : '1px solid rgba(255,255,255,0.09)',
        fontSize: 13.5, lineHeight: 1.5, direction: isRTL ? 'rtl' : 'ltr',
        boxShadow: isUser ? '0 4px 20px rgba(59,126,247,0.45)' : '0 2px 12px rgba(0,0,0,0.3)',
      }}>
        {renderMarkdown(msg.content, isUser)}
        {isStreaming && <span style={{ display: 'inline-block', width: 7, height: 13, background: 'var(--blue)', borderRadius: 2, marginLeft: 3, verticalAlign: 'middle', animation: 'blink 0.8s step-end infinite' }} />}
      </div>
    </div>
  )
}

function TypingBubble() {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
      <div style={{ width: 28, height: 28, borderRadius: 9, background: 'linear-gradient(135deg,#3B7EF7,#6366F1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 900, color: '#fff', flexShrink: 0 }}>Z</div>
      <div style={{ padding: '11px 15px', borderRadius: '16px 16px 16px 4px', background: 'rgba(22,22,38,0.88)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.09)', display: 'flex', gap: 5, alignItems: 'center' }}>
        <div className="typing-dot" style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--blue)' }} />
        <div className="typing-dot" style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--blue)' }} />
        <div className="typing-dot" style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--blue)' }} />
      </div>
    </div>
  )
}
