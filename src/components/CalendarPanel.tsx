'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
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
  // Apple-style day sheet for month view on mobile
  const [selectedDate, setSelectedDate] = useState<Date | null>(null)

  // Auto-switch away from week view when on mobile (week is desktop-only)
  useEffect(() => {
    if (isMobile && view === 'timeGridWeek') setView('timeGrid3Day')
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

  // Swipe spring animation — brief nudge feedback on the inner FC wrapper
  const [swipeOffset, setSwipeOffset] = useState(0)
  // Stable ref so the touch useEffect closure can call setState without going stale
  const setSwipeOffsetRef = useRef(setSwipeOffset)

  // Pinch scroll-anchor: cancel-able rAF so only the last zoom level restores scroll.
  // We capture the ratio in a closure (not a mutable ref) so overwrites can't corrupt it.
  const scrollAnchorRafRef = useRef(0)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    // startScrollTop saved once at pinch-start — never updated during the gesture.
    // This prevents the "chained ratio" bug: when multiple onTouchMove events fire
    // in the same JS frame the DOM hasn't updated yet, so reading scrollTop gives the
    // same stale value each time.  Using slotHeightRef.current as oldH compounds the
    // error because it WAS updated synchronously by the previous move.
    // Anchoring to pinch-start values makes every step's expectedScrollTop correct
    // regardless of how many moves fired in the same frame.
    const pinch = { active: false, startDist: 0, startHeight: DEFAULT_SLOT_H, startScrollTop: 0, indicatorStartTops: [] as number[] }
    const swipe = { startX: 0, startY: 0, triggered: false }

    const getBodyScroller = () =>
      (Array.from(el.querySelectorAll('.fc-scroller')) as HTMLElement[])
        .find(s => s.scrollHeight > s.clientHeight) ?? null

    // ── Touch handlers (mobile) ──────────────────────────────────────────────
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault()
        const dx = e.touches[0].clientX - e.touches[1].clientX
        const dy = e.touches[0].clientY - e.touches[1].clientY
        pinch.startDist = Math.hypot(dx, dy)
        pinch.startHeight = slotHeightRef.current
        // Capture scroll anchor once — used for ALL subsequent moves in this gesture
        pinch.startScrollTop = getBodyScroller()?.scrollTop ?? 0
        // Capture now-indicator top positions — FC sets top on the line/arrow children,
        // NOT on the container (container always has top:"" / offsetTop:0).
        pinch.indicatorStartTops = (Array.from(
          el.querySelectorAll('.fc-timegrid-now-indicator-line, .fc-timegrid-now-indicator-arrow')
        ) as HTMLElement[]).map(ind => ind.offsetTop)
        pinch.active = true
        swipe.triggered = true // suppress swipe while pinching
        // Activate CSS scale transform on event blocks so they move with slots
        el.classList.add('fc-pinch-active')
        el.style.setProperty('--pinch-scale', '1')
      } else if (e.touches.length === 1) {
        swipe.startX = e.touches[0].clientX
        swipe.startY = e.touches[0].clientY
        swipe.triggered = false
        pinch.active = false
      }
    }

    const onTouchMove = (e: TouchEvent) => {
      // ── Pinch: 2 fingers ──────────────────────────────────────────────────
      if (e.touches.length === 2 && pinch.active) {
        e.preventDefault()
        const dx = e.touches[0].clientX - e.touches[1].clientX
        const dy = e.touches[0].clientY - e.touches[1].clientY
        const scaleRatio = Math.hypot(dx, dy) / pinch.startDist
        const newH = Math.max(28, Math.min(110, Math.round(pinch.startHeight * scaleRatio)))
        if (newH !== slotHeightRef.current) {
          // DON'T call updateSlotHeight (no React re-render during gesture).
          // Mutate CSS variables directly — slots resize, events scale via transform.
          slotHeightRef.current = newH
          el.style.setProperty('--fc-slot-height', `${newH}px`)
          // Keep event scale in sync: scaleY(newH/startH) makes inline top/height
          // values (computed for startH) land at exactly the correct pixel positions.
          el.style.setProperty('--pinch-scale', String(newH / pinch.startHeight))

          // Restore scroll anchor — one rAF is enough here (CSS mutation is sync,
          // browser reflows before the next paint, not after a React render cycle)
          const expectedScrollTop = Math.round(pinch.startScrollTop * (newH / pinch.startHeight))
          const target = getBodyScroller()
          if (target) {
            cancelAnimationFrame(scrollAnchorRafRef.current)
            scrollAnchorRafRef.current = requestAnimationFrame(() => {
              target.scrollTop = expectedScrollTop
            })
          }

          // Shift now-indicator via translateY rather than overriding style.top.
          // FC may re-render mid-gesture (ResizeObserver) and reset style.top back
          // to the stale value — but it never touches style.transform, so the
          // visual offset survives.  Math: FC keeps top=startTop; we add
          // translateY(startTop*(ratio-1)) so the rendered position = startTop*ratio.
          const indRatio = newH / pinch.startHeight;
          (Array.from(el.querySelectorAll('.fc-timegrid-now-indicator-line, .fc-timegrid-now-indicator-arrow')) as HTMLElement[])
            .forEach((ind, i) => {
              const delta = (pinch.indicatorStartTops[i] ?? 0) * (indRatio - 1)
              ind.style.transform = `translateY(${Math.round(delta)}px)`
            })
        }
        return
      }

      // ── Swipe: 1 finger, detect early in move (not end) ──────────────────
      // Detecting in onMove + calling preventDefault stops the browser from
      // firing touchcancel (which would lose position data on horizontal swipe)
      if (e.touches.length === 1 && !swipe.triggered) {
        const dx = e.touches[0].clientX - swipe.startX
        const dy = e.touches[0].clientY - swipe.startY
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          e.preventDefault()
          swipe.triggered = true
          // Spring nudge feedback: briefly push in swipe direction then snap to 0
          const nudge = dx > 0 ? 28 : -28
          setSwipeOffsetRef.current(nudge)
          setTimeout(() => setSwipeOffsetRef.current(0), 60)
          if (language === 'he') { dx > 0 ? goNext() : goPrev() }
          else                   { dx > 0 ? goPrev() : goNext() }
        }
      }
    }

    const onTouchEnd = (e: TouchEvent) => {
      if (pinch.active && e.touches.length < 2) {
        pinch.active = false

        // Remove scale transform BEFORE flushSync so FC's re-render paints
        // events at their real (recalculated) positions without the transform
        // still active — avoids a double-transform flash.
        el.classList.remove('fc-pinch-active')
        el.style.removeProperty('--pinch-scale')

        // Clear translateY offsets so FC's flushSync re-render sets the final top cleanly
        ;(Array.from(el.querySelectorAll('.fc-timegrid-now-indicator-line, .fc-timegrid-now-indicator-arrow')) as HTMLElement[])
          .forEach(ind => { ind.style.transform = '' })

        const target = getBodyScroller()
        const savedScrollTop = target?.scrollTop ?? 0

        // flushSync: synchronous React+FC re-render → DOM fully updated
        // before the browser paints the next frame.
        flushSync(() => updateSlotHeight(slotHeightRef.current))

        // Restore scroll anchor immediately — no rAF gap.
        if (target) target.scrollTop = savedScrollTop
      }
    }

    // ── Mouse handlers (desktop swipe via drag) ──────────────────────────────
    const mouse = { down: false, startX: 0, startY: 0, triggered: false }

    const onMouseDown = (e: MouseEvent) => {
      // Skip clicks on events — let FC handle those
      if ((e.target as Element).closest('.fc-event')) return
      mouse.down = true
      mouse.startX = e.clientX
      mouse.startY = e.clientY
      mouse.triggered = false
    }

    const onMouseMove = (e: MouseEvent) => {
      if (!mouse.down || mouse.triggered) return
      const dx = e.clientX - mouse.startX
      const dy = e.clientY - mouse.startY
      // Higher threshold on desktop (mouse is more precise than touch)
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        mouse.triggered = true
        const nudge = dx > 0 ? 28 : -28
        setSwipeOffsetRef.current(nudge)
        setTimeout(() => setSwipeOffsetRef.current(0), 60)
        if (language === 'he') { dx > 0 ? goNext() : goPrev() }
        else                   { dx > 0 ? goPrev() : goNext() }
      }
    }

    const onMouseUp = () => {
      mouse.down = false
      mouse.triggered = false
    }

    // ── Wheel handler (desktop Ctrl+wheel = zoom, same as browser pinch) ─────
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const bodyScroller = (Array.from(el.querySelectorAll('.fc-scroller')) as HTMLElement[])
        .find(s => s.scrollHeight > s.clientHeight) ?? null
      const oldScrollTop = bodyScroller?.scrollTop ?? 0
      const oldH = slotHeightRef.current
      // Scroll up (negative delta) = zoom in, scroll down = zoom out
      const delta = e.deltaY < 0 ? 4 : -4
      const newH = Math.max(28, Math.min(110, oldH + delta))
      if (newH !== oldH) {
        const expectedScrollTop = Math.round(oldScrollTop * (newH / oldH))
        updateSlotHeight(newH)
        if (bodyScroller) {
          const target = bodyScroller
          cancelAnimationFrame(scrollAnchorRafRef.current)
          scrollAnchorRafRef.current = requestAnimationFrame(() => {
            scrollAnchorRafRef.current = requestAnimationFrame(() => {
              target.scrollTop = expectedScrollTop
            })
          })
        }
      }
    }

    // Use touch events on any touch-capable device (iPhone, iPad, Android),
    // regardless of screen width. isMobile is width-based so iPads (≥768px)
    // would otherwise fall into the mouse branch and lose swipe + pinch.
    const hasTouch = navigator.maxTouchPoints > 0

    if (hasTouch) {
      // capture:true — intercept BEFORE FullCalendar's internal handlers
      // which may call stopPropagation() in bubble phase
      el.addEventListener('touchstart', onTouchStart, { passive: false, capture: true })
      el.addEventListener('touchmove', onTouchMove, { passive: false, capture: true })
      el.addEventListener('touchend', onTouchEnd, { passive: true, capture: true })
      el.addEventListener('touchcancel', onTouchEnd, { passive: true, capture: true })
    }
    // Always register mouse + wheel for desktop (and iPad with mouse/trackpad)
    el.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    el.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      if (hasTouch) {
        el.removeEventListener('touchstart', onTouchStart, { capture: true })
        el.removeEventListener('touchmove', onTouchMove, { capture: true })
        el.removeEventListener('touchend', onTouchEnd, { capture: true })
        el.removeEventListener('touchcancel', onTouchEnd, { capture: true })
      }
      el.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      el.removeEventListener('wheel', onWheel)
    }
  // plugins.length added: effect must re-run after FC loads dynamically.
  // On first render FC=null → containerRef is null (loading div shown) → effect exits early.
  // When FC loads, plugins changes [] → [3 items], triggering re-run with real containerRef.
  }, [isMobile, updateSlotHeight, DEFAULT_SLOT_H, language, goPrev, goNext, plugins.length])

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
    extendedProps: { mobility_type: ev.mobility_type },
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

            <div style={{ minWidth: 0, overflow: 'hidden' }}>
              <AnimatePresence mode="wait">
                <motion.div
                  key={format(currentDate, 'yyyy-MM-dd')}
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  transition={{ duration: 0.18, ease: 'easeOut' }}
                >
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
                </motion.div>
              </AnimatePresence>
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

          {/* View switcher — iOS segmented control on mobile, gradient buttons on desktop */}
          <div style={{
            display: 'flex',
            position: 'relative',
            background: isMobile ? 'rgba(118,118,128,0.18)' : 'var(--bg-card)',
            borderRadius: isMobile ? 9 : 10,
            padding: isMobile ? 2 : 3,
            border: isMobile ? 'none' : '1px solid var(--border)',
            gap: isMobile ? 1 : 2,
            flexShrink: 0,
          }}>
            {(isMobile ? VIEW_ORDER_MOBILE : VIEW_ORDER_DESKTOP).map(v => (
              <motion.button
                key={v}
                onClick={() => setView(v)}
                whileTap={{ scale: 0.92 }}
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                style={{
                  position: 'relative',
                  padding: isMobile ? '5px 14px' : '5px 12px',
                  borderRadius: isMobile ? 7 : 8,
                  border: 'none', cursor: 'pointer',
                  fontSize: isMobile ? 13 : 12, fontWeight: 600,
                  background: 'transparent',
                  color: view === v
                    ? (isMobile ? 'var(--text)' : '#fff')
                    : 'var(--text-2)',
                  whiteSpace: 'nowrap',
                  zIndex: 1,
                  WebkitUserSelect: 'none',
                  userSelect: 'none',
                }}
              >
                {/* Sliding active pill — shared layoutId animates between buttons */}
                {view === v && (
                  <motion.span
                    layoutId="view-pill"
                    style={{
                      position: 'absolute',
                      inset: 0,
                      borderRadius: isMobile ? 7 : 8,
                      background: isMobile
                        ? 'var(--bg-panel)'
                        : 'linear-gradient(135deg,#3B7EF7,#6366F1)',
                      boxShadow: isMobile
                        ? '0 1px 4px rgba(0,0,0,0.28)'
                        : 'var(--blue-glow)',
                      zIndex: -1,
                    }}
                    transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                  />
                )}
                {labels[v] ?? v}
              </motion.button>
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
          touchAction: isMobile ? 'none' : undefined,
        } as React.CSSProperties}
      >
        {/* Inner motion wrapper: spring nudge on swipe, smooth height on pinch */}
        <motion.div
          animate={{ x: swipeOffset }}
          transition={{ type: 'spring', stiffness: 500, damping: 35, mass: 0.6 }}
          style={{ height: '100%', willChange: 'transform' }}
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
          slotMinHeight={slotHeight}
          eventMinHeight={isMobile ? Math.max(24, Math.round(slotHeight * 0.55)) : 20}
          editable={!isMobile}
          selectable={!isMobile}
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
            // Timegrid views: show mobility icon badge
            const mobilityType = arg.event.extendedProps?.mobility_type
            const mobilityIcon = mobilityType === 'fixed' ? '🔒' : mobilityType === 'flexible' ? '🟡' : mobilityType === 'ask_first' ? '🔵' : null
            if (mobilityIcon) {
              return (
                <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                  <div className="fc-event-main-frame">
                    <div className="fc-event-time">{arg.timeText}</div>
                    <div className="fc-event-title-container">
                      <div className="fc-event-title fc-sticky">{arg.event.title}</div>
                    </div>
                  </div>
                  <span style={{
                    position: 'absolute', bottom: 3, right: 4,
                    fontSize: 8, lineHeight: 1, opacity: 0.7,
                  }}>{mobilityIcon}</span>
                </div>
              )
            }
            return true // default rendering
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
        </motion.div>
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
