'use client'

import { useState, useEffect, useCallback } from 'react'
import { subscribePushNotifications, unsubscribePushNotifications } from '@/lib/push-client'
import { UserProfile, AIMemory, AppUser } from '@/types'
import { ArrowLeft, X, Check } from 'lucide-react'
import Link from 'next/link'
import { METHOD_LABELS, type SchedulingMethod } from '@/lib/scheduling/methodMapper'

// ─── Method Groups ────────────────────────────────────────────────────────────
const METHOD_GROUPS: Array<{
  id: string
  emoji: string
  name_en: string; name_he: string
  for_en: string;  for_he: string
  desc_en: string; desc_he: string
  color: string
  methods: SchedulingMethod[]
}> = [
  {
    id: 'focus',
    emoji: '🎯',
    name_en: 'Focus & Deep Work', name_he: 'ריכוז ועבודה עמוקה',
    for_en: 'Developers · Students · Writers', for_he: 'מפתחים · סטודנטים · כותבים',
    desc_en: 'For anyone who needs sustained concentration. Pick a time format and protect it.', desc_he: 'לכל מי שצריך ריכוז ממושך. בחר פורמט זמן ושמור אותו.',
    color: '#3B7EF7',
    methods: ['pomodoro', 'deep_work', 'rule_5217', 'time_boxing'],
  },
  {
    id: 'priority',
    emoji: '📊',
    name_en: 'Prioritization', name_he: 'תעדוף',
    for_en: 'Managers · Overwhelmed · Perfectionists', for_he: 'מנהלים · מוצפים · פרפקציוניסטים',
    desc_en: 'Too many tasks? These methods help you decide what actually matters.', desc_he: 'יותר מדי משימות? השיטות האלו עוזרות להחליט מה באמת חשוב.',
    color: '#F97316',
    methods: ['eisenhower', 'moscow', 'ivy_lee', 'eat_the_frog'],
  },
  {
    id: 'projects',
    emoji: '🗂️',
    name_en: 'Projects & Goals', name_he: 'פרויקטים ויעדים',
    for_en: 'Entrepreneurs · Project Managers · Teams', for_he: 'יזמים · מנהלי פרויקטים · צוותים',
    desc_en: 'Running multiple projects or chasing big goals? These systems keep everything visible.', desc_he: 'מנהל מספר פרויקטים או רודף אחרי יעדים גדולים? השיטות האלו שומרות על כל דבר גלוי.',
    color: '#34D399',
    methods: ['gtd', 'kanban', 'scrum', 'okr', 'twelve_week_year', 'the_one_thing'],
  },
  {
    id: 'structure',
    emoji: '📅',
    name_en: 'Structure & Rhythm', name_he: 'מבנה ורצף',
    for_en: 'Everyone · Great as a base layer', for_he: 'כולם · מצוין כשכבת בסיס',
    desc_en: 'Give your days and weeks a skeleton. Works alongside any other method.', desc_he: 'תן לימים ולשבועות שלך שלד. עובד לצד כל שיטה אחרת.',
    color: '#6366F1',
    methods: ['time_blocking', 'theme_days', 'weekly_review', 'energy_management'],
  },
]

interface Props {
  user: AppUser
  profile: UserProfile | null
  onClose?: () => void
  onProfileUpdate?: (p: UserProfile) => void
}

// ─── i18n ────────────────────────────────────────────────────────────────────

