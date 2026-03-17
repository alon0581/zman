'use client'

import { useState } from 'react'

type Mode = 'login' | 'register' | 'reset'

const INPUT_STYLE: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  padding: '11px 14px',
  background: 'var(--bg-input)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  color: 'var(--text)',
  fontSize: 14,
  outline: 'none',
}

export default function LoginPage() {
  const [mode, setMode]           = useState<Mode>('login')
  const [email, setEmail]         = useState('')
  const [password, setPassword]   = useState('')
  const [confirm, setConfirm]     = useState('')
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState('')
  const [resetDone, setResetDone] = useState(false)

  const switchMode = (m: Mode) => { setMode(m); setError(''); setResetDone(false) }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (mode === 'register' || mode === 'reset') {
      if (password !== confirm) { setError('הסיסמאות אינן תואמות'); return }
      if (password.length < 6)  { setError('הסיסמה חייבת להכיל לפחות 6 תווים'); return }
    }

    setLoading(true)

    if (mode === 'reset') {
      const res  = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, newPassword: password }),
      })
      const data = await res.json()
      setLoading(false)
      if (!res.ok) { setError(data.error ?? 'שגיאה בלתי צפויה'); return }
      setResetDone(true)
      return
    }

    const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/register'
    const res  = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    const data = await res.json()
    setLoading(false)

    if (!res.ok) { setError(data.error ?? 'שגיאה בלתי צפויה'); return }

    window.location.href = '/app'
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center',
      justifyContent: 'center',
      background: 'radial-gradient(ellipse at 50% -10%, rgba(59,126,247,0.14) 0%, transparent 55%), var(--bg)',
      padding: '24px',
    }}>
      <div style={{ width: '100%', maxWidth: 380 }}>

        <div style={{ textAlign: 'center', marginBottom: 36 }}>
          <div style={{
            width: 60, height: 60, borderRadius: 18,
            background: 'linear-gradient(135deg,#3B7EF7,#6366F1)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 26, fontWeight: 900, color: '#fff',
            boxShadow: '0 8px 32px rgba(59,126,247,0.5), 0 0 0 1px rgba(99,102,241,0.3)',
            margin: '0 auto 18px',
          }}>Z</div>
          <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-0.04em', color: 'var(--text)', marginBottom: 6 }}>Zman</div>
          <div style={{ fontSize: 14, color: 'var(--text-2)', letterSpacing: '-0.01em' }}>Your AI-Powered Life Scheduler</div>
        </div>

        <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-hi)', borderRadius: 'var(--radius-xl)', padding: '32px 28px', boxShadow: 'var(--shadow-xl)' }}>

          {mode !== 'reset' && (
            <div style={{ display: 'flex', background: 'var(--bg-input)', borderRadius: 10, padding: 3, marginBottom: 24, gap: 2 }}>
              {(['login', 'register'] as Mode[]).map(m => (
                <button key={m} onClick={() => switchMode(m)} style={{
                  flex: 1, padding: '7px 0', borderRadius: 7, border: 'none', cursor: 'pointer',
                  fontSize: 13, fontWeight: 600,
                  background: mode === m ? 'linear-gradient(135deg,#3B7EF7,#6366F1)' : 'transparent',
                  color: mode === m ? '#fff' : 'var(--text-2)',
                  boxShadow: mode === m ? '0 2px 8px rgba(59,126,247,0.35)' : 'none',
                  transition: 'all 0.15s',
                }}>
                  {m === 'login' ? 'כניסה' : 'הרשמה'}
                </button>
              ))}
            </div>
          )}

          {mode === 'reset' && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>איפוס סיסמה</div>
              <div style={{ fontSize: 13, color: 'var(--text-2)' }}>הזן את המייל שלך וסיסמה חדשה</div>
            </div>
          )}

          {resetDone ? (
            <div>
              <div style={{
                background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.3)',
                borderRadius: 10, padding: '14px', textAlign: 'center', color: '#34D399', fontSize: 14, marginBottom: 16,
              }}>
                הסיסמה עודכנה בהצלחה!
              </div>
              <button onClick={() => switchMode('login')} style={{
                width: '100%', padding: '12px', borderRadius: 10, border: 'none',
                background: 'linear-gradient(135deg,#3B7EF7,#6366F1)', color: '#fff',
                fontSize: 14, fontWeight: 700, cursor: 'pointer',
              }}>חזרה לכניסה</button>
            </div>
          ) : (
            <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6 }}>אימייל</label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="you@example.com" required autoComplete="email"
                  style={INPUT_STYLE}
                  onFocus={e => (e.currentTarget.style.borderColor = '#3B7EF7')}
                  onBlur={e  => (e.currentTarget.style.borderColor = 'var(--border)')}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6 }}>
                  {mode === 'reset' ? 'סיסמה חדשה' : 'סיסמה'}
                </label>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                  placeholder={mode === 'login' ? '••••••••' : 'לפחות 6 תווים'} required
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  style={INPUT_STYLE}
                  onFocus={e => (e.currentTarget.style.borderColor = '#3B7EF7')}
                  onBlur={e  => (e.currentTarget.style.borderColor = 'var(--border)')}
                />
              </div>

              {(mode === 'register' || mode === 'reset') && (
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6 }}>אישור סיסמה</label>
                  <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
                    placeholder="••••••••" required autoComplete="new-password"
                    style={{ ...INPUT_STYLE, borderColor: confirm && confirm !== password ? '#ef4444' : 'var(--border)' }}
                    onFocus={e => (e.currentTarget.style.borderColor = confirm !== password ? '#ef4444' : '#3B7EF7')}
                    onBlur={e  => (e.currentTarget.style.borderColor = confirm && confirm !== password ? '#ef4444' : 'var(--border)')}
                  />
                  {confirm && confirm !== password && (
                    <div style={{ fontSize: 11, color: '#ef4444', marginTop: 4 }}>הסיסמאות אינן תואמות</div>
                  )}
                </div>
              )}

              {error && (
                <div style={{
                  background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
                  borderRadius: 8, padding: '10px 12px', fontSize: 13, color: '#ef4444', textAlign: 'center',
                }}>
                  {error}
                </div>
              )}

              <button type="submit" disabled={loading} style={{
                marginTop: 4, padding: '13px',
                background: 'linear-gradient(135deg,#3B7EF7,#6366F1)',
                border: 'none', borderRadius: 10, color: '#fff', fontSize: 15, fontWeight: 700,
                cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1,
                boxShadow: '0 4px 16px rgba(59,126,247,0.4)', transition: 'opacity 0.15s',
              }}>
                {loading ? '...' : mode === 'login' ? 'כניסה' : mode === 'register' ? 'יצירת חשבון' : 'עדכן סיסמה'}
              </button>

              {mode === 'login' && (
                <button type="button" onClick={() => switchMode('reset')} style={{
                  background: 'none', border: 'none', color: 'var(--text-2)',
                  fontSize: 12, cursor: 'pointer', textAlign: 'center',
                  textDecoration: 'underline', marginTop: -4, padding: 0,
                }}>
                  שכחתי סיסמה
                </button>
              )}

              {mode === 'reset' && (
                <button type="button" onClick={() => switchMode('login')} style={{
                  background: 'none', border: 'none', color: 'var(--text-2)',
                  fontSize: 12, cursor: 'pointer', textAlign: 'center',
                  textDecoration: 'underline', marginTop: -4, padding: 0,
                }}>
                  חזרה לכניסה
                </button>
              )}

            </form>
          )}
        </div>

        <p style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-2)', marginTop: 20 }}>
          הנתונים שלך נשמרים באופן מקומי בלבד
        </p>
      </div>
    </div>
  )
}
