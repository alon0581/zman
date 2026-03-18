'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CalendarEvent } from '@/types'
import { format, isSameDay } from 'date-fns'
import { he as heLocale } from 'date-fns/locale'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import EventPopup from './EventPopup'

interface Props {
  events: CalendarEvent[]
  newEventIds: Set<string>
  language?: string
  isMobile?: boolean
  onEventUpdate: (id: string, changes: Partial<CalendarEvent>) => void
  onEventDelete: (id: string) => void
}

type ViewType = 'dayGridMonth' | 'timeGridWeek' | 'timeGridDay' | 'timeGrid3Day'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FCType = React.ComponentType<any>

const VIEW_ORDER_DESKTOP: ViewType[] = ['timeGridDay', 'timeGrid3Day', 'timeGridWeek', 'dayGridMonth']
const VIEW_ORDER_MOBILE: ViewType[]  = ['timeGridDay', 'timeGrid3Day', 'dayGridMonth']

const LABELS: Record<string, Record<ViewType, string>> = {
  en: { timeGridDay: 'Day', timeGrid3Day: '3 Days', timeGridWeek: 'Week', dayGridMonth: 'Month' },
  he: { timeGridDay: 'יום', timeGrid3Day: '3 ימים', timeGridWeek: 'שבוע', dayGridMonth: 'חודש' },
}

const SUBTITLES: Record<string, Record<ViewType, string>> = {
  en: { timeGridDay: 'Daily View', timeGrid3Day: '3-Day View', timeGridWeek: 'Weekly Overview', dayGridMonth: 'Monthly View' },
  he: { timeGridDay: 'תצוגה יומית', timeGrid3Day: 'תצוגה 3 ימים', timeGridWeek: 'סקירה שבועית', dayGridMonth: 'תצוגה חודשית' },
}

interface PopupState {
  event: CalendarEvent
  x: number
  y: number
}

