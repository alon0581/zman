'use client'

import { useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { ChevronLeft, ChevronRight, CalendarPlus, Lock, Circle, CircleDot, CheckCircle2 } from 'lucide-react'
import { Project, Task } from '@/types'
import { BoardColumn, BoardRules, ResolvedSignal } from '@/lib/projects/types'

/**
 * The full-screen board.
 *
 * Its shape comes from BOARD_RULES, which is keyed on the user's scheduling
 * method — so a Kanban user gets a WIP cap, a "One Thing" user gets a board that
 * refuses to show a backlog, and a Pomodoro user gets a list with a counter. This
 * component renders whatever the config says; it holds no per-method branches of
 * its own beyond the two column SOURCES (a status, or a derived lens).
 *
 * On a phone this is deliberately NOT horizontally-scrolling columns: task rows
 * elsewhere in the app already own the horizontal drag gesture (swipe-to-delete
 * in TasksPanel), and two competing x-gestures on one screen is a bug factory.
 * A segmented status filter over a single list shows the same data with no new
 * idiom to learn.
 */

const T = {
  en: { plan: 'Plan this project', all: 'All', schedule: 'Schedule', blockedBy: 'after' },
  he: { plan: 'תכנן לי את הפרויקט', all: 'הכל', schedule: 'קבע', blockedBy: 'אחרי' },
}

interface Props {
  project: Project
  tasks: Task[]
  rules: BoardRules
  signals: ResolvedSignal[]
  language?: string
  isMobile?: boolean
  onClose: () => void
  onTaskStatus: (id: string, status: Task['status']) => void
  onAskAi: (message: string) => void
}

export default function ProjectBoard({
  project, tasks, rules, signals, language = 'en', isMobile, onClose, onTaskStatus, onAskAi,
}: Props) {
  const isHe = language === 'he'
  const lang = T[language as keyof typeof T] ?? T.en
  const [filter, setFilter] = useState<string>('all')

  const doneIds = useMemo(() => new Set(tasks.filter(t => t.status === 'done').map(t => t.id)), [tasks])
  const mine = useMemo(() => tasks.filter(t => t.project_id === project.id), [tasks, project.id])

  const inColumn = (col: BoardColumn): Task[] => {
    switch (col.source) {
      case 'status:pending': return mine.filter(t => t.status === 'pending')
      case 'status:in_progress': return mine.filter(t => t.status === 'in_progress')
      case 'status:done': return mine.filter(t => t.status === 'done')
      case 'derived:blocked':
        return mine.filter(t => t.status !== 'done' && (t.depends_on ?? []).some(id => !doneIds.has(id)))
      case 'derived:urgent':
        return mine.filter(t => t.status !== 'done' && t.priority === 'high')
    }
  }

  const columns = rules.columns
    .map(col => ({ col, items: inColumn(col) }))
    // A derived column is a lens, so an empty one is noise. A status column holds
    // its place, because "nothing in progress" is information.
    .filter(({ col, items }) => !(col.hideWhenEmpty && items.length === 0))

  const doingCount = mine.filter(t => t.status === 'in_progress').length
  const overWip = rules.wipLimit !== null && doingCount > rules.wipLimit

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      transition={{ type: 'spring', stiffness: 320, damping: 30 }}
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        // Opaque, not a scrim: this is a workspace, not a dialog. It must also set
        // its own direction — the desktop shell hard-codes ltr to keep the calendar
        // on the left, and a fixed child at the app root would inherit that.
        background: 'var(--bg)',
        display: 'flex', flexDirection: 'column',
        direction: isHe ? 'rtl' : 'ltr',
        paddingTop: 'env(safe-area-inset-top, 0px)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      } as React.CSSProperties}
    >
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
        borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <button onClick={onClose} style={iconBtn} aria-label="back">
          {isHe ? <ChevronRight size={20} /> : <ChevronLeft size={20} />}
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 16, fontWeight: 750, color: 'var(--text)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{project.title}</div>
          <div style={{ fontSize: 11, color: 'var(--text-2)' }}>
            {isHe ? rules.boardTitle.he : rules.boardTitle.en}
            {rules.wipLimit !== null && ` · ${doingCount}/${rules.wipLimit}`}
          </div>
        </div>
        <button
          onClick={() => onAskAi(isHe
            ? `תכנן לי את הפרויקט "${project.title}"`
            : `Plan the project "${project.title}"`)}
          style={{
            border: 'none', background: 'var(--blue)', color: '#fff',
            borderRadius: 10, padding: '9px 13px', fontSize: 12.5, fontWeight: 650,
            cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
          }}
        >
          {lang.plan}
        </button>
      </div>

      {/* The four signals, as full sentences. Straight from the engine. */}
      {signals.length > 0 && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: '4px 14px',
          padding: '9px 16px', borderBottom: '1px solid var(--border)',
          fontSize: 12, color: 'var(--text-2)', flexShrink: 0,
        }}>
          {signals.map(s => (
            <span key={s.signal} style={{ color: s.state === 'risk' ? 'var(--red)' : s.state === 'warn' ? 'var(--yellow)' : 'var(--text-2)' }}>
              {isHe ? s.text.he : s.text.en}
            </span>
          ))}
        </div>
      )}

      {overWip && (
        <div style={{
          padding: '7px 16px', background: 'rgba(251,191,36,0.12)',
          color: 'var(--yellow)', fontSize: 12, flexShrink: 0,
        }}>
          {isHe
            ? `${doingCount} בתהליך — סיים אחת לפני שאתה מושך עוד`
            : `${doingCount} in progress — finish one before pulling another`}
        </div>
      )}

      {/* Mobile: segmented filter + one list. Desktop: columns side by side. */}
      {isMobile ? (
        <>
          <div style={{ display: 'flex', gap: 5, padding: '10px 12px', overflowX: 'auto', flexShrink: 0 }}>
            <Segment active={filter === 'all'} label={`${lang.all} ${mine.length}`} onClick={() => setFilter('all')} />
            {columns.map(({ col, items }) => (
              <Segment
                key={col.id}
                active={filter === col.id}
                label={`${isHe ? col.label.he : col.label.en} ${items.length}`}
                onClick={() => setFilter(col.id)}
              />
            ))}
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px 16px', display: 'flex', flexDirection: 'column', gap: 7 }}>
            {(filter === 'all' ? mine : columns.find(c => c.col.id === filter)?.items ?? []).map(t => (
              <TaskRow key={t.id} task={t} tasks={tasks} doneIds={doneIds} isHe={isHe} lang={lang}
                onStatus={onTaskStatus} onAskAi={onAskAi} />
            ))}
          </div>
        </>
      ) : (
        <div style={{ flex: 1, display: 'flex', gap: 12, padding: 14, overflowX: 'auto' }}>
          {columns.map(({ col, items }) => (
            <div key={col.id} style={{
              flex: 1, minWidth: 220, display: 'flex', flexDirection: 'column',
              background: 'var(--bg-panel)', border: '1px solid var(--border)',
              borderRadius: 12, overflow: 'hidden',
            }}>
              <div style={{
                padding: '9px 12px', borderBottom: '1px solid var(--border)',
                fontSize: 12, fontWeight: 650, color: 'var(--text-2)',
                display: 'flex', justifyContent: 'space-between',
              }}>
                <span>{isHe ? col.label.he : col.label.en}</span>
                <span style={{ color: 'var(--text-3)' }}>{items.length}</span>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 7 }}>
                {items.map(t => (
                  <TaskRow key={t.id} task={t} tasks={tasks} doneIds={doneIds} isHe={isHe} lang={lang}
                    onStatus={onTaskStatus} onAskAi={onAskAi} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {mine.length === 0 && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
          justifyContent: 'center', pointerEvents: 'none', padding: 32,
          color: 'var(--text-2)', fontSize: 13, textAlign: 'center', lineHeight: 1.6,
        }}>
          {isHe ? rules.emptyState.he : rules.emptyState.en}
        </div>
      )}
    </motion.div>
  )
}

function Segment({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      padding: '6px 12px', borderRadius: 999, whiteSpace: 'nowrap', cursor: 'pointer',
      border: `1px solid ${active ? 'var(--blue)' : 'var(--border)'}`,
      background: active ? 'rgba(59,126,247,0.14)' : 'var(--bg-card)',
      color: active ? 'var(--text)' : 'var(--text-2)',
      fontSize: 12, fontWeight: active ? 650 : 500,
    }}>{label}</button>
  )
}

