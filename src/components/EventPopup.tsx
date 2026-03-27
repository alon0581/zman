'use client'

import { useState, useEffect, useRef } from 'react'
import { CalendarEvent } from '@/types'
import { format, parseISO } from 'date-fns'
import { he as heLocale } from 'date-fns/locale'
import { X, Trash2, Check } from 'lucide-react'
import { classifyMobility, getMobilityReason } from '@/lib/scheduling/mobilityClassifier'

const COLORS = [
  { hex: '#3B7EF7', label: 'Work' },
  { hex: '#6366F1', label: 'Study' },
  { hex: '#34D399', label: 'Fitness' },
  { hex: '#FBBF24', label: 'Personal' },
  { hex: '#F97316', label: 'Social' },
  { hex: '#F87171', label: 'Other' },
]

interface Props {
  event: CalendarEvent
  x: number
  y: number
  language?: string
  onClose: () => void
  onSave: (id: string, changes: Partial<CalendarEvent>) => void
  onDelete: (id: string) => void
}

export default function EventPopup({ event, x, y, language = 'en', onClose, onSave, onDelete }: Props) {
  const isHe = language === 'he'
  const [title, setTitle] = useState(event.title)
  const [color, setColor] = useState(event.color ?? '#3B7EF7')
  const autoMobility = event.mobility_type ?? classifyMobility(event.title, event.created_by, true)
  const [mobility, setMobility] = useState<'fixed' | 'flexible' | 'ask_first'>(autoMobility)
  const [mobilityManual, setMobilityManual] = useState(!!event.mobility_type)
  const [saving, setSaving] = useState(false)
  const popupRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  // Adjust to stay within viewport
  useEffect(() => {
    if (!popupRef.current) return
    const rect = popupRef.current.getBoundingClientRect()
    let nx = x, ny = y
    if (nx + rect.width > window.innerWidth - 16) nx = window.innerWidth - rect.width - 16
    if (ny + rect.height > window.innerHeight - 16) ny = window.innerHeight - rect.height - 16
    if (nx < 16) nx = 16
    if (ny < 16) ny = 16
    setPos({ x: nx, y: ny })
  }, [x, y])

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) onClose()
    }
    setTimeout(() => document.addEventListener('mousedown', handler), 0)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const handleSave = async () => {
    if (!title.trim()) return
    setSaving(true)
    try {
      await fetch(`/api/events/${event.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), color, mobility_type: mobility }),
      })
      onSave(event.id, { title: title.trim(), color, mobility_type: mobility })
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    try {
      await fetch(`/api/events/${event.id}`, { method: 'DELETE' })
      onDelete(event.id)
      onClose()
    } catch { /* ignore */ }
  }

  const dfLocale = isHe ? heLocale : undefined
  const startDate = isHe
    ? format(parseISO(event.start_time), "EEEE, d בMMMM", { locale: dfLocale })
    : format(parseISO(event.start_time), 'EEE, MMM d')
  const startTime = format(parseISO(event.start_time), 'HH:mm')
  const endTime   = format(parseISO(event.end_time),   'HH:mm')

  return (
    <div
      ref={popupRef}
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        zIndex: 1000,
        width: 268,
        background: 'var(--bg-card)',
        border: '1px solid var(--border-hi)',
        borderRadius: 18,
        boxShadow: 'var(--shadow-xl), 0 0 0 1px rgba(255,255,255,0.06)',
        overflow: 'hidden',
        animation: 'popupIn var(--t-spring)',
      }}
    >
      {/* Color accent bar */}
      <div style={{ height: 4, background: color, transition: 'background 0.2s' }} />

      <div style={{ padding: '14px 16px 18px' }}>
        {/* Title row */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
            autoFocus
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none',
              color: 'var(--text)', fontSize: 14, fontWeight: 700, fontFamily: 'inherit',
              lineHeight: 1.4, padding: 0,
            }}
          />
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-2)', padding: 2, borderRadius: 6,
              display: 'flex', flexShrink: 0,
            }}
          >
            <X size={14} />
          </button>
        </div>

        {/* Time */}
        <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 16, letterSpacing: '0.01em' }}>
          {startDate} · {startTime} – {endTime}
        </div>

        {/* Color swatches */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
          {COLORS.map(c => (
            <button
              key={c.hex}
              title={c.label}
              onClick={() => setColor(c.hex)}
              style={{
                width: 22, height: 22, borderRadius: '50%', cursor: 'pointer',
                background: c.hex,
                border: color === c.hex ? '2px solid rgba(255,255,255,0.9)' : '2px solid transparent',
                boxShadow: color === c.hex ? `0 0 0 2px ${c.hex}, 0 0 0 4px rgba(255,255,255,0.12)` : 'none',
                transform: color === c.hex ? 'scale(1.22)' : 'scale(1)',
                transition: 'transform var(--t-fast), box-shadow var(--t-fast)',
              }}
            />
          ))}
        </div>

        {/* Mobility selector */}
        <div style={{ fontSize: 10, color: 'var(--text-2)', marginBottom: 6, opacity: 0.75 }}>
          {getMobilityReason(event.title, mobility, event.created_by ?? 'user', isHe)}
          {mobilityManual && <span style={{ marginLeft: 4, opacity: 0.6 }}>{isHe ? '(ידני)' : '(manual)'}</span>}
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
          {([
            { key: 'fixed' as const, emoji: '🔒', label: isHe ? 'קבוע' : 'Fixed' },
            { key: 'flexible' as const, emoji: '🟡', label: isHe ? 'גמיש' : 'Flexible' },
            { key: 'ask_first' as const, emoji: '🔵', label: isHe ? 'שאל' : 'Ask' },
          ]).map(m => (
            <button
              key={m.key}
              onClick={() => { setMobility(m.key); setMobilityManual(true) }}
              style={{
                flex: 1, padding: '5px 4px', borderRadius: 8,
                border: mobility === m.key ? '1.5px solid #3B7EF7' : '1px solid var(--border)',
                background: mobility === m.key ? 'rgba(59,126,247,0.1)' : 'var(--bg-input)',
                cursor: 'pointer', fontSize: 10, fontWeight: 600,
                color: 'var(--text)', display: 'flex', flexDirection: 'column',
                alignItems: 'center', gap: 2, transition: 'all 0.15s',
              }}
            >
              <span style={{ fontSize: 12 }}>{m.emoji}</span>
              <span>{m.label}</span>
            </button>
          ))}
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={handleDelete}
            style={{
              padding: '8px 12px', borderRadius: 'var(--radius-md)',
              border: '1px solid rgba(248,113,113,0.28)',
              background: 'rgba(248,113,113,0.08)', color: 'var(--red)',
              cursor: 'pointer', fontSize: 12, fontWeight: 600,
              display: 'flex', alignItems: 'center', gap: 5,
              transition: 'background var(--t-fast)',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(248,113,113,0.16)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'rgba(248,113,113,0.08)')}
          >
            <Trash2 size={12} /> {isHe ? 'מחק' : 'Delete'}
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !title.trim()}
            className="btn-primary"
            style={{
              flex: 1, padding: '8px 12px', borderRadius: 'var(--radius-md)',
              fontSize: 12, fontWeight: 600,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
            }}
          >
            <Check size={12} /> {isHe ? 'שמור' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