export default function CalendarPanel({
  events, newEventIds, language = 'en', isMobile = false,
  onEventUpdate, onEventDelete,
}: Props) {
  // Mobile defaults to day view (better event readability), desktop to week
  const [view, setView] = useState<ViewType>(isMobile ? 'timeGridDay' : 'timeGridWeek')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [plugins, setPlugins] = useState<any[]>([])
  const [FC, setFC] = useState<FCType | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [localeData, setLocaleData] = useState<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const calRef = useRef<any>(null)
  const [currentDate, setCurrentDate] = useState(new Date())
  const [popup, setPopup] = useState<PopupState | null>(null)
  // Apple-style day sheet for month view on mobile
  const [selectedDate, setSelectedDate] = useState<Date | null>(null)

  // Auto-switch away from week view when on mobile (week is desktop-only)
  useEffect(() => {
    if (isMobile && view === 'timeGridWeek') setView('timeGridDay')
  }, [isMobile, view])

  // Pinch-to-zoom: adjust slot height like Apple Calendar
  const DEFAULT_SLOT_H = isMobile ? 44 : 30
  const [slotHeight, setSlotHeight] = useState(DEFAULT_SLOT_H)
  const slotHeightRef = useRef(DEFAULT_SLOT_H)
  const containerRef = useRef<HTMLDivElement>(null)

  const updateSlotHeight = useCallback((h: number) => {
    slotHeightRef.current = h
    setSlotHeight(h)
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el || !isMobile) return

    const pinch = { active: false, startDist: 0, startHeight: DEFAULT_SLOT_H }

    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault() // block browser pinch-zoom before it starts
        const dx = e.touches[0].clientX - e.touches[1].clientX
        const dy = e.touches[0].clientY - e.touches[1].clientY
        pinch.startDist = Math.hypot(dx, dy)
        pinch.startHeight = slotHeightRef.current
        pinch.active = true
      }
    }

    const onMove = (e: TouchEvent) => {
      if (!pinch.active || e.touches.length !== 2) return
      e.preventDefault()
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      const ratio = Math.hypot(dx, dy) / pinch.startDist
      const newH = Math.max(20, Math.min(120, Math.round(pinch.startHeight * ratio)))
      updateSlotHeight(newH)
    }

    const onEnd = () => { pinch.active = false }

    el.addEventListener('touchstart', onStart, { passive: false })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd, { passive: true })
    el.addEventListener('touchcancel', onEnd, { passive: true })

    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
  }, [isMobile, updateSlotHeight, DEFAULT_SLOT_H])

  useEffect(() => {
    const imports: Promise<unknown>[] = [
      import('@fullcalendar/react'),
      import('@fullcalendar/daygrid'),
      import('@fullcalendar/timegrid'),
      import('@fullcalendar/interaction'),
    ]
    if (language === 'he') imports.push(import('@fullcalendar/core/locales/he'))

    Promise.all(imports).then(([fc, dg, tg, ia, heLoc]) => {
      setFC(() => (fc as { default: FCType }).default)
      setPlugins([
        (dg as { default: unknown }).default,
        (tg as { default: unknown }).default,
        (ia as { default: unknown }).default,
      ])
      if (heLoc) setLocaleData((heLoc as { default: unknown }).default)
    })
  }, [language])

  // Change FullCalendar view via API (avoids full remount on view switch)
  const prevViewRef = useRef(view)
  useEffect(() => {
    if (prevViewRef.current !== view) {
      calRef.current?.getApi().changeView(view)
      prevViewRef.current = view
    }
    setSelectedDate(null) // close day sheet on view change
  }, [view])

  // Close day sheet when navigating months
  useEffect(() => { setSelectedDate(null) }, [currentDate])

  const goPrev = () => calRef.current?.getApi().prev()
  const goNext = () => calRef.current?.getApi().next()

  const fcEvents = events.map(ev => ({
    id: ev.id,
    title: ev.title,
    start: ev.start_time,
    end: ev.end_time,
    backgroundColor: ev.color ?? '#3B7EF7',
    borderColor: 'transparent',
    classNames: [
      ev.status === 'proposed' ? 'ai-proposed' : '',
      newEventIds.has(ev.id) ? 'ai-new' : '',
    ].filter(Boolean),
  }))

  const eventMap = useMemo(() => new Map(events.map(e => [e.id, e])), [events])

  const handleDateClick = (info: { date: Date }) => {
    if (isMobile && view === 'dayGridMonth') {
      setSelectedDate(info.date)
    }
  }

  const handleEventClick = (info: { event: { id: string }; jsEvent: MouseEvent }) => {
    const ev = eventMap.get(info.event.id)
    if (!ev) return
    info.jsEvent.stopPropagation()
    // On mobile: center popup on screen; on desktop: near cursor
    const x = isMobile ? window.innerWidth / 2 - 140 : info.jsEvent.clientX + 12
    const y = isMobile ? window.innerHeight / 2 - 120 : info.jsEvent.clientY - 40
    setPopup({ event: ev, x, y })
  }

  const labels = LABELS[language] ?? LABELS.en
  const subs   = SUBTITLES[language] ?? SUBTITLES.en

  // Hebrew month/date formatting using date-fns locale
  const dfLocale  = language === 'he' ? heLocale : undefined
  const monthTitle = format(currentDate, 'MMMM yyyy', { locale: dfLocale })

  if (!FC || plugins.length === 0) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, color: '#86868B' }}>
        <div style={{ fontSize: 36 }}>📅</div>
        <div style={{ fontSize: 13 }}>{language === 'he' ? 'טוען לוח שנה…' : 'Loading calendar…'}</div>
      </div>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'transparent' }}>

      {/* Custom header — always LTR so layout is consistent */}
      <div style={{ padding: isMobile ? '14px 16px 0' : '22px 28px 0', flexShrink: 0, direction: 'ltr' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>

          {/* ← Date title → */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            {/* Prev: always ← = back in time */}
            <button
              onClick={goPrev}
              style={{
                width: 32, height: 32, borderRadius: 8, border: '1px solid var(--border-hi)',
                background: 'var(--bg-card)', color: 'var(--text-2)', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                transition: 'background 0.15s, color 0.15s',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--border-hi)'; (e.currentTarget as HTMLElement).style.color = 'var(--text)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-card)'; (e.currentTarget as HTMLElement).style.color = 'var(--text-2)' }}
            >
              <ChevronLeft size={16} />
            </button>

            <div style={{ minWidth: 0 }}>
              <div style={{
                fontSize: isMobile ? 20 : 26, fontWeight: 800,
                letterSpacing: '-0.03em', color: 'var(--text)', lineHeight: 1,
                whiteSpace: 'nowrap',
                // Hebrew text direction for the month name
                direction: language === 'he' ? 'rtl' : 'ltr',
              }}>
                {monthTitle}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 3, fontWeight: 400, letterSpacing: '-0.01em' }}>
                {subs[view] ?? subs.timeGridWeek}
              </div>
            </div>

            {/* Next: always → = forward in time */}
            <button
              onClick={goNext}
              style={{
                width: 32, height: 32, borderRadius: 8, border: '1px solid var(--border-hi)',
                background: 'var(--bg-card)', color: 'var(--text-2)', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                transition: 'background 0.15s, color 0.15s',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--border-hi)'; (e.currentTarget as HTMLElement).style.color = 'var(--text)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-card)'; (e.currentTarget as HTMLElement).style.color = 'var(--text-2)' }}
            >
              <ChevronRight size={16} />
            </button>
          </div>

          {/* View switcher — week tab only on desktop */}
          <div style={{
            display: 'flex', background: 'var(--bg-card)',
            borderRadius: 10, padding: 3, border: '1px solid var(--border)', gap: 2, flexShrink: 0,
          }}>
            {(isMobile ? VIEW_ORDER_MOBILE : VIEW_ORDER_DESKTOP).map(v => (
              <button key={v} onClick={() => setView(v)}
                style={{
                  padding: isMobile ? '5px 8px' : '5px 12px',
                  borderRadius: 8, border: 'none', cursor: 'pointer',
                  fontSize: isMobile ? 11 : 12, fontWeight: 600,
                  background: view === v ? 'linear-gradient(135deg,#3B7EF7,#6366F1)' : 'transparent',
                  color: view === v ? '#fff' : 'var(--text-2)',
                  boxShadow: view === v ? 'var(--blue-glow)' : 'none',
                  transition: 'all var(--t-base)',
                  whiteSpace: 'nowrap',
                }}>
                {labels[v] ?? v}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Calendar — pinch gesture target */}
      <div
        ref={containerRef}
        style={{
          flex: 1, overflow: 'hidden', padding: isMobile ? '6px 8px 8px' : '8px 16px 12px',
          '--fc-slot-height': `${slotHeight}px`,
          touchAction: isMobile ? 'pan-y' : undefined, // allow scroll; block browser pinch-zoom so our handler runs
        } as React.CSSProperties}
      >
        <FC
          ref={calRef}
          plugins={plugins}
          initialView={view}
          key={language}               /* remount only on language change, not view change */
          events={fcEvents}
          locale={language === 'he' && localeData ? localeData : language}
          direction="ltr"              /* always LTR so prev()=older / next()=newer regardless of locale */
          headerToolbar={false}        /* we use our own prev/next buttons above */
          height="100%"
          nowIndicator
          allDaySlot={false}
          slotMinTime="06:00:00"
          slotMaxTime="23:00:00"
          slotDuration="00:30:00"
          slotLabelInterval="01:00:00"
          eventMinHeight={isMobile ? Math.max(24, Math.round(slotHeight * 0.55)) : 20}
          eventTimeFormat={{ hour: 'numeric', minute: '2-digit', meridiem: false }}
          dayHeaderFormat={{ weekday: 'short', day: 'numeric' }}
          datesSet={(info: { view: { currentStart: Date } }) => setCurrentDate(info.view.currentStart)}
          eventClick={handleEventClick}
          dateClick={handleDateClick}
          views={{
            /* 3-day custom view */
            timeGrid3Day: {
              type: 'timeGrid',
              duration: { days: 3 },
            },
            /* Month view: dots on mobile (Apple Calendar style), bars on desktop */
            dayGridMonth: {
              dayMaxEvents: isMobile ? 3 : 4,
              ...(isMobile ? { eventDisplay: 'list-item' } : {}),
            },
          }}
        />
      </div>

      {/* Event popup */}
      {popup && (
        <EventPopup
          event={popup.event}
          x={popup.x}
          y={popup.y}
          onClose={() => setPopup(null)}
          onSave={(id, changes) => { onEventUpdate(id, changes); setPopup(null) }}
          onDelete={(id) => { onEventDelete(id); setPopup(null) }}
        />
      )}

      {/* Apple-style day sheet — month view mobile */}
      {selectedDate && isMobile && view === 'dayGridMonth' && (
        <DaySheet
          date={selectedDate}
          events={events.filter(ev => isSameDay(new Date(ev.start_time), selectedDate))}
          language={language}
          onClose={() => setSelectedDate(null)}
          onEventClick={(ev) => {
            setSelectedDate(null)
            setPopup({ event: ev, x: window.innerWidth / 2 - 140, y: window.innerHeight / 2 - 120 })
          }}
        />
      )}
    </div>
  )
}

// ── Apple-style Day Events Sheet ─────────────────────────────────────────────
function DaySheet({ date, events, language, onClose, onEventClick }: {
  date: Date
  events: CalendarEvent[]
  language: string
  onClose: () => void
  onEventClick: (ev: CalendarEvent) => void
}) {
  const isHe = language === 'he'
  const dfLocale = isHe ? heLocale : undefined
  const dayLabel = format(date, isHe ? 'EEEE, d בMMMM' : 'EEEE, MMMM d', { locale: dfLocale })
  const sorted = [...events].sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(0,0,0,0.4)' }}
      />
      {/* Sheet — floats above the mobile bottom tab bar */}
      <div style={{
        position: 'fixed',
        bottom: 'calc(56px + env(safe-area-inset-bottom, 0px))',
        left: 8, right: 8, zIndex: 50,
        background: 'var(--bg-panel)',
        borderRadius: 22,
        boxShadow: '0 -4px 48px rgba(0,0,0,0.6)',
        maxHeight: '60vh',
        display: 'flex', flexDirection: 'column',
        animation: 'slideUp 0.28s cubic-bezier(0.32,0.72,0,1)',
      }}>
        {/* Handle */}
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 10, flexShrink: 0 }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border-hi)' }} />
        </div>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 20px 12px', flexShrink: 0,
          borderBottom: '1px solid var(--border)',
        }}>
          <span style={{ fontWeight: 800, fontSize: 16, color: 'var(--text)', direction: isHe ? 'rtl' : 'ltr' }}>
            {dayLabel}
          </span>
          <button
            onClick={onClose}
            style={{
              background: 'var(--bg-input)', border: 'none', cursor: 'pointer',
              color: 'var(--text-2)', borderRadius: '50%',
              width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <X size={14} />
          </button>
        </div>
        {/* Events list */}
        <div style={{ overflowY: 'auto', padding: '10px 16px 18px', flex: 1 }}>
          {sorted.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-2)', fontSize: 14, padding: '28px 0' }}>
              {isHe ? 'אין אירועים ביום זה' : 'No events this day'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {sorted.map(ev => (
                <button
                  key={ev.id}
                  onClick={() => onEventClick(ev)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 14,
                    background: 'var(--bg-card)', border: '1px solid var(--border)',
                    borderRadius: 14, padding: '13px 16px', cursor: 'pointer',
                    textAlign: isHe ? 'right' : 'left', width: '100%',
                    direction: isHe ? 'rtl' : 'ltr',
                  }}
                >
                  <div style={{
                    width: 12, height: 12, borderRadius: '50%', flexShrink: 0,
                    background: ev.color ?? '#3B7EF7',
                    boxShadow: `0 0 8px ${ev.color ?? '#3B7EF7'}66`,
                  }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)', lineHeight: 1.3 }}>
                      {ev.title}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 3 }}>
                      {format(new Date(ev.start_time), 'HH:mm')} – {format(new Date(ev.end_time), 'HH:mm')}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