/** One task. The status control is a single circle cycling pending -> doing -> done. */
function TaskRow({ task, tasks, doneIds, isHe, lang, onStatus, onAskAi }: {
  task: Task
  tasks: Task[]
  doneIds: Set<string>
  isHe: boolean
  lang: typeof T['en']
  onStatus: (id: string, s: Task['status']) => void
  onAskAi: (m: string) => void
}) {
  const unmet = (task.depends_on ?? []).filter(id => !doneIds.has(id))
  const blocked = task.status !== 'done' && unmet.length > 0
  const blockerTitle = unmet.length ? (tasks.find(t => t.id === unmet[0])?.title ?? unmet[0]) : ''

  const next: Task['status'] =
    task.status === 'pending' ? 'in_progress' : task.status === 'in_progress' ? 'done' : 'pending'

  const Icon = task.status === 'done' ? CheckCircle2 : task.status === 'in_progress' ? CircleDot : Circle
  const iconColor = task.status === 'done' ? 'var(--green)' : task.status === 'in_progress' ? 'var(--blue)' : 'var(--text-3)'

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 9,
      background: 'var(--bg-card)', border: '1px solid var(--border)',
      borderRadius: 10, padding: '9px 11px',
      opacity: task.status === 'done' ? 0.6 : 1,
    }}>
      <button
        onClick={() => onStatus(task.id, next)}
        style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, marginTop: 1, flexShrink: 0 }}
        aria-label="status"
      >
        <Icon size={17} color={iconColor} />
      </button>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, color: 'var(--text)',
          textDecoration: task.status === 'done' ? 'line-through' : 'none',
        }}>
          {task.title}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 3, fontSize: 11, color: 'var(--text-2)', flexWrap: 'wrap' }}>
          {task.estimated_hours ? <span>{task.estimated_hours}{isHe ? ' שע׳' : 'h'}</span> : null}
          {blocked && (
            // The dependency is made visible rather than left as an invisible
            // input to the planner.
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--yellow)' }}>
              <Lock size={10} /> {lang.blockedBy}: {blockerTitle}
            </span>
          )}
        </div>
      </div>

      {task.status !== 'done' && !blocked && (
        <button
          onClick={() => onAskAi(isHe ? `קבע זמן ל"${task.title}"` : `Schedule time for "${task.title}"`)}
          style={{
            border: '1px solid var(--border-hi)', background: 'transparent', color: 'var(--text-2)',
            borderRadius: 7, padding: '4px 6px', cursor: 'pointer', flexShrink: 0,
            display: 'flex', alignItems: 'center',
          }}
          aria-label={lang.schedule}
        >
          <CalendarPlus size={13} />
        </button>
      )}
    </div>
  )
}

const iconBtn: React.CSSProperties = {
  width: 34, height: 34, borderRadius: 9, border: 'none',
  background: 'transparent', color: 'var(--text-2)', cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
}
