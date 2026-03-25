'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CalendarEvent } from '@/types'
import { format, isSameDay, endOfDay } from 'date-fns'
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
  const DEFAULT_SLOT_H = isMobile ? 44 : 44
  const [slotHeight, setSlotHeight] = useState(DEFAULT_SLOT_H)
  const slotHeightRef = useRef(DEFAULT_SLOT_H)
  const containerRef = useRef<HTMLDivElement>(null)

  const updateSlotHeight = useCallback((h: number) => {
    slotHeightRef.current = h
    setSlotHeight(h)
  }, [])

  const goPrev = useCallback(() => calRef.current?.getApi().prev(), [])
  const goNext = useCallback(() => calRef.current?.getApi().next(), [])

  useEffect(() => {
    const el = containerRef.current
    if (!el || !isMobile) return

    const pinch = { active: false, startDist: 0, startHeight: DEFAULT_SLOT_H }
    const swipe = { startX: 0, startY: 0 }

    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault()
        const dx = e.touches[0].clientX - e.touches[1].clientX
        const dy = e.touches[0].clientY - e.touches[1].clientY
        pinch.startDist = Math.hypot(dx, dy)
        pinch.startHeight = slotHeightRef.current
        pinch.active = true
      } else if (e.touches.length === 1) {
        swipe.startX = e.touches[0].clientX
        swipe.startY = e.touches[0].clientY
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

    const onEnd = (e: TouchEvent) => {
      if (pinch.active) { pinch.active = false; return }
      if (e.changedTouches.length === 1) {
        const dx = e.changedTouches[0].clientX - swipe.startX
        const dy = e.changedTouches[0].clientY - swipe.startY
        // Horizontal swipe: must dominate vertical movement
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.8) {
          if (language === 'he') { dx > 0 ? goNext() : goPrev() }
          else                   { dx > 0 ? goPrev() : goNext() }
        }
      }
    }

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
  }, [isMobile, updateSlotHeight, DEFAULT_SLOT_H, language, goPrev, goNext])

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

  const scrollTime = useMemo(() => {
    const now = new Date()
    const todayEnd = endOfDay(now)
    // Ongoing event → scroll to its start
    const ongoing = events.find(e => new Date(e.start_time) <= now && new Date(e.end_time) >= now)
    if (ongoing) {
      const h = Math.max(0, new Date(ongoing.start_time).getHours() - 4)
      return `${String(h).padStart(2, '0')}:00:00`
    }
    // Next upcoming event today → scroll 4h before to center it
    const upcoming = events
      .filter(e => new Date(e.start_time) > now && new Date(e.start_time) <= todayEnd)
      .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())[0]
    if (upcoming) {
      const h = Math.max(0, new Date(upcoming.start_time).getHours() - 4)
      return `${String(h).padStart(2, '0')}:00:00`
    }
    // Default: current time minus 4 hours to center current time
    const h = Math.max(0, now.getHours() - 4)
    return `${String(h).padStart(2, '0')}:00:00`
  }, [events])

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
            {/* Prev: only on desktop — mobile uses swipe */}
            {!isMobile && (
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
            )}

            <div style={{ minWidth: 0 }}>
              <div style={{
                fontSize: isMobile ? 20 : 26, fontWeight: 800,
                letterSpacing: '-0.03em', color: 'var(--text)', lineHeight: 1,
                whiteSpace: 'nowrap',
                direction: language === 'he' ? 'rtl' : 'ltr',
              }}>
                {monthTitle}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 3, fontWeight: 400, letterSpacing: '-0.01em' }}>
                {subs[view] ?? subs.timeGridWeek}
              </div>
            </div>

            {/* Next: only on desktop — mobile uses swipe */}
            {!isMobile && (
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
            )}

            {/* Today button — mobile only */}
            {isMobile && (
              <button
                onClick={() => calRef.current?.getApi().today()}
                style={{
                  padding: '4px 10px', borderRadius: 7, border: '1px solid var(--border-hi)',
                  background: 'var(--bg-card)', color: 'var(--text-2)', cursor: 'pointer',
                  fontSize: 11, fontWeight: 600, flexShrink: 0,
                }}
              >
                {language === 'he' ? 'היום' : 'Today'}
              </button>
            )}
          </div>

          {/* View switcher — iOS segmented control style on mobile, web style on desktop */}
          <div style={{
            display: 'flex',
            background: isMobile ? 'rgba(118,118,128,0.18)' : 'var(--bg-card)',
            borderRadius: isMobile ? 9 : 10,
            padding: isMobile ? 2 : 3,
            border: isMobile ? 'none' : '1px solid var(--border)',
            gap: isMobile ? 1 : 2,
            flexShrink: 0,
          }}>
            {(isMobile ? VIEW_ORDER_MOBILE : VIEW_ORDER_DESKTOP).map(v => (
              <button key={v} onClick={() => setView(v)}
                style={{
                  padding: isMobile ? '5px 14px' : '5px 12px',
                  borderRadius: isMobile ? 7 : 8,
                  border: 'none', cursor: 'pointer',
                  fontSize: isMobile ? 13 : 12, fontWeight: 600,
                  background: view === v
                    ? (isMobile ? 'var(--bg-panel)' : 'linear-gradient(135deg,#3B7EF7,#6366F1)')
                    : 'transparent',
                  color: view === v
                    ? (isMobile ? 'var(--text)' : '#fff')
                    : 'var(--text-2)',
                  boxShadow: view === v
                    ? (isMobile ? '0 1px 4px rgba(0,0,0,0.28)' : 'var(--blue-glow)')
                    : 'none',
                  transition: 'all 0.15s',
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
          key={`${language}-${language === 'he' ? 'rtl' : 'ltr'}`}  /* remount on language/direction change */
          events={fcEvents}
          locale={language === 'he' && localeData ? localeData : language}
          direction={language === 'he' ? 'rtl' : 'ltr'}
          headerToolbar={false}        /* we use our own prev/next buttons above */
          height="100%"
          nowIndicator
          scrollTime={scrollTime}
          allDaySlot={false}
          slotMinTime="00:00:00"
          slotMaxTime="24:00:00"
          slotDuration="00:30:00"
          slotLabelInterval="01:00:00"
          eventMinHeight={isMobile ? Math.max(24, Math.round(slotHeight * 0.55)) : 20}
          eventTimeFormat={{ hour: 'numeric', minute: '2-digit', meridiem: false }}
          dayHeaderFormat={{ weekday: 'short', day: 'numeric' }}
          datesSet={(info: { view: { currentStart: Date } }) => setCurrentDate(info.view.currentStart)}
          eventClick={handleEventClick}
          dateClick={handleDateClick}
          /* Custom render for month-view events on mobile: bypasses FC's 6px 10px
             padding entirely using negative margins + our own compact layout */
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          eventContent={(arg: any) => {
            if (isMobile && view === 'dayGridMonth') {
              const color = arg.event.backgroundColor || '#3B7EF7'
              return (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 3,
                  // Negative margins cancel out .fc .fc-event { padding: 6px 10px }
                  margin: '-6px -10px', padding: '2px 4px',
                  borderRadius: 3, overflow: 'hidden',
                }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: color }} />
                  <div style={{
                    flex: 1, minWidth: 0,
                    fontSize: 9, fontWeight: 700, lineHeight: '1.4',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    color: 'var(--text)',
                  }}>
                    {arg.event.title}
                  </div>
                </div>
              )
            }
            return true // default rendering for time-grid views
          }}
          views={{
            /* 3-day custom view */
            timeGrid3Day: {
              type: 'timeGrid',
              duration: { days: 3 },
            },
            /* Month view: force block (colored bar) on mobile so titles show */
            dayGridMonth: {
              dayMaxEvents: isMobile ? 2 : 4,
              ...(isMobile ? { eventDisplay: 'block' } : {}),
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
          language={language}
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
        bottom: 'calc(80px + env(safe-area-inset-bottom, 0px))',
        left: 8, right: 8, zIndex: 50,
        background: 'var(--bg-panel)',
        borderRadius: 22,
        boxShadow: '0 -4px 48px rgba(0,0,0,0.6)',
        minHeight: 220,
        maxHeight: '65vh',
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
