'use client'

import { useState, useEffect } from 'react'
import { User } from '@supabase/supabase-js'
import { UserProfile, AIMemory } from '@/types'
import { createClient } from '@/lib/supabase/client'
import {
  ArrowLeft, Check, Loader2, CheckCircle2, XCircle,
  ExternalLink, Unlink, Zap,
} from 'lucide-react'
import Link from 'next/link'

interface Props {
  user: User
  profile: UserProfile | null
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

// ─── Model options per provider ───────────────────────────────────────────────

const MODEL_OPTIONS: Record<string, { value: string; label: string }[]> = {
  openai: [
    { value: 'gpt-4o',       label: 'GPT-4o' },
    { value: 'gpt-4o-mini',  label: 'GPT-4o mini' },
    { value: 'gpt-4.1',      label: 'GPT-4.1' },
    { value: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
  ],
  anthropic: [
    { value: 'claude-sonnet-4-20250514',  label: 'Claude Sonnet 4' },
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  ],
  minimax: [
    { value: 'MiniMax-M2.5', label: 'MiniMax M2.5 ⚡' },
    { value: 'MiniMax-M1',   label: 'MiniMax M1' },
  ],
  openrouter: [
    { value: 'openai/gpt-4o',             label: 'GPT-4o (via OpenRouter)' },
    { value: 'openai/gpt-4o-mini',        label: 'GPT-4o mini (via OpenRouter)' },
    { value: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4 (via OpenRouter)' },
    { value: 'anthropic/claude-haiku-4',  label: 'Claude Haiku 4 (via OpenRouter)' },
    { value: 'minimax/minimax-m1',        label: 'MiniMax M1 (via OpenRouter)' },
    { value: 'google/gemini-2.0-flash-001', label: 'Gemini 2.0 Flash (via OpenRouter)' },
  ],
}

// ─── Provider metadata ────────────────────────────────────────────────────────

interface ProviderInfo {
  id: 'openai' | 'anthropic' | 'minimax' | 'openrouter'
  name: string
  logo: string
  oauthPath?: string   // if set → direct OAuth redirect
  keyUrl?: string      // if set → wizard with link to API keys page
  descKey: string
  recommended?: boolean
}

const PROVIDERS: ProviderInfo[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    logo: '🔀',
    oauthPath: '/api/auth/oauth/openrouter',
    descKey: 'openrouterDesc',
    recommended: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    logo: '⚡',
    keyUrl: 'https://platform.openai.com/api-keys',
    descKey: 'openaiDesc',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    logo: '🤖',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    descKey: 'anthropicDesc',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    logo: '🌊',
    oauthPath: '/api/auth/oauth/minimax',
    descKey: 'minimaxDesc',
  },
]

// ─── Component ────────────────────────────────────────────────────────────────

export default function SettingsClient({ user, profile: init }: Props) {
  const [p, setP] = useState<UserProfile>(init ?? {
    user_id: user.id, autonomy_mode: 'hybrid', theme: 'dark',
    voice_response_enabled: false, language: 'en', onboarding_completed: false,
  })
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  // AI Model state
  const [activeProvider, setActiveProvider] = useState<string | undefined>(init?.ai_provider)
  const [activeModel, setActiveModel] = useState<string>(init?.ai_model ?? 'gpt-4o-mini')
  const [maskedKey] = useState<string>(init?.ai_api_key_masked ?? '')

  // Wizard modal state (for API-key providers: openai, anthropic)
  const [wizardProvider, setWizardProvider] = useState<ProviderInfo | null>(null)
  const [wizardKey, setWizardKey] = useState('')
  const [verifyState, setVerifyState] = useState<'idle' | 'verifying' | 'ok' | 'fail'>('idle')
  const [verifyError, setVerifyError] = useState('')

  // OAuth result banner (from URL params after redirect)
  const [oauthBanner, setOauthBanner] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)

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

  // Read OAuth result from URL on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const success = params.get('oauth_success')
    const error = params.get('oauth_error')
    if (success) {
      setOauthBanner({ type: 'success', msg: `✅ ${success.charAt(0).toUpperCase() + success.slice(1)} connected successfully!` })
      // Reload profile to get the updated provider/masked key
      fetch('/api/profile').then(r => r.json()).then((freshProfile: UserProfile) => {
        setActiveProvider(freshProfile.ai_provider)
        setActiveModel(freshProfile.ai_model ?? MODEL_OPTIONS[freshProfile.ai_provider ?? 'openai']?.[0]?.value ?? 'gpt-4o-mini')
      }).catch(() => {/* ignore */})
      // Clean the URL
      window.history.replaceState({}, '', '/settings')
    } else if (error) {
      setOauthBanner({ type: 'error', msg: `❌ Connection failed: ${decodeURIComponent(error)}` })
      window.history.replaceState({}, '', '/settings')
    }
  }, [])

  const handleConnect = (info: ProviderInfo) => {
    if (info.oauthPath) {
      // Direct OAuth redirect
      window.location.href = info.oauthPath
    } else {
      // Open wizard
      setWizardProvider(info)
      setWizardKey('')
      setVerifyState('idle')
      setVerifyError('')
    }
  }

  const handleDisconnect = async () => {
    const update: Partial<UserProfile> = {
      ai_provider: undefined,
      ai_model: undefined,
      ai_api_key_masked: undefined,
      // Note: ai_api_key_encrypted is cleared server-side when ai_api_key_encrypted is omitted
    }
    if (isLocalMode) {
      await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...p, ...update, ai_api_key_clear: true }),
      })
    } else {
      await supabase.from('user_profiles').upsert({ ...p, ...update, user_id: user.id })
    }
    setActiveProvider(undefined)
    setActiveModel('gpt-4o-mini')
  }

  const verifyWizardKey = async () => {
    if (!wizardKey.trim() || !wizardProvider) return
    setVerifyState('verifying')
    setVerifyError('')
    const model = MODEL_OPTIONS[wizardProvider.id]?.[0]?.value ?? ''
    try {
      const res = await fetch('/api/ai-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: wizardProvider.id, model, api_key: wizardKey }),
      })
      const data = await res.json() as { success: boolean; error?: string }
      if (data.success) {
        setVerifyState('ok')
      } else {
        setVerifyState('fail')
        setVerifyError(data.error ?? 'Verification failed')
      }
    } catch {
      setVerifyState('fail')
      setVerifyError('Network error')
    }
  }

  const saveWizardKey = async () => {
    if (!wizardProvider || !wizardKey.trim()) return
    const defaultModel = MODEL_OPTIONS[wizardProvider.id]?.[0]?.value ?? ''
    const profileUpdate = {
      ...p,
      ai_provider: wizardProvider.id,
      ai_model: defaultModel,
      ai_api_key: wizardKey,
    }
    if (isLocalMode) {
      await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profileUpdate),
      })
    } else {
      await supabase.from('user_profiles').upsert({ ...profileUpdate, user_id: user.id })
    }
    setActiveProvider(wizardProvider.id)
    setActiveModel(defaultModel)
    setWizardProvider(null)
    setWizardKey('')
  }

  const save = async () => {
    setSaving(true)
    const profileToSave = { ...p, ai_provider: activeProvider, ai_model: activeModel }
    if (isLocalMode) {
      await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profileToSave),
      })
    } else {
      await supabase.from('user_profiles').upsert({ ...profileToSave, user_id: user.id })
    }
    setSaving(false)
    window.location.replace('/')
  }

  const selectStyle = {
    background: '#1A2030', border: '1px solid rgba(255,255,255,0.1)',
    color: '#EDF0F7', borderRadius: 10, padding: '8px 12px',
    fontSize: 13, outline: 'none', cursor: 'pointer',
  }

  return (
    <div dir={isRTL ? 'rtl' : 'ltr'} style={{ minHeight: '100vh', background: '#07090F', color: '#EDF0F7', fontFamily: 'var(--font-inter, system-ui, sans-serif)' }}>

      {/* Top bar */}
      <div style={{ background: '#0C1018', borderBottom: '1px solid rgba(255,255,255,0.08)', padding: '0 20px', height: 56, display: 'flex', alignItems: 'center', gap: 12 }}>
        <Link href="/" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 10, background: 'rgba(255,255,255,0.05)', color: '#9AA3B8', textDecoration: 'none' }}>
          <ArrowLeft size={16} style={{ transform: isRTL ? 'scaleX(-1)' : undefined }} />
        </Link>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: '-0.02em' }}>{t(lang, 'title')}</div>
          <div style={{ fontSize: 12, color: '#5A6A8A', marginTop: 1 }}>{t(lang, 'subtitle')}</div>
        </div>
      </div>

      {/* Content */}
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '24px 20px 40px' }}>

        {/* OAuth result banner */}
        {oauthBanner && (
          <div style={{
            marginBottom: 16, padding: '12px 16px', borderRadius: 12,
            background: oauthBanner.type === 'success' ? 'rgba(52,211,153,0.1)' : 'rgba(248,113,113,0.1)',
            border: `1px solid ${oauthBanner.type === 'success' ? 'rgba(52,211,153,0.3)' : 'rgba(248,113,113,0.3)'}`,
            fontSize: 13, fontWeight: 500,
            color: oauthBanner.type === 'success' ? '#34D399' : '#F87171',
          }}>
            {oauthBanner.msg}
          </div>
        )}

        {/* ── AI MODEL ── */}
        <SectionLabel label={t(lang, 'aiModelSection')} />
        <div style={{ background: '#111622', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, overflow: 'hidden', marginBottom: 16 }}>

          {/* Provider cards */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: 'rgba(255,255,255,0.05)' }}>
            {PROVIDERS.map((info) => {
              const isConnected = activeProvider === info.id
              return (
                <div
                  key={info.id}
                  style={{
                    background: '#111622',
                    padding: '16px 18px',
                    position: 'relative',
                    outline: isConnected ? '2px solid #3B7EF7' : 'none',
                    outlineOffset: -2,
                  }}
                >
                  {/* Recommended badge */}
                  {info.recommended && (
                    <div style={{ position: 'absolute', top: 10, right: 10, display: 'flex', alignItems: 'center', gap: 3, background: 'rgba(59,126,247,0.15)', border: '1px solid rgba(59,126,247,0.3)', borderRadius: 6, padding: '2px 7px', fontSize: 10, fontWeight: 700, color: '#3B7EF7' }}>
                      <Zap size={9} /> BEST
                    </div>
                  )}

                  <div style={{ fontSize: 20, marginBottom: 6 }}>{info.logo}</div>
                  <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{info.name}</div>
                  <div style={{ fontSize: 11, color: '#5A6A8A', marginBottom: 12, lineHeight: 1.4 }}>
                    {t(lang, info.descKey)}
                  </div>

                  {isConnected ? (
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#34D399', fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
                        <CheckCircle2 size={13} /> {t(lang, 'connectedLabel')}
                        {maskedKey && <span style={{ color: '#5A6A8A', fontFamily: 'monospace', fontSize: 11 }}>{maskedKey}</span>}
                      </div>
                      <button
                        onClick={handleDisconnect}
                        style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 8, border: '1px solid rgba(248,113,113,0.3)', background: 'rgba(248,113,113,0.07)', color: '#F87171', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                      >
                        <Unlink size={11} /> {t(lang, 'disconnectBtn')}
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => handleConnect(info)}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 9, border: '1px solid rgba(255,255,255,0.12)', background: info.recommended ? 'linear-gradient(135deg, #3B7EF7, #6366F1)' : '#1A2030', color: info.recommended ? '#fff' : '#EDF0F7', fontSize: 13, fontWeight: 600, cursor: 'pointer', boxShadow: info.recommended ? '0 2px 12px rgba(59,126,247,0.35)' : 'none' }}
                    >
                      {t(lang, 'connectBtn')}
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          {/* Server AI banner — shown when no personal API key is configured */}
          {!activeProvider && (
            <div style={{ padding: '12px 18px', borderTop: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', gap: 10, background: 'rgba(52,211,153,0.04)' }}>
              <CheckCircle2 size={15} color="#34D399" style={{ flexShrink: 0 }} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#34D399' }}>
                  {lang === 'he' ? '🌊 MiniMax M2.5 — מפתח שרת פעיל' : '🌊 MiniMax M2.5 — Server key active'}
                </div>
                <div style={{ fontSize: 11, color: '#5A6A8A', marginTop: 2 }}>
                  {lang === 'he' ? 'ה-AI פעיל ללא מפתח אישי. חבר ספק לעיל כדי לשנות מודל.' : 'AI is active, no personal key needed. Connect a provider above to switch models.'}
                </div>
              </div>
            </div>
          )}

          {/* Active model selector (shown when a provider is connected) */}
          {activeProvider && (
            <div style={{ padding: '14px 18px', borderTop: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14, color: '#EDF0F7' }}>{t(lang, 'modelLabel')}</div>
                <div style={{ fontSize: 12, color: '#5A6A8A', marginTop: 2 }}>{t(lang, 'modelDesc')}</div>
              </div>
              <select
                value={activeModel}
                onChange={e => setActiveModel(e.target.value)}
                style={selectStyle}
              >
                {(MODEL_OPTIONS[activeProvider] ?? MODEL_OPTIONS.openai).map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          )}
        </div>

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
              <div style={{ fontSize: 12, color: '#5A6A8A', marginTop: 2 }}>{user.email}</div>
            </div>
          </div>
          <button
            onClick={async () => {
              await fetch('/api/auth/logout', { method: 'POST' })
              try { await supabase.auth.signOut() } catch { /* local mode */ }
              window.location.href = '/login'
            }}
            style={{ width: '100%', padding: '11px 16px', borderRadius: 12, background: '#1A2030', border: '1px solid rgba(255,255,255,0.1)', color: '#EDF0F7', fontSize: 14, fontWeight: 500, cursor: 'pointer', marginBottom: 8 }}
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

      {/* ── WIZARD MODAL (OpenAI / Anthropic) ── */}
      {wizardProvider && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }}>
          <div style={{ background: '#111622', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 20, padding: 28, width: '100%', maxWidth: 440 }}>
            <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 20 }}>
              {wizardProvider.logo} {t(lang, 'wizardTitle')} {wizardProvider.name}
            </div>

            <div style={{ fontSize: 13, color: '#9AA3B8', marginBottom: 10 }}>{t(lang, 'wizardStep1')}</div>
            <a
              href={wizardProvider.keyUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 10, background: '#1A2030', border: '1px solid rgba(255,255,255,0.1)', color: '#9AA3B8', fontSize: 13, textDecoration: 'none', marginBottom: 20 }}
            >
              <ExternalLink size={13} /> {wizardProvider.keyUrl?.replace('https://', '')}
            </a>

            <div style={{ fontSize: 13, color: '#9AA3B8', marginBottom: 10 }}>{t(lang, 'wizardStep2')}</div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <input
                type="password"
                value={wizardKey}
                onChange={e => { setWizardKey(e.target.value); setVerifyState('idle') }}
                placeholder={t(lang, 'wizardKeyPlaceholder')}
                style={{ flex: 1, background: '#1A2030', border: '1px solid rgba(255,255,255,0.1)', color: '#EDF0F7', borderRadius: 10, padding: '9px 12px', fontSize: 13, outline: 'none', fontFamily: 'monospace' }}
              />
              <button
                onClick={verifyWizardKey}
                disabled={verifyState === 'verifying' || !wizardKey.trim()}
                style={{ padding: '9px 16px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.12)', background: '#1A2030', color: '#EDF0F7', fontSize: 13, fontWeight: 600, cursor: verifyState === 'verifying' ? 'default' : 'pointer', display: 'flex', alignItems: 'center', gap: 5, opacity: !wizardKey.trim() ? 0.4 : 1 }}
              >
                {verifyState === 'verifying'
                  ? <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> {t(lang, 'verifyingBtn')}</>
                  : t(lang, 'verifyBtn')
                }
              </button>
            </div>

            {/* Verify result */}
            {verifyState === 'ok' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#34D399', fontSize: 13, marginBottom: 12 }}>
                <CheckCircle2 size={14} /> Key works!
              </div>
            )}
            {verifyState === 'fail' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#F87171', fontSize: 12, marginBottom: 12 }}>
                <XCircle size={14} /> {verifyError || 'Invalid key'}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
              <button
                onClick={() => setWizardProvider(null)}
                style={{ flex: 1, padding: '11px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.1)', background: '#1A2030', color: '#9AA3B8', fontSize: 14, fontWeight: 500, cursor: 'pointer' }}
              >
                {t(lang, 'cancelBtn')}
              </button>
              <button
                onClick={saveWizardKey}
                disabled={!wizardKey.trim()}
                style={{ flex: 2, padding: '11px', borderRadius: 12, border: 'none', background: 'linear-gradient(135deg, #3B7EF7, #6366F1)', color: '#fff', fontSize: 14, fontWeight: 700, cursor: !wizardKey.trim() ? 'default' : 'pointer', opacity: !wizardKey.trim() ? 0.4 : 1, boxShadow: '0 4px 16px rgba(59,126,247,0.35)' }}
              >
                {t(lang, 'saveConnectBtn')}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}

/* ─── Sub-components ─── */

function SectionLabel({ label }: { label: string }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5A6A8A', marginBottom: 8, paddingLeft: 4 }}>
      {label}
    </div>
  )
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <SectionLabel label={label} />
      <div style={{ background: '#111622', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  )
}

function Row({ label, desc, children }: { label: string; desc: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20, padding: '14px 18px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
      <div style={{ flex: '0 1 auto', minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14, color: '#EDF0F7', whiteSpace: 'nowrap' }}>{label}</div>
        {desc && <div style={{ fontSize: 12, color: '#5A6A8A', marginTop: 2 }}>{desc}</div>}
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
    <div style={{ display: 'flex', background: '#0C1018', borderRadius: 10, padding: 3, gap: 2, border: '1px solid rgba(255,255,255,0.07)' }}>
      {options.map(opt => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          style={{
            padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
            background: value === opt.value ? 'linear-gradient(135deg, #3B7EF7, #6366F1)' : 'transparent',
            color: value === opt.value ? '#fff' : '#5A6A8A',
            boxShadow: value === opt.value ? '0 2px 8px rgba(59,126,247,0.4)' : 'none',
            transition: 'all 0.15s',
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
        background: value ? 'linear-gradient(135deg, #3B7EF7, #6366F1)' : '#1A2030',
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
