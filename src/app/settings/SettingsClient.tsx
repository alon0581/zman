'use client'

import { useState, useEffect } from 'react'
import { User } from '@supabase/supabase-js'
import { UserProfile, AIMemory } from '@/types'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, X, Check } from 'lucide-react'
import Link from 'next/link'

interface Props {
  user: User
  profile: UserProfile | null
  onClose?: () => void
  onProfileUpdate?: (p: UserProfile) => void
}

// ─── i18n ────────────────────────────────────────────────────────────────────

const LANGS: Record<string, Record<string, string>> = {
  en: {
    title: 'Settings', subtitle: 'Customize your experience',
    aiModelSection: 'AI Model',
    connectBtn: 'Connect →', connectedLabel: 'Connected',
    disconnectBtn: 'Disconnect',
    openrouterDesc: 'One account · access GPT-4o, Claude, MiniMax & 100+ models',
    openaiDesc: 'Paste your API key from platform.openai.com',
    anthropicDesc: 'Paste your API key from console.anthropic.com',
    minimaxDesc: 'Log in with your MiniMax account',
    modelLabel: 'Model', modelDesc: 'Active language model',
    wizardTitle: 'Connect', wizardStep1: 'Step 1 — Open your API keys page:',
    wizardStep2: 'Step 2 — Create a key and paste it here:',
    wizardKeyPlaceholder: 'Paste API key…',
    verifyBtn: 'Verify', verifyingBtn: 'Verifying…',
    cancelBtn: 'Cancel', saveConnectBtn: 'Save & Connect',
    aiSection: 'AI Behavior', autonomyLabel: 'Autonomy Mode',
    autonomyDesc: 'How independently should Zman act?',
    voiceLabel: 'Voice Responses', voiceDesc: 'Read AI replies aloud',
    langLabel: 'Language', langDesc: 'AI response language',
    appearSection: 'Appearance', themeLabel: 'Theme',
    micSideLabel: 'Mic Button Side', micSideLeft: '← Left', micSideRight: 'Right →',
    schedSection: 'Schedule', peakLabel: 'Peak Productivity',
    peakDesc: 'When do you work best?',
    wakeLabel: 'Wake Time', sleepLabel: 'Sleep Time',
    accountSection: 'Account', signOutBtn: 'Sign Out',
    saveBtn: 'Save Settings', savedBtn: 'Saved!', savingBtn: 'Saving…',
    memorySection: 'AI Memory', memoryDesc: 'What the AI remembers about you',
    memoryEmpty: 'Nothing saved yet — the AI will learn as you chat.',
    memoryClearAll: 'Clear all', memoryClearConfirm: 'Clear all memory? This cannot be undone.',
  },
  he: {
    title: 'הגדרות', subtitle: 'התאם אישית את החוויה שלך',
    aiModelSection: 'מודל AI',
    connectBtn: '← חבר', connectedLabel: 'מחובר',
    disconnectBtn: 'נתק',
    openrouterDesc: 'חשבון אחד · גישה ל-GPT-4o, Claude, MiniMax ו-100+ מודלים',
    openaiDesc: 'הדבק מפתח API מ-platform.openai.com',
    anthropicDesc: 'הדבק מפתח API מ-console.anthropic.com',
    minimaxDesc: 'התחבר עם חשבון MiniMax שלך',
    modelLabel: 'מודל', modelDesc: 'מודל השפה הפעיל',
    wizardTitle: 'חבר', wizardStep1: 'שלב 1 — פתח את עמוד מפתחות ה-API שלך:',
    wizardStep2: 'שלב 2 — צור מפתח והדבק אותו כאן:',
    wizardKeyPlaceholder: 'הדבק מפתח API…',
    verifyBtn: 'אמת', verifyingBtn: '…מאמת',
    cancelBtn: 'ביטול', saveConnectBtn: 'שמור וחבר',
    aiSection: 'התנהגות AI', autonomyLabel: 'מצב אוטונומיה',
    autonomyDesc: 'כמה עצמאי יפעל זמן?',
    voiceLabel: 'תגובות קוליות', voiceDesc: 'קרא תגובות AI בקול רם',
    langLabel: 'שפה', langDesc: 'שפת תגובות ה-AI',
    appearSection: 'מראה', themeLabel: 'ערכת נושא',
    micSideLabel: 'צד כפתור מיק', micSideLeft: '← שמאל', micSideRight: 'ימין →',
    schedSection: 'לוח זמנים', peakLabel: 'שעות שיא',
    peakDesc: 'מתי אתה עובד הכי טוב?',
    wakeLabel: 'שעת קימה', sleepLabel: 'שעת שינה',
    accountSection: 'חשבון', signOutBtn: 'יציאה',
    saveBtn: 'שמור הגדרות', savedBtn: '!נשמר', savingBtn: '…שומר',
    memorySection: 'זיכרון AI', memoryDesc: 'מה ה-AI זוכר עליך',
    memoryEmpty: 'עדיין לא נשמר כלום — ה-AI ילמד תוך כדי שיחה.',
    memoryClearAll: 'נקה הכל', memoryClearConfirm: 'למחוק את כל הזיכרון? לא ניתן לשחזר.',
  },
}