const LANGS: Record<string, Record<string, string>> = {
  en: {
    title: 'Settings', subtitle: 'Customize your experience',
    aiSection: 'AI Behavior', autonomyLabel: 'Autonomy Mode',
    autonomyDesc: 'How independently should Zman act?',
    langLabel: 'Language', langDesc: 'AI response language',
    appearSection: 'Appearance', themeLabel: 'Theme',
    micSideLabel: 'Mic Button Side', micSideLeft: '← Left', micSideRight: 'Right →',
    schedSection: 'Schedule', peakLabel: 'Peak Productivity',
    peakDesc: 'When do you work best?',
    wakeLabel: 'Wake Time', sleepLabel: 'Sleep Time',
    methodSection: 'Scheduling Method', methodDesc: 'Your time management approach',
    changeMethodBtn: 'Change Method',
    notifSection: 'Smart Notifications', notifDesc: 'Personalized alerts based on your schedule',
    notifMaster: 'Enable Notifications', notifPreEvent: 'Pre-Event Reminder',
    notifPreEventDesc: 'Smart timing by event type',
    notifMorning: 'Morning Briefing', notifMorningDesc: 'Daily summary after wake-up',
    notifEvening: 'Evening Review', notifEveningDesc: 'Tomorrow preview before sleep',
    notifNudge: 'Task Nudge', notifNudgeDesc: 'Suggest tasks during free time',
    accountSection: 'Account', signOutBtn: 'Sign Out',
    saveBtn: 'Save Settings', savedBtn: 'Saved!', savingBtn: 'Saving…', doneBtn: 'Done',
    memorySection: 'AI Memory', memoryDesc: 'What the AI remembers about you',
    memoryEmpty: 'Nothing saved yet — the AI will learn as you chat.',
    memoryClearAll: 'Clear all', memoryClearConfirm: 'Clear all memory? This cannot be undone.',
    saveFailed: "Couldn't save — check your connection and try again.",
    memoryDeleteFailed: "Couldn't delete that. Nothing was removed.",
  },
  he: {
    title: 'הגדרות', subtitle: 'התאם אישית את החוויה שלך',
    aiSection: 'התנהגות AI', autonomyLabel: 'מצב אוטונומיה',
    autonomyDesc: 'כמה עצמאי יפעל זמן?',
    langLabel: 'שפה', langDesc: 'שפת תגובות ה-AI',
    appearSection: 'מראה', themeLabel: 'ערכת נושא',
    micSideLabel: 'צד כפתור מיק', micSideLeft: '← שמאל', micSideRight: 'ימין →',
    schedSection: 'לוח זמנים', peakLabel: 'שעות שיא',
    peakDesc: 'מתי אתה עובד הכי טוב?',
    wakeLabel: 'שעת קימה', sleepLabel: 'שעת שינה',
    methodSection: 'שיטת ניהול זמן', methodDesc: 'הגישה שלך לניהול זמן',
    changeMethodBtn: 'שנה שיטה',
    notifSection: 'התראות חכמות', notifDesc: 'התראות מותאמות אישית לפי הלוח שלך',
    notifMaster: 'הפעל התראות', notifPreEvent: 'תזכורת לפני אירוע',
    notifPreEventDesc: 'תזמון חכם לפי סוג האירוע',
    notifMorning: 'בריפינג בוקר', notifMorningDesc: 'סיכום יומי אחרי הקימה',
    notifEvening: 'סיכום ערב', notifEveningDesc: 'תצוגה מקדימה למחר לפני השינה',
    notifNudge: 'נאדג׳ משימות', notifNudgeDesc: 'הצע משימות בזמן פנוי',
    accountSection: 'חשבון', signOutBtn: 'יציאה',
    saveBtn: 'שמור הגדרות', savedBtn: '✓ נשמר', savingBtn: '…שומר', doneBtn: 'סיום',
    memorySection: 'זיכרון AI', memoryDesc: 'מה ה-AI זוכר עליך',
    memoryEmpty: 'עדיין לא נשמר כלום — ה-AI ילמד תוך כדי שיחה.',
    memoryClearAll: 'נקה הכל', memoryClearConfirm: 'למחוק את כל הזיכרון? לא ניתן לשחזר.',
    saveFailed: 'לא הצלחנו לשמור — בדוק את החיבור ונסה שוב.',
    memoryDeleteFailed: 'המחיקה נכשלה. שום דבר לא הוסר.',
  },
}

