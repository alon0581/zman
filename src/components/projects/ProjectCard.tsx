'use client'

import { Project } from '@/types'
import { CardSignal, ResolvedSignal, SignalState } from '@/lib/projects/types'
import { KIND_RULES } from '@/lib/projects/types'

/**
 * One project card, four signals.
 *
 * The layout is FIXED and the emphasis moves: signals arrive already ordered by
 * the user's method (signalOrder[0] is the headline) and with `na` ones already
 * dropped, so this component never decides what matters — it only draws it. It
 * also never phrases anything: every string comes from `signal.text`, because the
 * sentences are data produced by the engine, not narration invented by the UI.
 */

const STATE_COLOR: Record<SignalState, string> = {
  ok: 'var(--green)',
  warn: 'var(--yellow)',
  risk: 'var(--red)',
  unknown: 'var(--text-3)',
  na: 'var(--text-3)',
}

const STATE_LABEL: Record<SignalState, { he: string; en: string }> = {
  ok: { he: 'בזמן', en: 'On track' },
  warn: { he: 'צפוף', en: 'Tight' },
  risk: { he: 'בסיכון', en: 'At risk' },
  unknown: { he: 'חסר מידע', en: 'Unknown' },
  na: { he: '', en: '' },
}

export interface ProjectCardProps {
  project: Project
  signals: ResolvedSignal[]
  language?: string
  onOpen?: () => void
  onAskAi?: (message: string) => void
}

export default function ProjectCard({ project, signals, language = 'en', onOpen, onAskAi }: ProjectCardProps) {
  const isHe = language === 'he'
  const t = (s: ResolvedSignal) => (isHe ? s.text.he : s.text.en)

  const deadline = signals.find(s => s.signal === 'deadline')
  const rest = signals.filter(s => s.signal !== 'deadline')
  const kind = KIND_RULES[project.kind]

  return (
    <div
      onClick={onOpen}
      style={{
        border: '1px solid var(--border)',
        borderRadius: 12,
        background: 'var(--bg-card)',
        padding: '12px 13px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        cursor: onOpen ? 'pointer' : 'default',
        direction: isHe ? 'rtl' : 'ltr',
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-hi)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)' }}
    >
      {/* Title row — the risk chip is the only coloured thing, so a healthy board
          stays calm and a red one is unmissable. Absent when there is no deadline:
          a project with no date is not "at risk", and a grey badge would imply a
          judgement nobody made. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 15 }}>{kind.emoji}</span>
        <span style={{
          flex: 1, fontWeight: 650, fontSize: 14, color: 'var(--text)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {project.title}
        </span>
        {deadline && <HealthChip state={deadline.state} isHe={isHe} />}
      </div>

      {/* The signals, in the order the method asked for. */}
      {deadline && (
        <SignalLine text={t(deadline)} state={deadline.state} lead onAsk={
          deadline.state === 'unknown' && onAskAi
            ? () => onAskAi(isHe
                ? `תעריך לי כמה זמן ייקח כל שלב בפרויקט "${project.title}"`
                : `Estimate how long each step of "${project.title}" will take`)
            : undefined
        } />
      )}
      {rest.map(s => (
        <SignalLine key={s.signal} text={t(s)} state={s.state} lead={!deadline && s === rest[0]} />
      ))}
    </div>
  )
}

function HealthChip({ state, isHe }: { state: SignalState; isHe: boolean }) {
  const color = STATE_COLOR[state]
  const label = isHe ? STATE_LABEL[state].he : STATE_LABEL[state].en
  return (
    // A dot AND a word, never colour alone — colour-only fails for colour-blind
    // users and for anyone who has forgotten what amber meant.
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      background: `${cssVarFallback(state)}18`,
      border: `1px solid ${cssVarFallback(state)}40`,
      color, borderRadius: 999, padding: '2px 8px',
      fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, display: 'inline-block' }} />
      {label}
    </span>
  )
}

function SignalLine({ text, state, lead, onAsk }: {
  text: string; state: SignalState; lead?: boolean; onAsk?: () => void
}) {
  if (!text) return null
  return (
    <div style={{
      fontSize: lead ? 13 : 12,
      fontWeight: lead ? 600 : 400,
      color: lead ? 'var(--text)' : 'var(--text-2)',
      display: 'flex', alignItems: 'center', gap: 6,
    }}>
      <span style={{ flex: 1 }}>{text}</span>
      {onAsk && (
        <button
          onClick={e => { e.stopPropagation(); onAsk() }}
          style={{
            border: '1px solid var(--border-hi)', background: 'transparent',
            color: 'var(--text-2)', borderRadius: 6, width: 20, height: 20,
            fontSize: 11, cursor: 'pointer', flexShrink: 0, lineHeight: 1,
          }}
        >?</button>
      )}
      {state === 'unknown' && !onAsk && <span style={{ color: 'var(--text-3)' }}>?</span>}
    </div>
  )
}

/** Tailwind-free tint helper: the tokens are hex, so `${hex}18` is a valid 8-digit colour. */
function cssVarFallback(state: SignalState): string {
  switch (state) {
    case 'ok': return '#34D399'
    case 'warn': return '#FBBF24'
    case 'risk': return '#F87171'
    default: return '#525258'
  }
}

export type { CardSignal }