const MEMORY_SOURCE_LABELS: Record<string, Record<string, string>> = {
  en: { onboarding: 'setup', behavior: 'learned', explicit: 'told' },
  he: { onboarding: 'הגדרות', behavior: 'למד', explicit: 'נאמר' },
}

function t(lang: string, key: string) { return (LANGS[lang] ?? LANGS.en)[key] ?? key }

// ─── Component ────────────────────────────────────────────────────────────────

export default function SettingsClient({ user, profile: init, onClose, onProfileUpdate }: Props) {
  const [p, setP] = useState<UserProfile>(init ?? {
    user_id: user.id, autonomy_mode: 'hybrid', theme: 'dark',
    voice_response_enabled: false, language: 'en', onboarding_completed: false,
  })
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)


  // Memory state
  const [memory, setMemory] = useState<AIMemory[]>([])
  const [deletingMemKey, setDeletingMemKey] = useState<string | null>(null)

  const supabase = createClient()
  const lang = p.language ?? 'en'
  const isRTL = lang === 'he' || lang === 'ar'
  const set = (k: keyof UserProfile, v: unknown) => setP(prev => ({ ...prev, [k]: v }))
  const isLocalMode = !process.env.NEXT_PUBLIC_SUPABASE_URL?.startsWith('http')

  // Load memory on mount
  useEffect(() => {
    fetch('/api/memory').then(r => r.ok ? r.json() : []).then((m: AIMemory[]) => {
      if (Array.isArray(m)) setMemory(m)
    }).catch(() => {/* ignore */})
  }, [])

  const save = async () => {
    setSaving(true)
    if (isLocalMode) {
      await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(p),
      })
    } else {
      await supabase.from('user_profiles').upsert({ ...p, user_id: user.id })
    }
    setSaving(false)
    if (onClose) {
      onProfileUpdate?.(p as UserProfile)
      onClose()
    } else {
      window.location.replace('/')
    }
  }

  const selectStyle: React.CSSProperties = {
    background: 'var(--bg-input)', border: '1px solid var(--border-hi)',
    color: 'var(--text)', borderRadius: 10, padding: '8px 12px',
    fontSize: 13, outline: 'none', cursor: 'pointer',
  }

  const inner = (
    <div dir={isRTL ? 'rtl' : 'ltr'} style={{ background: 'var(--bg)', color: 'var(--text)', fontFamily: 'var(--font-inter, system-ui, sans-serif)', ...(onClose ? {} : { minHeight: '100vh' }) }}>

      {/* Top bar */}
      <div style={{ background: 'var(--bg-panel)', borderBottom: '1px solid var(--border)', padding: '0 20px', height: 56, display: 'flex', alignItems: 'center', gap: 12 }}>
        {onClose ? (
          <button onClick={onClose} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 10, background: 'var(--border)', color: 'var(--text-2)', border: 'none', cursor: 'pointer' }}>
            <X size={16} />
          </button>
        ) : (
          <Link href="/" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 10, background: 'var(--border)', color: 'var(--text-2)', textDecoration: 'none' }}>
            <ArrowLeft size={16} style={{ transform: isRTL ? 'scaleX(-1)' : undefined }} />
          </Link>
        )}
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: '-0.02em' }}>{t(lang, 'title')}</div>
          <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 1 }}>{t(lang, 'subtitle')}</div>
        </div>
      </div>

      {/* Content */}
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '24px 20px 40px' }}>

        {/* ── AI BEHAVIOR ── */}
        <Card label={t(lang, 'aiSection')}>
          <Row label={t(lang, 'autonomyLabel')} desc={t(lang, 'autonomyDesc')}>
            <SegmentedControl
              options={[
                { value: 'suggest', label: lang === 'he' ? 'הצע' : 'Suggest' },
                { value: 'hybrid',  label: lang === 'he' ? 'היברידי' : 'Hybrid' },
                { value: 'auto',    label: lang === 'he' ? 'אוטו' : 'Auto' },
              ]}
              value={p.autonomy_mode}
              onChange={v => set('autonomy_mode', v)}
            />
          </Row>
          <Row label={t(lang, 'voiceLabel')} desc={t(lang, 'voiceDesc')}>
            <Toggle value={p.voice_response_enabled} onChange={v => set('voice_response_enabled', v)} />
          </Row>
          <Row label={t(lang, 'langLabel')} desc={t(lang, 'langDesc')}>
            <select value={p.language} onChange={e => set('language', e.target.value)} style={selectStyle}>
              <option value="en">English</option>
              <option value="he">עברית (Hebrew)</option>
              <option value="es">Español</option>
              <option value="fr">Français</option>
              <option value="de">Deutsch</option>
              <option value="ar">العربية</option>
            </select>
          </Row>
        </Card>

        {/* ── APPEARANCE ── */}
        <Card label={t(lang, 'appearSection')}>
          <Row label={t(lang, 'themeLabel')} desc="">
            <SegmentedControl
              options={[
                { value: 'dark',  label: lang === 'he' ? '🌙 כהה'  : '🌙 Dark' },
                { value: 'light', label: lang === 'he' ? '☀️ בהיר' : '☀️ Light' },
              ]}
              value={p.theme}
              onChange={v => set('theme', v)}
            />
          </Row>
          <Row label={t(lang, 'micSideLabel')} desc="">
            <SegmentedControl
              options={[
                { value: 'right', label: t(lang, 'micSideRight') },
                { value: 'left',  label: t(lang, 'micSideLeft') },
              ]}
              value={p.mic_position ?? 'right'}
              onChange={v => set('mic_position', v)}
            />
          </Row>
        </Card>

        {/* ── SCHEDULE ── */}
        <Card label={t(lang, 'schedSection')}>
          <Row label={t(lang, 'peakLabel')} desc={t(lang, 'peakDesc')}>
            <SegmentedControl
              options={[
                { value: 'morning',   label: lang === 'he' ? 'בוקר'   : '🌅 Morning' },
                { value: 'afternoon', label: lang === 'he' ? 'צהריים' : '☀️ Noon' },
                { value: 'evening',   label: lang === 'he' ? 'ערב'     : '🌆 Evening' },
              ]}
              value={p.productivity_peak ?? 'morning'}
              onChange={v => set('productivity_peak', v)}
            />
          </Row>
          <Row label={t(lang, 'wakeLabel')} desc="">
            <input type="time" value={p.wake_time ?? '07:00'} onChange={e => set('wake_time', e.target.value)}
              style={{ ...selectStyle }} />
          </Row>
          <Row label={t(lang, 'sleepLabel')} desc="">
            <input type="time" value={p.sleep_time ?? '23:00'} onChange={e => set('sleep_time', e.target.value)}
              style={{ ...selectStyle }} />
          </Row>
        </Card>

        {/* ── MEMORY ── */}
        <Card label={t(lang, 'memorySection')}>
          <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 12 }}>{t(lang, 'memoryDesc')}</div>
          {memory.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-2)', fontStyle: 'italic', padding: '8px 0' }}>
              {t(lang, 'memoryEmpty')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {memory.map(m => {
                const sourceLabels = MEMORY_SOURCE_LABELS[lang] ?? MEMORY_SOURCE_LABELS.en
                const srcLabel = sourceLabels[m.learned_from] ?? m.learned_from
                return (
                  <div key={m.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 10, background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                    <span style={{ fontFamily: 'monospace', fontSize: 11, fontWeight: 700, color: 'var(--blue)', background: 'rgba(59,126,247,0.1)', padding: '2px 6px', borderRadius: 5, flexShrink: 0 }}>{m.key}</span>
                    <span style={{ fontSize: 13, color: 'var(--text)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.value}</span>
                    <span style={{ fontSize: 10, color: 'var(--text-2)', flexShrink: 0 }}>{srcLabel}</span>
                    <button
                      onClick={async () => {
                        setDeletingMemKey(m.key)
                        await fetch('/api/memory', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: [m.key] }) })
                        setMemory(prev => prev.filter(x => x.key !== m.key))
                        setDeletingMemKey(null)
                      }}
                      disabled={deletingMemKey === m.key}
                      style={{ flexShrink: 0, width: 22, height: 22, borderRadius: 6, border: 'none', background: 'rgba(255,100,100,0.15)', color: '#F87171', cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: deletingMemKey === m.key ? 0.5 : 1 }}
                    >×</button>
                  </div>
                )
              })}
              <button
                onClick={async () => {
                  if (!window.confirm(t(lang, 'memoryClearConfirm'))) return
                  await fetch('/api/memory', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }) })
                  setMemory([])
                }}
                style={{ marginTop: 4, padding: '8px 14px', borderRadius: 10, border: '1px solid rgba(248,113,113,0.3)', background: 'rgba(248,113,113,0.08)', color: '#F87171', fontSize: 12, cursor: 'pointer', alignSelf: 'flex-start' }}
              >
                🗑 {t(lang, 'memoryClearAll')}
              </button>
            </div>
          )}
        </Card>

        {/* ── ACCOUNT ── */}
        <Card label={t(lang, 'accountSection')}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '4px 0 12px' }}>
            {user.user_metadata?.avatar_url
              ? <img src={user.user_metadata.avatar_url} style={{ width: 44, height: 44, borderRadius: '50%' }} alt="" />
              : <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'linear-gradient(135deg, #3B7EF7, #6366F1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 18, color: '#fff' }}>
                  {(user.email?.[0] ?? 'U').toUpperCase()}
                </div>
            }
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{user.user_metadata?.full_name ?? user.email}</div>
              <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>{user.email}</div>
            </div>
          </div>
          <button
            onClick={async () => {
              await fetch('/api/auth/logout', { method: 'POST' })
              try { await supabase.auth.signOut() } catch { /* local mode */ }
              window.location.href = '/login'
            }}
            style={{ width: '100%', padding: '11px 16px', borderRadius: 12, background: 'var(--bg-input)', border: '1px solid var(--border-hi)', color: 'var(--text)', fontSize: 14, fontWeight: 500, cursor: 'pointer', marginBottom: 8 }}
          >
            {t(lang, 'signOutBtn')}
          </button>
        </Card>

        {/* ── SAVE ── */}
        <button
          onClick={save}
          disabled={saving}
          style={{
            width: '100%', padding: '14px', borderRadius: 14, border: 'none',
            background: saved ? 'rgba(52,211,153,0.15)' : 'linear-gradient(135deg, #3B7EF7, #6366F1)',
            color: saved ? '#34D399' : '#fff',
            fontSize: 15, fontWeight: 700, cursor: saving ? 'default' : 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            boxShadow: saved ? 'none' : '0 4px 20px rgba(59,126,247,0.4)',
            opacity: saving ? 0.7 : 1,
            outline: saved ? '1px solid rgba(52,211,153,0.3)' : 'none',
          }}
        >
          {saved ? <><Check size={16} /> {t(lang, 'savedBtn')}</> : saving ? t(lang, 'savingBtn') : t(lang, 'saveBtn')}
        </button>
      </div>

    </div>
  )

  if (onClose) {
    return (
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', overflowY: 'auto', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: '32px 16px 48px' }}
        onClick={e => { if (e.target === e.currentTarget) onClose() }}
      >
        <div style={{ width: '100%', maxWidth: 620, borderRadius: 20, overflow: 'hidden', border: '1px solid var(--border-hi)', boxShadow: 'var(--shadow-xl)' }}>
          {inner}
        </div>
      </div>
    )
  }
  return inner
}