function t(lang: string, key: string) { return (LANGS[lang] ?? LANGS.en)[key] ?? key }

// ─── Component ────────────────────────────────────────────────────────────────

export default function SettingsClient({ user, profile: init, onClose, onProfileUpdate }: Props) {
  const [p, setP] = useState<UserProfile>(init ?? {
    user_id: user.id, autonomy_mode: 'hybrid', theme: 'dark',
    voice_response_enabled: false, language: 'en', onboarding_completed: false,
  })
  const [saved, setSaved] = useState(false)
  // Set when a write actually failed, so the UI can say so instead of flashing "✓ saved".
  const [saveError, setSaveError] = useState<string | null>(null)


  // Memory state
  const [memory, setMemory] = useState<AIMemory[]>([])
  const [deletingMemKey, setDeletingMemKey] = useState<string | null>(null)
  const [memoryExpanded, setMemoryExpanded] = useState(false)

  const lang = p.language ?? 'en'
  const isRTL = lang === 'he' || lang === 'ar'
  const set = (k: keyof UserProfile, v: unknown) => setP(prev => ({ ...prev, [k]: v }))

  // Auto-save a single field immediately (merged server-side into the profile).
  // Reports whether it actually landed — there is no Save button here, so the
  // only thing telling the user their setting stuck is the "✓ saved" flash, and
  // flashing it after a failed write is just lying to them.
  const saveField = async (key: keyof UserProfile, value: unknown): Promise<boolean> => {
    const patch = { [key]: value, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
    try {
      const res = await fetch('/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
      return res.ok
    } catch {
      return false
    }
  }

  // Brief "✓ saved" feedback after any change
  const flashSaved = () => { setSaved(true); setTimeout(() => setSaved(false), 1200) }

  // Single source of change: update local state, apply LIVE to the app (theme,
  // language, mic), persist to the profile, and flash feedback. No Save button.
  const update = (k: keyof UserProfile, v: unknown) => {
    const next = { ...p, [k]: v } as UserProfile
    setP(next)
    onProfileUpdate?.(next)
    setSaveError(null)
    saveField(k, v).then(ok => ok ? flashSaved() : setSaveError(t(lang, 'saveFailed')))
  }

  const handleMethodClick = (key: SchedulingMethod) => {
    const isPrimary = p.scheduling_method === key
    const secondary = p.secondary_methods ?? []
    const isSecondary = secondary.includes(key)

    let scheduling_method = p.scheduling_method
    let secondary_methods = secondary
    if (isPrimary) {
      const [nextPrimary, ...rest] = secondary    // promote first complement
      scheduling_method = nextPrimary as SchedulingMethod | undefined
      secondary_methods = rest
    } else if (isSecondary) {
      secondary_methods = secondary.filter(m => m !== key)
    } else if (!p.scheduling_method) {
      scheduling_method = key
    } else if (secondary.length < 4) {
      secondary_methods = [...secondary, key]
    } else {
      return  // max complements reached
    }

    const next = { ...p, scheduling_method, secondary_methods } as UserProfile
    setP(next)
    onProfileUpdate?.(next)
    saveField('scheduling_method', scheduling_method)
    saveField('secondary_methods', secondary_methods)
    flashSaved()
  }

  const handleNotificationsToggle = useCallback(async (v: boolean) => {
    set('notifications_enabled', v)
    if (v) {
      const ok = await subscribePushNotifications()
      if (!ok) {
        // Permission denied or server error — revert and inform user
        set('notifications_enabled', false)
        saveField('notifications_enabled', false)
        alert(lang === 'he'
          ? 'לא ניתן להפעיל התראות. ודא שאתה מחובר ושהרשאת ההתראות מאושרת בדפדפן.'
          : 'Could not enable notifications. Make sure you are logged in and notification permission is granted.')
        return
      }
    } else {
      await unsubscribePushNotifications()
    }
    saveField('notifications_enabled', v)
  }, [lang]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load memory on mount
  useEffect(() => {
    fetch('/api/memory').then(r => r.ok ? r.json() : []).then((m: AIMemory[]) => {
      if (Array.isArray(m)) setMemory(m)
    }).catch(() => {/* ignore */})
  }, [])

  // Every control auto-saves on change, so this just closes.
  const done = () => {
    if (onClose) onClose()
    else window.location.replace('/')
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
              onChange={v => update('autonomy_mode', v)}
            />
          </Row>
          <Row label={t(lang, 'langLabel')} desc={t(lang, 'langDesc')}>
            <select value={p.language} onChange={e => update('language', e.target.value)} style={selectStyle}>
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
              onChange={v => update('theme', v)}
            />
          </Row>
          <Row label={t(lang, 'micSideLabel')} desc="">
            <SegmentedControl
              options={[
                { value: 'right', label: t(lang, 'micSideRight') },
                { value: 'left',  label: t(lang, 'micSideLeft') },
              ]}
              value={p.mic_position ?? 'right'}
              onChange={v => update('mic_position', v)}
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
              onChange={v => update('productivity_peak', v)}
            />
          </Row>
          <Row label={t(lang, 'wakeLabel')} desc="">
            <input type="time" value={p.wake_time ?? '07:00'} onChange={e => update('wake_time', e.target.value)}
              style={{ ...selectStyle }} />
          </Row>
          <Row label={t(lang, 'sleepLabel')} desc="">
            <input type="time" value={p.sleep_time ?? '23:00'} onChange={e => update('sleep_time', e.target.value)}
              style={{ ...selectStyle }} />
          </Row>
        </Card>

        {/* ── SMART NOTIFICATIONS ── */}
        <Card label={t(lang, 'notifSection')}>
          <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 12, lineHeight: 1.5 }}>
            {t(lang, 'notifDesc')}
          </div>
          <Row label={t(lang, 'notifMaster')} desc="">
            <Toggle value={p.notifications_enabled ?? false} onChange={handleNotificationsToggle} />
          </Row>
          {p.notifications_enabled && (
            <>
              <Row label={`⏰ ${t(lang, 'notifPreEvent')}`} desc={t(lang, 'notifPreEventDesc')}>
                <Toggle value={p.notify_pre_event ?? true} onChange={v => update('notify_pre_event', v)} />
              </Row>
              <Row label={`🌅 ${t(lang, 'notifMorning')}`} desc={t(lang, 'notifMorningDesc')}>
                <Toggle value={p.notify_morning_briefing ?? true} onChange={v => update('notify_morning_briefing', v)} />
              </Row>
              <Row label={`🌙 ${t(lang, 'notifEvening')}`} desc={t(lang, 'notifEveningDesc')}>
                <Toggle value={p.notify_evening_review ?? true} onChange={v => update('notify_evening_review', v)} />
              </Row>
              <Row label={`💡 ${t(lang, 'notifNudge')}`} desc={t(lang, 'notifNudgeDesc')}>
                <Toggle value={p.notify_task_nudge ?? true} onChange={v => update('notify_task_nudge', v)} />
              </Row>
            </>
          )}
        </Card>

        {/* ── SCHEDULING METHOD ── */}
        <Card label={t(lang, 'methodSection')}>
          <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 16, lineHeight: 1.5 }}>
            {lang === 'he'
              ? 'בחר שיטה ראשית + עד 4 משלימות. לחץ על שיטה פעילה כדי לבטל אותה.'
              : 'Select a primary method + up to 4 complements. Tap an active method to deactivate it.'}
          </div>

          {/* Legend */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
            {[
              { dot: '#3B7EF7', label: lang === 'he' ? 'ראשי' : 'Primary' },
              { dot: '#6366F1', label: lang === 'he' ? 'משלים' : 'Complement' },
            ].map(l => (
              <div key={l.dot} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-2)' }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: l.dot }} />
                {l.label}
              </div>
            ))}
          </div>

          {/* Method groups */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {METHOD_GROUPS.map(group => {
              const groupActive = group.methods.some(m => p.scheduling_method === m || (p.secondary_methods ?? []).includes(m))
              return (
                <div key={group.id} style={{
                  borderRadius: 14,
                  border: groupActive ? `1.5px solid ${group.color}40` : '1px solid var(--border)',
                  background: groupActive ? `${group.color}08` : 'var(--bg-input)',
                  overflow: 'hidden',
                  transition: 'all 0.2s',
                }}>
                  {/* Group header */}
                  <div style={{ padding: '10px 14px 8px', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                      <span style={{ fontSize: 18 }}>{group.emoji}</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: groupActive ? group.color : 'var(--text)' }}>
                        {lang === 'he' ? group.name_he : group.name_en}
                      </span>
                      <span style={{
                        marginInlineStart: 'auto', fontSize: 10, fontWeight: 600,
                        color: group.color, background: `${group.color}18`,
                        padding: '2px 8px', borderRadius: 20,
                      }}>
                        {lang === 'he' ? group.for_he : group.for_en}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-2)', paddingInlineStart: 26 }}>
                      {lang === 'he' ? group.desc_he : group.desc_en}
                    </div>
                  </div>

                  {/* Methods */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                    {group.methods.map((key, i) => {
                      const m = METHOD_LABELS[key]
                      const isPrimary = p.scheduling_method === key
                      const isSecondary = (p.secondary_methods ?? []).includes(key)
                      const isActive = isPrimary || isSecondary
                      return (
                        <button
                          key={key}
                          onClick={() => handleMethodClick(key)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 10,
                            padding: '9px 14px',
                            background: isPrimary
                              ? `${group.color}18`
                              : isSecondary ? 'rgba(99,102,241,0.10)' : 'transparent',
                            border: 'none',
                            borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                            cursor: 'pointer',
                            textAlign: isRTL ? 'right' : 'left',
                            transition: 'background 0.15s',
                            boxShadow: isPrimary
                              ? `inset 3px 0 0 ${group.color}` : isSecondary
                              ? 'inset 3px 0 0 #6366F1' : 'none',
                          }}
                          onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)' }}
                          onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                        >
                          <span style={{ fontSize: 18, flexShrink: 0 }}>{m.emoji}</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{
                              fontSize: 13, fontWeight: isPrimary ? 700 : 500,
                              color: isPrimary ? group.color : isSecondary ? '#6366F1' : 'var(--text)',
                              marginBottom: 1,
                            }}>
                              {lang === 'he' ? m.he : m.en}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.3 }}>
                              {lang === 'he' ? m.description_he : m.description_en}
                            </div>
                          </div>
                          {isPrimary && (
                            <span style={{
                              fontSize: 10, fontWeight: 700,
                              color: group.color, background: `${group.color}20`,
                              padding: '2px 7px', borderRadius: 10, flexShrink: 0,
                            }}>
                              {lang === 'he' ? 'ראשי' : 'Primary'}
                            </span>
                          )}
                          {isSecondary && (
                            <span style={{
                              fontSize: 10, fontWeight: 600,
                              color: '#6366F1', background: 'rgba(99,102,241,0.15)',
                              padding: '2px 7px', borderRadius: 10, flexShrink: 0,
                            }}>
                              {lang === 'he' ? 'משלים' : 'Complement'}
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </Card>

        {/* ── MEMORY ── */}
        <Card label={t(lang, 'memorySection')}>
          {/* Toggle row */}
          <button
            onClick={() => setMemoryExpanded(v => !v)}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '12px 16px', background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--text)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{t(lang, 'memoryDesc')}</span>
              {memory.length > 0 && (
                <span style={{ fontSize: 11, fontWeight: 700, background: 'rgba(59,126,247,0.15)', color: 'var(--blue)', padding: '2px 8px', borderRadius: 20 }}>
                  {memory.length}
                </span>
              )}
            </div>
            <span style={{ fontSize: 18, color: 'var(--text-2)', transform: memoryExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>›</span>
          </button>

          {memoryExpanded && (
            <div style={{ borderTop: '1px solid var(--border)', padding: '12px 14px' }}>
              {memory.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--text-2)', fontStyle: 'italic' }}>
                  {t(lang, 'memoryEmpty')}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {/* deduplicate by key — keep last occurrence */}
                  {Object.values(memory.reduce((acc, m) => { acc[m.key] = m; return acc }, {} as Record<string, typeof memory[0]>)).map(m => {
                    const KEY_LABELS: Record<string, { he: string; en: string }> = {
                      occupation: { he: 'עיסוק', en: 'Occupation' },
                      study_field: { he: 'תחום לימודים', en: 'Study Field' },
                      university: { he: 'אוניברסיטה', en: 'University' },
                      year_of_study: { he: 'שנת לימודים', en: 'Year of Study' },
                      wake_time: { he: 'שעת קימה', en: 'Wake Time' },
                      sleep_time: { he: 'שעת שינה', en: 'Sleep Time' },
                      pref_study_time: { he: 'זמן לימוד מועדף', en: 'Preferred Study Time' },
                      pref_meeting_time: { he: 'זמן פגישות מועדף', en: 'Preferred Meeting Time' },
                      work_hours: { he: 'שעות עבודה', en: 'Work Hours' },
                      free_days: { he: 'ימי חופש', en: 'Free Days' },
                      main_challenge: { he: 'אתגר עיקרי', en: 'Main Challenge' },
                      goal: { he: 'מטרה', en: 'Goal' },
                      hobby: { he: 'תחביב', en: 'Hobby' },
                      location: { he: 'מיקום', en: 'Location' },
                      scheduling_method: { he: 'שיטת ניהול זמן', en: 'Scheduling Method' },
                      secondary_methods: { he: 'שיטות משניות', en: 'Secondary Methods' },
                      persona_type: { he: 'סוג משתמש', en: 'User Type' },
                      day_structure: { he: 'מבנה יום', en: 'Day Structure' },
                      productivity_peak: { he: 'שיא פרודוקטיביות', en: 'Peak Hours' },
                      commute_time: { he: 'זמן נסיעה', en: 'Commute Time' },
                      // Extended taxonomy
                      role: { he: 'תפקיד', en: 'Role' },
                      energy_dip: { he: 'נפילת אנרגיה', en: 'Energy Dip' },
                      pref_session_length: { he: 'אורך ישיבה מועדף', en: 'Preferred Session Length' },
                      prefers_buffers: { he: 'מרווחים בין אירועים', en: 'Prefers Buffers' },
                      relationship: { he: 'זוגיות', en: 'Relationship' },
                      family_commitment: { he: 'מחויבות משפחתית', en: 'Family' },
                      volunteering: { he: 'התנדבות', en: 'Volunteering' },
                      current_goal: { he: 'מטרה נוכחית', en: 'Current Goal' },
                      ongoing_task: { he: 'משימה בתהליך', en: 'Ongoing Task' },
                      upcoming_focus: { he: 'פוקוס קרוב', en: 'Upcoming Focus' },
                      method_feedback: { he: 'התאמת שיטה', en: 'Method Fit' },
                    }
                    const label = KEY_LABELS[m.key]
                    const readableKey = label
                      ? (lang === 'he' ? label.he : label.en)
                      : m.key.startsWith('pattern_') ? (lang === 'he' ? `דפוס: ${m.key.slice(8).replace(/_/g, ' ')}` : `Pattern: ${m.key.slice(8).replace(/_/g, ' ')}`)
                      : m.key.startsWith('recurring_') ? (lang === 'he' ? `קבוע: ${m.key.slice(10).replace(/_/g, ' ')}` : `Recurring: ${m.key.slice(10).replace(/_/g, ' ')}`)
                      : m.key.replace(/_/g, ' ')
                    return (
                      <div key={m.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', borderRadius: 10, background: 'var(--bg)', border: '1px solid var(--border)' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--blue)', marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{readableKey}</div>
                          <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.4, wordBreak: 'break-word' }}>{m.value}</div>
                        </div>
                        <button
                          onClick={async () => {
                            setDeletingMemKey(m.key)
                            setSaveError(null)
                            try {
                              const res = await fetch('/api/memory', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: [m.key] }) })
                              // Only drop it from the list once the server agrees it's gone,
                              // otherwise it reappears on the next load and looks like a ghost.
                              if (!res.ok) throw new Error('memory_delete_failed')
                              setMemory(prev => prev.filter(x => x.key !== m.key))
                            } catch {
                              setSaveError(t(lang, 'memoryDeleteFailed'))
                            } finally {
                              setDeletingMemKey(null)
                            }
                          }}
                          disabled={deletingMemKey === m.key}
                          style={{ flexShrink: 0, width: 22, height: 22, borderRadius: 6, border: 'none', background: 'rgba(255,100,100,0.15)', color: '#F87171', cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: deletingMemKey === m.key ? 0.5 : 1, marginTop: 2 }}
                        >×</button>
                      </div>
                    )
                  })}
                  <button
                    onClick={async () => {
                      if (!window.confirm(t(lang, 'memoryClearConfirm'))) return
                      setSaveError(null)
                      try {
                        const res = await fetch('/api/memory', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }) })
                        if (!res.ok) throw new Error('memory_clear_failed')
                        setMemory([])
                      } catch {
                        setSaveError(t(lang, 'memoryDeleteFailed'))
                      }
                    }}
                    style={{ marginTop: 4, padding: '8px 14px', borderRadius: 10, border: '1px solid rgba(248,113,113,0.3)', background: 'rgba(248,113,113,0.08)', color: '#F87171', fontSize: 12, cursor: 'pointer', alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 6 }}
                  >
                    🗑 {t(lang, 'memoryClearAll')}
                  </button>
                </div>
              )}
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
              window.location.href = '/login'
            }}
            style={{ width: '100%', padding: '11px 16px', borderRadius: 12, background: 'var(--bg-input)', border: '1px solid var(--border-hi)', color: 'var(--text)', fontSize: 14, fontWeight: 500, cursor: 'pointer', marginBottom: 8 }}
          >
            {t(lang, 'signOutBtn')}
          </button>
        </Card>

        {/* Settings auto-save with no Save button, so a failed write is invisible
            unless we say so out loud. */}
        {saveError && (
          <div style={{
            padding: '10px 14px', borderRadius: 12, marginBottom: 10,
            background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)',
            color: '#F87171', fontSize: 13, lineHeight: 1.4,
          }}>
            {saveError}
          </div>
        )}

        {/* ── SAVE ── */}
        <button
          onClick={done}
          style={{
            width: '100%', padding: '14px', borderRadius: 14, border: 'none',
            background: saved ? 'rgba(52,211,153,0.15)' : 'linear-gradient(135deg, #3B7EF7, #6366F1)',
            color: saved ? '#34D399' : '#fff',
            fontSize: 15, fontWeight: 700, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            boxShadow: saved ? 'none' : '0 4px 20px rgba(59,126,247,0.4)',
            outline: saved ? '1px solid rgba(52,211,153,0.3)' : 'none',
            transition: 'background 0.2s, color 0.2s',
          }}
        >
          {saved ? <><Check size={16} /> {t(lang, 'savedBtn')}</> : t(lang, 'doneBtn')}
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
