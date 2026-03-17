'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarEvent } from '@/types'
import { format } from 'date-fns'
import { he as heLocale } from 'date-fns/locale'
import { ChevronLeft, ChevronRight } from 'lucide-react'
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

const VIEW_ORDER: ViewType[] = ['timeGridDay', 'timeGrid3Day', 'timeGridWeek', 'dayGridMonth']

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
  // Mobile defaults to 3-day view, desktop to week
  const [view, setView] = useState<ViewType>(isMobile ? 'timeGrid3Day' : 'timeGridWeek')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [plugins, setPlugins] = useState<any[]>([])
  const [FC, setFC] = useState<FCType | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [localeData, setLocaleData] = useState<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const calRef = useRef<any>(null)
  const [currentDate, setCurrentDate] = useState(new Date())
  const [popup, setPopup] = useState<PopupState | null>(null)

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
  }, [view])

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

          {/* View switcher */}
          <div style={{
            display: 'flex', background: 'var(--bg-card)',
            borderRadius: 10, padding: 3, border: '1px solid var(--border)', gap: 2, flexShrink: 0,
          }}>
            {VIEW_ORDER.map(v => (
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

      {/* Calendar */}
      <div style={{ flex: 1, overflow: 'hidden', padding: isMobile ? '6px 8px 8px' : '8px 16px 12px' }}>
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
          eventTimeFormat={{ hour: 'numeric', minute: '2-digit', meridiem: false }}
          dayHeaderFormat={{ weekday: 'short', day: 'numeric' }}
          datesSet={(info: { view: { currentStart: Date } }) => setCurrentDate(info.view.currentStart)}
          eventClick={handleEventClick}
          views={{
            /* 3-day custom view */
            timeGrid3Day: {
              type: 'timeGrid',
              duration: { days: 3 },
            },
            /* Month view: limit visible events per day so text is readable */
            dayGridMonth: {
              dayMaxEvents: isMobile ? 2 : 4,
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
    </div>
  )
}