/* ─── Sub-components ─── */

function SectionLabel({ label }: { label: string }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-2)', marginBottom: 8, paddingLeft: 4 }}>
      {label}
    </div>
  )
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <SectionLabel label={label} />
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  )
}

function Row({ label, desc, children }: { label: string; desc: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20, padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
      <div style={{ flex: '0 1 auto', minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)', whiteSpace: 'nowrap' }}>{label}</div>
        {desc && <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>{desc}</div>}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  )
}

function SegmentedControl({ options, value, onChange }: {
  options: { value: string; label: string }[]
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div style={{ display: 'flex', background: 'var(--bg-panel)', borderRadius: 10, padding: 3, gap: 2, border: '1px solid var(--border)' }}>
      {options.map(opt => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          style={{
            padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
            background: value === opt.value ? 'linear-gradient(135deg, #3B7EF7, #6366F1)' : 'transparent',
            color: value === opt.value ? '#fff' : 'var(--text-2)',
            boxShadow: value === opt.value ? '0 2px 8px rgba(59,126,247,0.4)' : 'none',
            transition: 'all var(--t-base)',
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      style={{
        width: 48, height: 26, borderRadius: 13, border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0,
        background: value ? 'linear-gradient(135deg, #3B7EF7, #6366F1)' : 'var(--bg-input)',
        boxShadow: value ? '0 2px 10px rgba(59,126,247,0.4)' : 'inset 0 1px 3px rgba(0,0,0,0.3)',
        transition: 'all 0.2s',
      }}
    >
      <span style={{
        position: 'absolute', top: 3, width: 20, height: 20, borderRadius: '50%', background: '#fff',
        boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
        transition: 'left 0.2s',
        left: value ? 25 : 3,
      }} />
    </button>
  )
}
