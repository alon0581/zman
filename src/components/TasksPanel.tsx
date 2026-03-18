'use client'

import { useState, useMemo } from 'react'
import { CalendarEvent, Task } from '@/types'
import { format, isPast, parseISO } from 'date-fns'
import { CheckCircle2, Circle, Calendar, ChevronDown, ChevronRight, Plus } from 'lucide-react'

interface Props {
  tasks: Task[]
  events?: CalendarEvent[]
  language?: string
  onTaskToggle: (id: string, newStatus: Task['status']) => void
  onScheduleTask: (task: Task) => void
  onAddTask: (text: string) => void
}

const PRIORITY_DOT: Record<Task['priority'], string> = {
  high: '#EF4444',
  medium: '#F59E0B',
  low: '#6B7280',
}

const PRIORITY_LABEL: Record<string, Record<Task['priority'], string>> = {
  en: { high: 'High', medium: 'Med', low: 'Low' },
  he: { high: 'גבוה', medium: 'בינוני', low: 'נמוך' },
}

const T = {
  en: {
    tasks: 'Tasks',
    empty: 'You have no tasks yet.\nAsk me to add one — e.g. "Add: finish physics homework, due Friday, high priority"',
    schedule: 'Schedule',
    allDone: 'All done! Great work.',
    doneGroup: 'Done',
    overdue: 'Overdue',
    due: 'Due',
    add: 'Add a task...',
    send: 'Send',
  },
  he: {
    tasks: 'משימות',
    empty: 'עדיין אין לך משימות.\nבקש ממני להוסיף — לדוגמה: "הוסף: לסיים שיעורי בית בפיזיקה, עד יום שישי, עדיפות גבוהה"',
    schedule: '📅 קבע',
    allDone: 'הכל נגמר! כל הכבוד.',
    doneGroup: 'הושלם',
    overdue: 'פג תוקף',
    due: 'עד',
    add: 'הוסף משימה...',
    send: 'שלח',
  },
}

