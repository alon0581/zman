'use client'

import { useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Plus } from 'lucide-react'
import { Project } from '@/types'
import { ResolvedSignal } from '@/lib/projects/types'
import ProjectCard from './ProjectCard'
import NewProjectSheet from './NewProjectSheet'

export interface ProjectHealthMap {
  [projectId: string]: { signals: ResolvedSignal[] }
}

const T = {
  en: {
    projects: 'Projects',
    empty: 'No projects yet.\nA project is a body of work with steps — a course, a deliverable, something you are building.',
    add: 'New project',
    active: 'active',
  },
  he: {
    projects: 'פרויקטים',
    empty: 'אין עדיין פרויקטים.\nפרויקט הוא גוף עבודה עם שלבים — קורס, מטלה להגשה, או משהו שאתה בונה.',
    add: 'פרויקט חדש',
    active: 'פעילים',
  },
}

/** Worst first, so the thing most likely to bite is at the top of the list. */
const RISK_RANK: Record<string, number> = { risk: 0, warn: 1, unknown: 2, ok: 3 }

interface Props {
  projects: Project[]
  health: ProjectHealthMap
  language?: string
  onOpenProject: (id: string) => void
  onCreated: () => void
  onAskAi?: (message: string) => void
}

export default function ProjectsPanel({
  projects, health, language = 'en', onOpenProject, onCreated, onAskAi,
}: Props) {
  const isHe = language === 'he'
  const lang = T[language as keyof typeof T] ?? T.en
  const [creating, setCreating] = useState(false)

  const visible = useMemo(() => {
    const active = projects.filter(p => p.status === 'active' || p.status === 'paused')
    return [...active].sort((a, b) => {
      const sa = health[a.id]?.signals.find(s => s.signal === 'deadline')?.state ?? 'ok'
      const sb = health[b.id]?.signals.find(s => s.signal === 'deadline')?.state ?? 'ok'
      const ra = RISK_RANK[sa] ?? 3
      const rb = RISK_RANK[sb] ?? 3
      if (ra !== rb) return ra - rb
      const da = a.deadline ?? '￿'
      const db = b.deadline ?? '￿'
      if (da !== db) return da < db ? -1 : 1
      return a.created_at < b.created_at ? -1 : 1
    })
  }, [projects, health])

  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      background: 'transparent', direction: isHe ? 'rtl' : 'ltr',
    }}>
      <div style={{ padding: '16px 16px 10px', flexShrink: 0 }}>
        <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.03em', color: 'var(--text)' }}>
          {lang.projects}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>
          {visible.length} {lang.active}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {visible.length === 0 && (
          <div style={{
            color: 'var(--text-2)', fontSize: 13, lineHeight: 1.6,
            whiteSpace: 'pre-line', padding: '24px 8px', textAlign: 'center',
          }}>
            {lang.empty}
          </div>
        )}
        <AnimatePresence initial={false}>
          {visible.map(p => (
            <motion.div
              key={p.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={{ type: 'spring', stiffness: 300, damping: 28 }}
            >
              <ProjectCard
                project={p}
                signals={health[p.id]?.signals ?? []}
                language={language}
                onOpen={() => onOpenProject(p.id)}
                onAskAi={onAskAi}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <div style={{ padding: 12, borderTop: '1px solid var(--border)', flexShrink: 0 }}>
        <button
          onClick={() => setCreating(true)}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            padding: '10px 12px', borderRadius: 10, cursor: 'pointer',
            border: '1px solid var(--border-hi)', background: 'var(--bg-input)',
            color: 'var(--text)', fontSize: 13, fontWeight: 600,
          }}
        >
          <Plus size={15} /> {lang.add}
        </button>
      </div>

      {creating && (
        <NewProjectSheet
          language={language}
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); onCreated() }}
        />
      )}
    </div>
  )
}
