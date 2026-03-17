'use client'

import { useState, useEffect, useRef } from 'react'
import { CalendarEvent } from '@/types'
import { format, parseISO } from 'date-fns'
import { X, Trash2, Check } from 'lucide-react'

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
  onClose: () => void
  onSave: (id: string, changes: Partial<CalendarEvent>) => void
  onDelete: (id: string) => void
}

export default function EventPopup({ event, x, y, onClose, onSave, onDelete }: Props) {
  const [title, setTitle] = useState(event.title)
  const [color, setColor] = useState(event.color ?? '#3B7EF7')
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
        body: JSON.stringify({ title: title.trim(), color }),
      })
      onSave(event.id, { title: title.trim(), color })
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

  const startDate = format(parseISO(event.start_time), 'EEE, MMM d')
  const startTime = format(parseISO(event.start_time), 'h:mm a')
  const endTime   = format(parseISO(event.end_time),   'h:mm a')

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
        borderRadius: 16,
        boxShadow: '0 24px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.05)',
        overflow: 'hidden',
        animation: 'popupIn 0.15s cubic-bezier(0.34,1.56,0.64,1)',
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
                border: color === c.hex ? '2px solid white' : '2px solid transparent',
                boxShadow: color === c.hex ? `0 0 0 2px ${c.hex}` : 'none',
                transform: color === c.hex ? 'scale(1.2)' : 'scale(1)',
                transition: 'transform 0.12s, box-shadow 0.12s',
              }}
            />
          ))}
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={handleDelete}
            style={{
              padding: '8px 12px', borderRadius: 10,
              border: '1px solid rgba(248,113,113,0.3)',
              background: 'rgba(248,113,113,0.08)', color: '#F87171',
              cursor: 'pointer', fontSize: 12, fontWeight: 600,
              display: 'flex', alignItems: 'center', gap: 5,
              transition: 'background 0.15s',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(248,113,113,0.18)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'rgba(248,113,113,0.08)')}
          >
            <Trash2 size={12} /> Delete
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !title.trim()}
            style={{
              flex: 1, padding: '8px 12px', borderRadius: 10, border: 'none',
              background: 'linear-gradient(135deg,#3B7EF7,#6366F1)', color: '#fff',
              cursor: 'pointer', fontSize: 12, fontWeight: 600,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
              opacity: saving || !title.trim() ? 0.5 : 1,
              transition: 'opacity 0.15s',
            }}
          >
            <Check size={12} /> Save
          </button>
        </div>
      </div>
    </div>
  )
}
