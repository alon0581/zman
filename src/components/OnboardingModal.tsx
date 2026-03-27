'use client'

import { useState } from 'react'
import { User } from '@supabase/supabase-js'
import { UserProfile } from '@/types'
import { ChevronRight, X } from 'lucide-react'
import { mapToMethod } from '@/lib/scheduling/methodMapper'

interface Props {
  user: User
  language?: string
  onComplete: (profile: UserProfile) => void
  onSkip: () => void
}

/** Maps UI persona labels → internal persona values */
const PERSONA_MAP_EN: Record<string, string> = {
  'student': 'student', 'professional': 'manager', 'freelancer': 'entrepreneur', 'parent': 'other', 'other': 'other',
}
const PERSONA_MAP_HE: Record<string, string> = {
  'סטודנט': 'student', 'עובד/ת שכיר/ה': 'manager', 'פרילנסר': 'entrepreneur', 'הורה': 'other', 'אחר': 'other',
}

const stepsEn = [
  {
    key: 'occupation',
    question: 'What do you do?',
    options: [
      { label: '🎓 Student', value: 'student' },
      { label: '💼 Professional', value: 'professional' },
      { label: '🚀 Freelancer', value: 'freelancer' },
      { label: '👨‍👩‍👧 Parent', value: 'parent' },
      { label: '🌀 Other', value: 'other' },
    ],
  },
  {
    key: 'challenge',
    question: "What's your biggest challenge?",
    options: [
      { label: '⏳ I procrastinate on tasks', value: 'procrastination' },
      { label: '🌊 I feel overwhelmed and don\'t know what to do first', value: 'overwhelmed' },
      { label: '🎯 I have trouble focusing', value: 'focus' },
      { label: '🔀 I\'m scattered across too many things', value: 'scattered' },
      { label: '🏔️ I lose track of my big goals', value: 'goals' },
    ],
  },
  {
    key: 'day_structure',
    question: 'What does your typical day look like?',
    options: [
      { label: '📋 Fixed schedule — same every day', value: 'fixed' },
      { label: '🎲 Every day is different', value: 'variable' },
      { label: '🔄 Mix of meetings + independent work', value: 'mixed' },
      { label: '🕊️ Mostly independent — I set my own hours', value: 'independent' },
    ],
  },
  {
    key: 'productivity_peak',
    question: 'When are you most productive?',
    options: [
      { label: '🌅 Morning (6am–12pm)', value: 'morning' },
      { label: '☀️ Afternoon (12pm–6pm)', value: 'afternoon' },
      { label: '🌙 Evening (6pm–12am)', value: 'evening' },
    ],
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
    options: [
      { label: '🎓 סטודנט', value: 'סטודנט' },
      { label: '💼 עובד/ת שכיר/ה', value: 'עובד/ת שכיר/ה' },
      { label: '🚀 פרילנסר', value: 'פרילנסר' },
      { label: '👨‍👩‍👧 הורה', value: 'הורה' },
      { label: '🌀 אחר', value: 'אחר' },
    ],
  },
  {
    key: 'challenge',
    question: 'מה האתגר הכי גדול שלך?',
    options: [
      { label: '⏳ אני מדחיין/נת משימות', value: 'procrastination' },
      { label: '🌊 אני מוצף/ת ולא יודע/ת מה קודם', value: 'overwhelmed' },
      { label: '🎯 קשה לי להתרכז', value: 'focus' },
      { label: '🔀 אני מפזר/ת קשב בין הרבה דברים', value: 'scattered' },
      { label: '🏔️ אני לא עוקב/ת אחרי היעדים הגדולים', value: 'goals' },
    ],
  },
  {
    key: 'day_structure',
    question: 'איך נראה היום שלך?',
    options: [
      { label: '📋 לוח זמנים קבוע וצפוי', value: 'fixed' },
      { label: '🎲 כל יום שונה לגמרי', value: 'variable' },
      { label: '🔄 שילוב של פגישות + עבודה עצמאית', value: 'mixed' },
      { label: '🕊️ עיקר הזמן שלי עצמאי לחלוטין', value: 'independent' },
    ],
  },
  {
    key: 'productivity_peak',
    question: 'מתי אתה הכי פרודוקטיבי?',
    options: [
      { label: '🌅 בוקר (6:00–12:00)', value: 'morning' },
      { label: '☀️ צהריים (12:00–18:00)', value: 'afternoon' },
      { label: '🌙 ערב (18:00–00:00)', value: 'evening' },
    ],
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
    // Map UI occupation label → internal persona value
    const personaMap = isHe ? PERSONA_MAP_HE : PERSONA_MAP_EN
    const persona = (personaMap[data.occupation] ?? data.occupation) as UserProfile['persona']
    const challenge = data.challenge as UserProfile['challenge']
    const dayStructure = data.day_structure as UserProfile['day_structure']

    // Determine scheduling method from answers
    const methodResult = mapToMethod(persona ?? 'other', challenge ?? 'overwhelmed', dayStructure ?? 'mixed')

    const updates: Partial<UserProfile> = {
      autonomy_mode: (data.autonomy_mode as UserProfile['autonomy_mode']) ?? 'hybrid',
      productivity_peak: data.productivity_peak as UserProfile['productivity_peak'],
      occupation: data.occupation,
      onboarding_completed: true,
      persona,
      challenge,
      day_structure: dayStructure,
      scheduling_method: methodResult.primary,
      secondary_methods: methodResult.secondary,
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

  const getOptions = () => currentStep.options as Array<{ label: string; value: string }>

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
