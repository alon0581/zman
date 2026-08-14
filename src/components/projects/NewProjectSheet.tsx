'use client'

import { useState } from 'react'
import { motion } from 'motion/react'
import { ProjectKind } from '@/types'
import { KIND_RULES } from '@/lib/projects/types'

/**
 * Creating a project asks for the kind explicitly, and that is deliberate.
 *
 * The kind decides whether a deadline is expected — which decides whether the risk
 * badge means anything at all — so it must be an answer, not an inference. A
 * profile field guessed once during onboarding, with no UI to correct it, is not
 * a safe place to put that decision.
 */

const KINDS: ProjectKind[] = ['course', 'deliverable', 'build']

const T = {
  en: { title: 'New project', name: 'Name', deadline: 'Deadline', seed: 'Start with the usual steps', create: 'Create', cancel: 'Cancel', optional: 'optional' },
  he: { title: 'פרויקט חדש', name: 'שם', deadline: 'תאריך יעד', seed: 'התחל עם השלבים הרגילים', create: 'צור', cancel: 'ביטול', optional: 'לא חובה' },
}

interface Props {
  language?: string
  onClose: () => void
  onCreated: () => void
}

export default function NewProjectSheet({ language = 'en', onClose, onCreated }: Props) {
  const isHe = language === 'he'
  const lang = T[language as keyof typeof T] ?? T.en

  const [kind, setKind] = useState<ProjectKind>('build')
  const [title, setTitle] = useState('')
  const [deadline, setDeadline] = useState('')
  const [seed, setSeed] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const expectsDeadline = KIND_RULES[kind].expectsDeadline

  const submit = async () => {
    if (!title.trim() || saving) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          kind,
          deadline: deadline || undefined,
          seed_template: seed,
        }),
      })
      // Check res.ok — the whole client used to update state regardless, so a 401
      // looked exactly like success until the next poll silently reverted it.
      if (!res.ok) throw new Error('create_failed')
      onCreated()
    } catch {
      setError(isHe ? 'יצירת הפרויקט נכשלה.' : 'Could not create the project.')
      setSaving(false)
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 70,
        background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <motion.div
        onClick={e => e.stopPropagation()}
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 320, damping: 28 }}
        style={{
          width: '100%', maxWidth: 380, background: 'var(--bg-panel)',
          border: '1px solid var(--border)', borderRadius: 18, padding: 18,
          display: 'flex', flexDirection: 'column', gap: 14,
          direction: isHe ? 'rtl' : 'ltr',
        }}
      >
        <div style={{ fontSize: 17, fontWeight: 750, color: 'var(--text)' }}>{lang.title}</div>

        <div style={{ display: 'flex', gap: 6 }}>
          {KINDS.map(k => {
            const active = k === kind
            return (
              <button
                key={k}
                onClick={() => setKind(k)}
                style={{
                  flex: 1, padding: '9px 4px', borderRadius: 10, cursor: 'pointer',
                  border: `1px solid ${active ? 'var(--blue)' : 'var(--border)'}`,
                  background: active ? 'rgba(59,126,247,0.12)' : 'var(--bg-card)',
                  color: active ? 'var(--text)' : 'var(--text-2)',
                  fontSize: 12, fontWeight: active ? 650 : 500,
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                }}
              >
                <span style={{ fontSize: 16 }}>{KIND_RULES[k].emoji}</span>
                {isHe ? KIND_RULES[k].label.he : KIND_RULES[k].label.en}
              </button>
            )
          })}
        </div>

        <Field label={lang.name}>
          <input
            autoFocus
            value={title}
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit() }}
            style={inputStyle}
          />
        </Field>

        <Field label={`${lang.deadline}${expectsDeadline ? '' : ` (${lang.optional})`}`}>
          <input type="date" value={deadline} onChange={e => setDeadline(e.target.value)} style={inputStyle} />
        </Field>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-2)', cursor: 'pointer' }}>
          <input type="checkbox" checked={seed} onChange={e => setSeed(e.target.checked)} />
          {lang.seed}
        </label>

        {error && <div style={{ color: 'var(--red)', fontSize: 12 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
          <button onClick={onClose} style={{ ...btnStyle, background: 'var(--bg-input)', color: 'var(--text-2)' }}>
            {lang.cancel}
          </button>
          <button
            onClick={submit}
            disabled={!title.trim() || saving}
            style={{
              ...btnStyle,
              background: title.trim() ? 'var(--blue)' : 'var(--bg-input)',
              color: title.trim() ? '#fff' : 'var(--text-3)',
              cursor: title.trim() && !saving ? 'pointer' : 'default',
            }}
          >
            {lang.create}
          </button>
        </div>
      </motion.div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 11px', borderRadius: 9,
  border: '1px solid var(--border)', background: 'var(--bg-input)',
  color: 'var(--text)', fontSize: 13, outline: 'none',
}

const btnStyle: React.CSSProperties = {
  flex: 1, padding: '10px 12px', borderRadius: 10, border: 'none',
  fontSize: 13, fontWeight: 650, cursor: 'pointer',
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={{ fontSize: 11, color: 'var(--text-2)', fontWeight: 600 }}>{label}</span>
      {children}
    </div>
  )
}
