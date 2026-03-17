'use client'

import { useState } from 'react'
import { User } from '@supabase/supabase-js'
import { UserProfile } from '@/types'
import { ChevronRight, X } from 'lucide-react'

interface Props {
  user: User
  language?: string
  onComplete: (profile: UserProfile) => void
  onSkip: () => void
}

const stepsEn = [
  {
    key: 'occupation',
    question: 'What do you do?',
    options: ['Student', 'Professional', 'Freelancer', 'Parent', 'Other'],
  },
  {
    key: 'productivity_peak',
    question: 'When are you most productive?',
    options: ['Morning (6am–12pm)', 'Afternoon (12pm–6pm)', 'Evening (6pm–12am)'],
    map: { 'Morning (6am–12pm)': 'morning', 'Afternoon (12pm–6pm)': 'afternoon', 'Evening (6pm–12am)': 'evening' },
  },
  {
    key: 'autonomy_mode',
    question: 'How much should I do automatically?',
    options: [
      { label: 'Suggest — always ask me first', value: 'suggest' },
      { label: 'Hybrid — ask for big changes only (recommended)', value: 'hybrid' },
      { label: 'Auto — just do it, I can undo', value: 'auto' },
    ],
  },
]

const stepsHe = [
  {
    key: 'occupation',
    question: 'מה אתה עושה?',
    options: ['סטודנט', 'עובד/ת שכיר/ה', 'פרילנסר', 'הורה', 'אחר'],
  },
  {
    key: 'productivity_peak',
    question: 'מתי אתה הכי פרודוקטיבי?',
    options: ['בוקר (6:00–12:00)', 'צהריים (12:00–18:00)', 'ערב (18:00–00:00)'],
    map: { 'בוקר (6:00–12:00)': 'morning', 'צהריים (12:00–18:00)': 'afternoon', 'ערב (18:00–00:00)': 'evening' },
  },
  {
    key: 'autonomy_mode',
    question: 'כמה אני אעשה אוטומטית?',
    options: [
      { label: 'הצע — תמיד בקש ממני אישור', value: 'suggest' },
      { label: 'היברידי — שאל רק לשינויים גדולים (מומלץ)', value: 'hybrid' },
      { label: 'אוטומטי — פשוט תעשה, אני יכול לבטל', value: 'auto' },
    ],
  },
]

export default function OnboardingModal({ user: _user, language, onComplete, onSkip }: Props) {
  const isHe = language === 'he'
  const steps = isHe ? stepsHe : stepsEn
  const [step, setStep]       = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [saving, setSaving]   = useState(false)

  const currentStep = steps[step]
  const stepLabel   = isHe ? `שלב ${step + 1} מתוך ${steps.length}` : `Step ${step + 1} of ${steps.length}`
  const skipLabel   = isHe ? 'דלג — אגדיר זאת מאוחר יותר' : "Skip — I'll configure this later"

  const handleAnswer = async (value: string) => {
    const newAnswers = { ...answers, [currentStep.key]: value }
    setAnswers(newAnswers)
    if (step < steps.length - 1) {
      setStep(s => s + 1)
    } else {
      await save(newAnswers)
    }
  }

  const save = async (data: Record<string, string>) => {
    setSaving(true)
    const updates: Partial<UserProfile> = {
      autonomy_mode: (data.autonomy_mode as UserProfile['autonomy_mode']) ?? 'hybrid',
      productivity_peak: data.productivity_peak as UserProfile['productivity_peak'],
      occupation: data.occupation,
      onboarding_completed: true,
    }
    const res = await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    setSaving(false)
    if (res.ok) {
      const updated = await res.json()
      onComplete(updated as UserProfile)
    } else {
      onSkip()
    }
  }

  const getOptions = () => currentStep.options.map(o =>
    typeof o === 'string'
      ? { label: o, value: (currentStep as { map?: Record<string, string> }).map?.[o] ?? o.toLowerCase() }
      : o
  )

  return (
    <div dir={isHe ? 'rtl' : 'ltr'} style={{
      position: 'fixed', inset: 0, zIndex: 50,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16,
      background: 'rgba(0,0,0,0.75)',
      backdropFilter: 'blur(6px)',
    }}>
      <div style={{
        width: '100%', maxWidth: 420,
        background: 'var(--bg-card)',
        border: '1px solid var(--border-hi, var(--border))',
        borderRadius: 24,
        boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        overflow: 'hidden',
      }}>
        {/* Top gradient bar */}
        <div style={{ height: 4, background: 'linear-gradient(90deg,#3B7EF7,#6366F1,#34D399)' }} />

        <div style={{ padding: '24px 24px 20px' }}>
          {/* Header row */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-2)', marginBottom: 8 }}>
                {stepLabel}
              </div>
              {/* Progress dots */}
              <div style={{ display: 'flex', gap: 6 }}>
                {steps.map((_, i) => (
                  <div key={i} style={{
                    height: 4, borderRadius: 4,
                    width: i <= step ? 28 : 10,
                    background: i <= step ? '#3B7EF7' : 'var(--border)',
                    transition: 'width 0.3s ease, background 0.3s ease',
                  }} />
                ))}
              </div>
            </div>
            <button onClick={onSkip} style={{
              background: 'var(--bg-input)', border: 'none', borderRadius: 8,
              width: 32, height: 32, cursor: 'pointer', color: 'var(--text-2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <X size={15} />
            </button>
          </div>

          {/* AI message bubble */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 20 }}>
            <div style={{
              width: 40, height: 40, borderRadius: 12, flexShrink: 0,
              background: 'linear-gradient(135deg,#3B7EF7,#6366F1)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontWeight: 900, fontSize: 16, color: '#fff',
              boxShadow: '0 4px 12px rgba(59,126,247,0.4)',
            }}>Z</div>
            <div style={{
              background: 'var(--bg-input)',
              border: '1px solid var(--border)',
              borderRadius: isHe ? '16px 0 16px 16px' : '0 16px 16px 16px',
              padding: '12px 16px',
              fontSize: 15, fontWeight: 600,
              color: 'var(--text)',
              lineHeight: 1.4,
            }}>
              {currentStep.question}
            </div>
          </div>

          {/* Options */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {getOptions().map(opt => (
              <button
                key={opt.value}
                onClick={() => handleAnswer(opt.value)}
                disabled={saving}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  width: '100%', padding: '13px 16px',
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border)',
                  borderRadius: 12,
                  color: 'var(--text)',
                  fontSize: 14, fontWeight: 500,
                  cursor: saving ? 'not-allowed' : 'pointer',
                  opacity: saving ? 0.6 : 1,
                  textAlign: isHe ? 'right' : 'left',
                  transition: 'border-color 0.15s, background 0.15s',
                }}
                onMouseEnter={e => {
                  if (!saving) {
                    (e.currentTarget as HTMLElement).style.borderColor = '#3B7EF7'
                    ;(e.currentTarget as HTMLElement).style.background = 'rgba(59,126,247,0.07)'
                  }
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'
                  ;(e.currentTarget as HTMLElement).style.background = 'var(--bg-input)'
                }}
              >
                <span>{opt.label}</span>
                <ChevronRight size={16} style={{ color: 'var(--text-2)', flexShrink: 0 }} />
              </button>
            ))}
          </div>

          {/* Skip */}
          <button onClick={onSkip} style={{
            width: '100%', marginTop: 14, padding: '8px 0',
            background: 'none', border: 'none',
            color: 'var(--text-2)', fontSize: 12,
            cursor: 'pointer', textAlign: 'center',
          }}>
            {skipLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