export default function TasksPanel({ tasks, events = [], language = 'en', onTaskToggle, onScheduleTask, onAddTask }: Props) {
  const [collapsedTopics, setCollapsedTopics] = useState<Set<string>>(new Set())
  const [showDone, setShowDone] = useState(false)
  const [addText, setAddText] = useState('')
  const lang = T[language as keyof typeof T] ?? T.en
  const pLabels = PRIORITY_LABEL[language] ?? PRIORITY_LABEL.en
  const isRTL = language === 'he'

  const { pending, done } = useMemo(() => {
    const pending = tasks.filter(t => t.status !== 'done')
    const done = tasks.filter(t => t.status === 'done')
    return { pending, done }
  }, [tasks])

  // Pre-compute done counts by topic — O(n) once instead of O(n) per topic in render
  const doneCountByTopic = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const t of tasks) {
      if (t.status === 'done') {
        const topic = t.topic ?? (language === 'he' ? 'כללי' : 'General')
        counts[topic] = (counts[topic] ?? 0) + 1
      }
    }
    return counts
  }, [tasks, language])

  // Map each task title → earliest upcoming calendar event (for "scheduled" badge)
  const scheduledByTaskId = useMemo(() => {
    const now = new Date()
    const map: Record<string, Date> = {}
    for (const task of pending) {
      const titleLower = task.title.toLowerCase()
      const match = events
        .filter(e => {
          const start = new Date(e.start_time)
          if (start <= now) return false
          const evLower = e.title.toLowerCase()
          return evLower.includes(titleLower) || titleLower.includes(evLower)
        })
        .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())[0]
      if (match) map[task.id] = new Date(match.start_time)
    }
    return map
  }, [pending, events])

  // Group pending by topic
  const byTopic = useMemo(() => {
    const map: Record<string, Task[]> = {}
    for (const task of pending) {
      const topic = task.topic ?? (language === 'he' ? 'כללי' : 'General')
      if (!map[topic]) map[topic] = []
      map[topic].push(task)
    }
    // Sort each group: overdue first, then by priority (high > medium > low), then by deadline
    const priorityOrder = { high: 0, medium: 1, low: 2 }
    for (const group of Object.values(map)) {
      group.sort((a, b) => {
        const aOver = a.deadline && isPast(parseISO(a.deadline)) ? -1 : 0
        const bOver = b.deadline && isPast(parseISO(b.deadline)) ? -1 : 0
        if (aOver !== bOver) return aOver - bOver
        const pDiff = priorityOrder[a.priority] - priorityOrder[b.priority]
        if (pDiff !== 0) return pDiff
        if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline)
        if (a.deadline) return -1
        if (b.deadline) return 1
        return 0
      })
    }
    return map
  }, [pending, language])

  const toggleTopic = (topic: string) => {
    setCollapsedTopics(prev => {
      const next = new Set(prev)
      if (next.has(topic)) next.delete(topic)
      else next.add(topic)
      return next
    })
  }

  const handleSubmit = () => {
    const text = addText.trim()
    if (!text) return
    onAddTask(text)
    setAddText('')
  }

  const topicEntries = Object.entries(byTopic)

  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      background: 'transparent', direction: isRTL ? 'rtl' : 'ltr',
    }}>
      {/* Header */}
      <div style={{ padding: '22px 24px 0', flexShrink: 0 }}>
        <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.03em', color: 'var(--text)', lineHeight: 1 }}>
          {lang.tasks}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>
          {pending.length} {language === 'he' ? 'פתוחות' : 'open'}{done.length > 0 ? ` · ${done.length} ${language === 'he' ? 'הושלמו' : 'done'}` : ''}
        </div>
      </div>

      {/* Task list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 16px 8px' }}>
        {tasks.length === 0 ? (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            height: '60%', gap: 12, textAlign: 'center', padding: '0 24px',
          }}>
            <div style={{ fontSize: 40 }}>✅</div>
            <div style={{ fontSize: 14, color: 'var(--text-2)', lineHeight: 1.6, whiteSpace: 'pre-line' }}>
              {lang.empty}
            </div>
          </div>
        ) : (
          <>
            {topicEntries.length === 0 && done.length > 0 && (
              <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-2)', fontSize: 14 }}>
                {lang.allDone}
              </div>
            )}

            {topicEntries.map(([topic, topicTasks]) => {
              const isCollapsed = collapsedTopics.has(topic)
              const doneCount = doneCountByTopic[topic] ?? 0
              const totalCount = topicTasks.length + doneCount
              const progress = totalCount > 0 ? Math.round(doneCount / totalCount * 100) : 0

              return (
                <div key={topic} style={{ marginBottom: 20 }}>
                  {/* Topic header */}
                  <button
                    onClick={() => toggleTopic(topic)}
                    style={{
                      width: '100%', background: 'none', border: 'none', cursor: 'pointer',
                      display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0 8px',
                      color: 'var(--text)',
                    }}
                  >
                    <span style={{ color: 'var(--text-2)', display: 'flex', alignItems: 'center' }}>
                      {isCollapsed
                        ? <ChevronRight size={14} />
                        : <ChevronDown size={14} />}
                    </span>
                    <span style={{ fontWeight: 700, fontSize: 13, flex: 1, textAlign: isRTL ? 'right' : 'left' }}>
                      {topic}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text-2)' }}>
                      {doneCount}/{totalCount}
                    </span>
                    {/* Progress bar */}
                    <div style={{ width: 48, height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden', flexShrink: 0 }}>
                      <div style={{ width: `${progress}%`, height: '100%', background: 'linear-gradient(90deg,#3B7EF7,#6366F1)', borderRadius: 2 }} />
                    </div>
                  </button>

                  {!isCollapsed && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {topicTasks.map(task => {
                        const isOverdue = task.deadline && isPast(parseISO(task.deadline))
                        return (
                          <div key={task.id} style={{
                            background: 'var(--bg-card)', borderRadius: 10,
                            border: `1px solid ${isOverdue ? 'rgba(239,68,68,0.35)' : 'var(--border)'}`,
                            padding: '10px 12px', display: 'flex', alignItems: 'flex-start', gap: 10,
                          }}>
                            {/* Checkbox */}
                            <button
                              onClick={() => onTaskToggle(task.id, task.status === 'done' ? 'pending' : 'done')}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, flexShrink: 0, marginTop: 1, color: task.status === 'done' ? '#34D399' : 'var(--text-2)' }}
                            >
                              {task.status === 'done'
                                ? <CheckCircle2 size={18} />
                                : <Circle size={18} />}
                            </button>

                            {/* Content */}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{
                                fontSize: 14, fontWeight: 500, color: 'var(--text)',
                                textDecoration: task.status === 'done' ? 'line-through' : 'none',
                                opacity: task.status === 'done' ? 0.5 : 1,
                                lineHeight: 1.3,
                              }}>
                                {/* Priority dot */}
                                <span style={{
                                  display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
                                  background: PRIORITY_DOT[task.priority], marginRight: 6, marginBottom: 1, verticalAlign: 'middle',
                                }} />
                                {task.title}
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                                <span style={{
                                  fontSize: 10, fontWeight: 600, color: PRIORITY_DOT[task.priority],
                                  opacity: 0.85,
                                }}>
                                  {pLabels[task.priority]}
                                </span>
                                {scheduledByTaskId[task.id] && (
                                  <span style={{
                                    fontSize: 11, color: '#3B7EF7', fontWeight: 500,
                                    display: 'flex', alignItems: 'center', gap: 3,
                                  }}>
                                    <Calendar size={10} />
                                    {format(scheduledByTaskId[task.id], language === 'he' ? 'd MMM, HH:mm' : 'MMM d, h:mma')}
                                  </span>
                                )}
                                {task.deadline && (
                                  <span style={{
                                    fontSize: 11, color: isOverdue ? '#EF4444' : 'var(--text-2)',
                                    fontWeight: isOverdue ? 600 : 400,
                                  }}>
                                    {isOverdue ? `⚠ ${lang.overdue}` : lang.due}{' '}
                                    {format(parseISO(task.deadline), 'MMM d')}
                                  </span>
                                )}
                              </div>
                            </div>

                            {/* Schedule button */}
                            {task.status !== 'done' && (
                              <button
                                onClick={() => onScheduleTask(task)}
                                title="Schedule on calendar"
                                style={{
                                  background: 'var(--bg-input)', border: '1px solid var(--border)',
                                  borderRadius: 6, cursor: 'pointer', padding: '4px 8px',
                                  display: 'flex', alignItems: 'center', gap: 4,
                                  fontSize: 11, color: 'var(--text-2)', flexShrink: 0,
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                <Calendar size={12} />
                                {lang.schedule}
                              </button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}

            {/* Done section */}
            {done.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <button
                  onClick={() => setShowDone(v => !v)}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0',
                    display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-2)', fontSize: 12,
                  }}
                >
                  {showDone ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  {lang.doneGroup} ({done.length})
                </button>
                {showDone && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6, opacity: 0.55 }}>
                    {done.map(task => (
                      <div key={task.id} style={{
                        background: 'var(--bg-card)', borderRadius: 8,
                        border: '1px solid var(--border)', padding: '8px 12px',
                        display: 'flex', alignItems: 'center', gap: 10,
                      }}>
                        <button
                          onClick={() => onTaskToggle(task.id, 'pending')}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: '#34D399' }}
                        >
                          <CheckCircle2 size={16} />
                        </button>
                        <span style={{ fontSize: 13, textDecoration: 'line-through', color: 'var(--text)' }}>
                          {task.title}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Quick add bar */}
      <div style={{
        padding: '10px 16px 16px', flexShrink: 0, borderTop: '1px solid var(--border)',
      }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ color: 'var(--text-2)', display: 'flex', flexShrink: 0 }}>
            <Plus size={16} />
          </span>
          <input
            value={addText}
            onChange={e => setAddText(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSubmit()}
            placeholder={lang.add}
            style={{
              flex: 1, background: 'var(--bg-input)', border: '1px solid var(--border)',
              borderRadius: 8, padding: '8px 12px', fontSize: 13,
              color: 'var(--text)', outline: 'none',
            }}
          />
          {addText.trim() && (
            <button
              onClick={handleSubmit}
              style={{
                background: 'linear-gradient(135deg,#3B7EF7,#6366F1)',
                border: 'none', borderRadius: 8, padding: '8px 14px',
                color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', flexShrink: 0,
              }}
            >
              {lang.send}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
