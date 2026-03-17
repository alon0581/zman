'use client'

import { useState, useEffect, useRef } from 'react'

/* ─── Translations ─── */
const COPY = {
  en: {
    badge: '✦ AI-Powered Scheduling',
    headline1: 'Your life,',
    headline2: 'beautifully scheduled.',
    sub: "Just tell Zman what you need. It thinks, plans, and organizes — so you don't have to.",
    cta1: "Get Started — It's Free",
    cta2: 'Sign In →',
    proof: 'Free to use  ·  No credit card  ·  Takes 30 seconds',
    featTitle: 'Built different.',
    featSub: 'Everything your calendar should have been.',
    features: [
      { title: "Talk, don't tap", desc: "Describe your week in plain language. Zman's AI parses intent, resolves conflicts, and builds your schedule in seconds." },
      { title: 'Thinks ahead', desc: 'Zman knows your productivity peaks, sleep schedule, and commitments. Events land where they fit best — automatically.' },
      { title: 'Truly yours', desc: 'Your data lives on your device. No cloud syncing, no accounts required to try it. Privacy by default, always.' },
    ],
    showcaseLabel: 'See it in action',
    scenes: [
      { title: 'Just say it.', desc: 'Type or speak in plain language. No forms, no drag-and-drop, no learning curve.' },
      { title: 'Finds your time.', desc: 'Zman scans your week, respects your sleep and focus hours, and drops events exactly where they fit.' },
      { title: 'No conflicts.', desc: 'Overlapping commitments? Zman resolves them automatically, suggesting the best reshuffle.' },
      { title: 'Your week, done.', desc: 'Review the full plan in seconds. Tweak anything conversationally, then go live your life.' },
    ],
    stepsTitle: 'Three steps to a better week.',
    stepsSub: 'No setup. No learning curve. Just talk.',
    steps: [
      { num: '01', title: 'Tell Zman', desc: 'Type or speak what you need scheduled. "Gym 3x this week, no earlier than 7am" — done.' },
      { num: '02', title: 'AI Does the Work', desc: 'Zman finds free slots, considers your habits and priorities, and fills your calendar intelligently.' },
      { num: '03', title: 'Review and Go', desc: 'Confirm or tweak conversationally. Your week, always under your control.' },
    ],
    ctaTitle: 'Ready to reclaim your time?',
    ctaSub: 'Free to use. No credit card. No setup required.',
    ctaBtn: 'Start Scheduling Free',
    ctaSignIn: 'Sign In →',
    footerTagline: 'AI Life Scheduler',
    copyright: '© 2026 Zman',
    navSignIn: 'Sign In',
    navStart: 'Get Started',
    mockupChat: [
      { user: true,  text: 'Add gym 3x this week' },
      { user: false, text: "Done! I've added Mon, Wed, Fri at 7am" },
      { user: true,  text: 'Move Friday to 8am' },
      { user: false, text: 'Updated — Friday gym moved to 8:00 AM' },
    ],
  },
  he: {
    badge: '✦ תזמון חכם עם AI',
    headline1: 'החיים שלך,',
    headline2: 'מתוזמנים בצורה מושלמת.',
    sub: 'פשוט תגיד לזמן מה אתה צריך. הוא חושב, מתכנן ומארגן — כדי שאתה לא תצטרך.',
    cta1: 'התחל בחינם',
    cta2: '← כניסה',
    proof: 'חינמי לחלוטין  ·  ללא כרטיס אשראי  ·  30 שניות',
    featTitle: 'בנוי אחרת.',
    featSub: 'כל מה שיומן היה צריך להיות.',
    features: [
      { title: 'מדברים, לא לוחצים', desc: 'תאר את השבוע שלך בשפה פשוטה. ה-AI של זמן מפרש, מייעל ובונה את לוח הזמנים שלך תוך שניות.' },
      { title: 'חושב קדימה', desc: 'זמן מכיר את שיאי הפרודוקטיביות שלך, שעות השינה והמחויבויות. אירועים נוחתים בדיוק איפה שמתאים — אוטומטית.' },
      { title: 'שלך לגמרי', desc: 'הנתונים שלך נשמרים על המכשיר שלך. ללא סנכרון לענן, ללא צורך בחשבון כדי לנסות. פרטיות כברירת מחדל.' },
    ],
    showcaseLabel: 'ראה את זה בפעולה',
    scenes: [
      { title: 'פשוט תגיד.', desc: 'הקלד או דבר בשפה פשוטה. ללא טפסים, ללא גרירה, ללא עקומת למידה.' },
      { title: 'מוצא את הזמן שלך.', desc: 'זמן סורק את השבוע שלך, מכבד את שעות השינה והפוקוס שלך, ומניח אירועים בדיוק איפה שמתאים.' },
      { title: 'ללא קונפליקטים.', desc: 'מחויבויות חופפות? זמן פותר אותן אוטומטית, ומציע את ארגון מחדש הטוב ביותר.' },
      { title: 'השבוע שלך, מוכן.', desc: 'סקור את התוכנית המלאה תוך שניות. שנה כל דבר בשיחה, ואז לך לחיות את החיים.' },
    ],
    stepsTitle: 'שלושה שלבים לשבוע טוב יותר.',
    stepsSub: 'ללא הגדרות. ללא עקומת למידה. פשוט מדברים.',
    steps: [
      { num: '01', title: 'ספר לזמן', desc: 'הקלד או דבר מה אתה צריך לתזמן. "חדר כושר 3 פעמים השבוע, לא לפני 7 בבוקר" — נגמר.' },
      { num: '02', title: 'ה-AI עושה את העבודה', desc: 'זמן מוצא חלונות זמן פנויים, מתחשב בהרגלים ובסדרי עדיפויות שלך וממלא את היומן בצורה חכמה.' },
      { num: '03', title: 'בדוק ולך', desc: 'אשר או שנה בשיחה. השבוע שלך, תמיד בשליטתך.' },
    ],
    ctaTitle: 'מוכן להחזיר את הזמן שלך?',
    ctaSub: 'חינמי לשימוש. ללא כרטיס אשראי. ללא הגדרות.',
    ctaBtn: 'התחל לתזמן בחינם',
    ctaSignIn: '← כניסה',
    footerTagline: 'מתזמן חיים עם AI',
    copyright: '© 2026 זמן',
    navSignIn: 'כניסה',
    navStart: 'התחל',
    mockupChat: [
      { user: true,  text: 'הוסף חדר כושר 3 פעמים השבוע' },
      { user: false, text: 'סיום! הוספתי ב׳, ד׳, ו׳ בשעה 7:00' },
      { user: true,  text: 'הזז את יום שישי לשעה 8' },
      { user: false, text: 'עודכן — חדר כושר ביום שישי הוזז לשעה 8:00' },
    ],
  },
} as const

/* ─── SVG Icons ─── */
const IconChat = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  </svg>
)
const IconSparkles = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3l1.88 5.76L20 10l-6.12 1.24L12 17l-1.88-5.76L4 10l6.12-1.24z"/>
    <path d="M5 3v4M19 17v4M3 5h4M17 19h4"/>
  </svg>
)
const IconLock = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
  </svg>
)

const FEATURE_META = [
  { icon: <IconChat />,     iconColor: '#3B7EF7', iconBg: 'rgba(59,126,247,0.15)' },
  { icon: <IconSparkles />, iconColor: '#6366F1', iconBg: 'rgba(99,102,241,0.15)' },
  { icon: <IconLock />,     iconColor: '#34D399', iconBg: 'rgba(52,211,153,0.15)' },
]

/* ─── Hooks ─── */
function useScrollY() {
  const [y, setY] = useState(0)
  useEffect(() => {
    let id: number
    const h = () => { id = requestAnimationFrame(() => setY(window.scrollY)) }
    window.addEventListener('scroll', h, { passive: true })
    return () => { window.removeEventListener('scroll', h); cancelAnimationFrame(id) }
  }, [])
  return y
}

function useInView(threshold = 0.15) {
  const ref = useRef<HTMLDivElement>(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current; if (!el) return
    const obs = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { setInView(true); obs.disconnect() }
    }, { threshold })
    obs.observe(el)
    return () => obs.disconnect()
  }, [threshold])
  return { ref, inView }
}

/* ─── Main Component ─── */
export default function LandingClient({ lang = 'en' }: { lang?: 'en' | 'he' }) {
  const c = COPY[lang]
  const isRTL = lang === 'he'

  const scrollY = useScrollY()
  const [scrolled, setScrolled]     = useState(false)
  const [isMobile, setIsMobile]     = useState(false)
  const [ghostHover, setGhostHover] = useState(false)
  const [docHeight, setDocHeight]   = useState(0)
  const [viewportH, setViewportH]   = useState(0)

  const showcaseRef   = useRef<HTMLDivElement>(null)
  const showcaseTop   = useRef(0)
  const [scene, setScene] = useState(0)
  const [sceneEntering, setSceneEntering] = useState(true)

  useEffect(() => {
    document.documentElement.dir  = isRTL ? 'rtl' : 'ltr'
    document.documentElement.lang = lang
  }, [lang, isRTL])

  useEffect(() => {
    const update = () => {
      setIsMobile(window.innerWidth < 768)
      setDocHeight(document.body.scrollHeight)
      setViewportH(window.innerHeight)
      if (showcaseRef.current) {
        showcaseTop.current = showcaseRef.current.getBoundingClientRect().top + window.scrollY
      }
    }
    update()
    window.addEventListener('resize', update, { passive: true })
    return () => window.removeEventListener('resize', update)
  }, [])

  useEffect(() => { setScrolled(scrollY > 40) }, [scrollY])

  // Sticky showcase scene calculation — use live getBoundingClientRect, no stale top ref
  useEffect(() => {
    if (!showcaseRef.current || isMobile) return
    const scrolledIn = Math.max(0, -(showcaseRef.current.getBoundingClientRect().top))
    const scrollableH = viewportH * 1.6   // 260vh container minus 100vh sticky panel
    const progress = Math.min(1, scrolledIn / Math.max(1, scrollableH))
    const newScene = Math.min(3, Math.floor(progress * 4))
    if (newScene !== scene) {
      setSceneEntering(false)
      const t = setTimeout(() => { setScene(newScene); setSceneEntering(true) }, 180)
      return () => clearTimeout(t)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollY, viewportH, isMobile])

  const maxScroll = Math.max(1, docHeight - viewportH)
  const progressPct = Math.min(100, (scrollY / maxScroll) * 100)

  // Hero parallax values (desktop only)
  const heroParallax = (!isMobile && scrollY < viewportH)
    ? { textY: -scrollY * 0.22, textOp: Math.max(0, 1 - scrollY / 700), mockY: -scrollY * 0.1, mockScale: 1 - scrollY * 0.00015, orb1Y: -scrollY * 0.07, orb2Y: -scrollY * 0.05 }
    : { textY: 0, textOp: 1, mockY: 0, mockScale: 1, orb1Y: 0, orb2Y: 0 }

  const sp = isMobile ? '80px 24px' : '120px 60px'
  const featureRefs = [useInView(), useInView(), useInView()] // eslint-disable-line react-hooks/rules-of-hooks
  const stepRefs    = [useInView(), useInView(), useInView()] // eslint-disable-line react-hooks/rules-of-hooks
  const ctaRef      = useInView(0.2)
  const featTitleRef = useInView(0.3)
  const stepsTitleRef = useInView(0.3)

  return (
    <div dir={isRTL ? 'rtl' : 'ltr'} style={{ minHeight: '100vh', background: 'transparent', fontFamily: 'var(--font-inter, system-ui, sans-serif)', overflowX: 'clip' }}>

      <style>{`
        @keyframes landingFadeUp {
          from { opacity: 0; transform: translateY(22px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes landingFloatOrb {
          0%, 100% { transform: translateY(0px) scale(1); }
          50%      { transform: translateY(-24px) scale(1.04); }
        }
        @keyframes clipReveal {
          from { clip-path: inset(0 100% 0 0); opacity: 0.2; }
          to   { clip-path: inset(0 0% 0 0);   opacity: 1; }
        }
        @keyframes clipRevealRTL {
          from { clip-path: inset(0 0% 0 100%); opacity: 0.2; }
          to   { clip-path: inset(0 0% 0 0);    opacity: 1; }
        }
        @keyframes mockupSlide {
          from { opacity: 0; transform: translateX(-14px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        @keyframes mockupBubble {
          from { opacity: 0; transform: translateY(10px) scale(0.94); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes mockupPulse {
          0%, 100% { transform: scaleX(0.97); opacity: 0.5; }
          50%      { transform: scaleX(1.02); opacity: 1; }
        }
        @keyframes scrollBounce {
          0%, 100% { transform: translateX(-50%) translateY(0); opacity: 0.5; }
          50%      { transform: translateX(-50%) translateY(7px); opacity: 1; }
        }
      `}</style>

      {/* ── SCROLL PROGRESS BAR ── */}
      <div style={{
        position: 'fixed', top: 0, left: 0, zIndex: 300, height: 3, pointerEvents: 'none',
        width: `${progressPct}%`,
        background: 'linear-gradient(90deg, #3B7EF7, #6366F1)',
        transition: 'width 0.05s linear',
      }} />

      {/* ── NAVBAR ── */}
      <nav style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 100,
        height: 64,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 32px',
        direction: 'ltr',
        background: scrolled ? 'rgba(7,7,15,0.88)' : 'rgba(7,7,15,0)',
        backdropFilter: 'blur(28px) saturate(180%)',
        WebkitBackdropFilter: 'blur(28px) saturate(180%)',
        borderBottom: scrolled ? '1px solid var(--border)' : '1px solid transparent',
        transition: 'background 0.3s, border-color 0.3s',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }} onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
          <div style={{
            width: 34, height: 34, borderRadius: 10,
            background: 'linear-gradient(135deg,#3B7EF7,#6366F1)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 15, fontWeight: 900, color: '#fff',
            boxShadow: '0 4px 14px rgba(59,126,247,0.45)', flexShrink: 0,
          }}>Z</div>
          <span style={{ fontSize: 17, fontWeight: 800, letterSpacing: '-0.03em', color: 'var(--text)' }}>Zman</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {!isMobile && (
            <a href="/login" style={{
              padding: '8px 18px', borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-hi)', background: 'transparent',
              color: 'var(--text-2)', fontSize: 14, fontWeight: 600, cursor: 'pointer', textDecoration: 'none',
              transition: 'color var(--t-base), border-color var(--t-base)',
            }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--text)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--blue)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--text-2)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-hi)' }}
            >{c.navSignIn}</a>
          )}
          <a href="/login" className="btn-primary" style={{
            padding: isMobile ? '8px 16px' : '8px 20px',
            borderRadius: 'var(--radius-md)', fontSize: 14, fontWeight: 700,
            textDecoration: 'none', display: 'inline-block',
          }}>{c.navStart}</a>
        </div>
      </nav>

      {/* ── HERO ── */}
      <section style={{
        position: 'relative', minHeight: '100vh',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: isMobile ? '100px 24px 60px' : '120px 40px 80px',
        textAlign: 'center', overflow: 'hidden',
      }}>
        {/* Ambient orbs */}
        <div style={{
          position: 'absolute', width: 700, height: 700, borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(59,126,247,0.16) 0%, transparent 70%)',
          top: '-15%', left: '-10%', zIndex: 0, pointerEvents: 'none',
          transform: `translateY(${heroParallax.orb1Y}px)`,
          animation: 'landingFloatOrb 9s ease-in-out infinite',
        }} />
        <div style={{
          position: 'absolute', width: 560, height: 560, borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(99,102,241,0.12) 0%, transparent 70%)',
          bottom: '-10%', right: '-8%', zIndex: 0, pointerEvents: 'none',
          transform: `translateY(${heroParallax.orb2Y}px)`,
          animation: 'landingFloatOrb 11s ease-in-out infinite',
          animationDelay: '3s',
        }} />

        {/* Hero content with parallax */}
        <div style={{
          position: 'relative', zIndex: 1, maxWidth: 760, width: '100%',
          transform: `translateY(${heroParallax.textY}px)`,
          opacity: heroParallax.textOp,
        }}>
          {/* Badge */}
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '5px 14px', borderRadius: 99,
            background: 'rgba(59,126,247,0.12)', border: '1px solid rgba(59,126,247,0.28)',
            color: 'var(--blue)', fontSize: 12, fontWeight: 600,
            marginBottom: 28, letterSpacing: '0.01em',
            animation: 'landingFadeUp 0.6s cubic-bezier(0.22,1,0.36,1) both',
          }}>{c.badge}</div>

          {/* Headline */}
          <div style={{
            fontSize: isMobile ? 'clamp(48px, 12vw, 72px)' : 'clamp(72px, 8.5vw, 112px)',
            fontWeight: 900, letterSpacing: '-0.045em', lineHeight: 1.02, marginBottom: 28,
            animation: 'landingFadeUp 0.7s 0.1s cubic-bezier(0.22,1,0.36,1) both',
          }}>
            <div style={{ color: 'var(--text)', marginBottom: '0.06em' }}>{c.headline1}</div>
            <div>
              {c.headline2.split(' ').map((word, i) => (
                <span key={i} className="grad" style={{
                  display: 'inline-block',
                  animation: `landingFadeUp 0.6s ${0.18 + i * 0.09}s cubic-bezier(0.22,1,0.36,1) both`,
                  marginRight: isRTL ? 0 : '0.22em', marginLeft: isRTL ? '0.22em' : 0,
                }}>{word}</span>
              ))}
            </div>
          </div>

          {/* Sub */}
          <p style={{
            fontSize: isMobile ? 19 : 24, color: 'var(--text-2)', lineHeight: 1.55,
            letterSpacing: '-0.01em', maxWidth: 580, margin: '0 auto 44px',
            animation: 'landingFadeUp 0.7s 0.22s cubic-bezier(0.22,1,0.36,1) both',
          }}>{c.sub}</p>

          {/* CTAs */}
          <div style={{
            display: 'flex', flexDirection: isMobile ? 'column' : 'row',
            alignItems: 'center', justifyContent: 'center', gap: 12,
            animation: 'landingFadeUp 0.7s 0.34s cubic-bezier(0.22,1,0.36,1) both',
          }}>
            <a href="/login" className="btn-primary" style={{
              padding: '17px 36px', borderRadius: 'var(--radius-lg)',
              fontSize: 18, fontWeight: 700, textDecoration: 'none', display: 'inline-block',
              width: isMobile ? '100%' : 'auto', boxSizing: 'border-box', textAlign: 'center',
            }}>{c.cta1}</a>
            <a href="/login" style={{
              padding: '16px 32px', borderRadius: 'var(--radius-lg)',
              border: ghostHover ? '1px solid var(--blue)' : '1px solid var(--border-hi)',
              background: 'transparent',
              color: ghostHover ? 'var(--text)' : 'var(--text-2)',
              fontSize: 18, fontWeight: 600, cursor: 'pointer', textDecoration: 'none', display: 'inline-block',
              width: isMobile ? '100%' : 'auto', boxSizing: 'border-box', textAlign: 'center',
              transition: 'border-color var(--t-base), color var(--t-base)',
            }}
              onMouseEnter={() => setGhostHover(true)}
              onMouseLeave={() => setGhostHover(false)}
            >{c.cta2}</a>
          </div>

          <p style={{
            marginTop: 26, fontSize: 17, color: 'var(--text-2)', letterSpacing: '0.01em', fontWeight: 500,
            animation: 'landingFadeUp 0.7s 0.44s cubic-bezier(0.22,1,0.36,1) both',
          }}>{c.proof}</p>
        </div>

        {/* App Mockup — desktop only, with parallax */}
        {!isMobile && (
          <div style={{
            position: 'relative', zIndex: 1, marginTop: 64, width: '100%', maxWidth: 720,
            transform: `translateY(${heroParallax.mockY}px) scale(${heroParallax.mockScale})`,
            transformOrigin: 'top center',
            animation: 'landingFadeUp 0.8s 0.5s cubic-bezier(0.22,1,0.36,1) both',
          }}>
            <div className="glass" style={{
              border: '1px solid var(--border-hi)', borderRadius: 'var(--radius-xl)',
              boxShadow: 'var(--shadow-xl), 0 0 80px rgba(59,126,247,0.1)', overflow: 'hidden',
            }}>
              <div style={{
                height: 42, background: 'rgba(255,255,255,0.04)', borderBottom: '1px solid var(--border)',
                display: 'flex', alignItems: 'center', padding: '0 16px', gap: 8, direction: 'ltr',
              }}>
                {['#ef4444','#fbbf24','#34d399'].map(col => (
                  <div key={col} style={{ width: 11, height: 11, borderRadius: '50%', background: col, opacity: 0.7 }} />
                ))}
                <div style={{ flex: 1, height: 20, borderRadius: 6, background: 'rgba(255,255,255,0.05)', marginLeft: 8 }} />
              </div>
              <div style={{ display: 'flex', height: 280, direction: 'ltr' }}>
                <div style={{ flex: 1, padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ height: 18, width: 100, borderRadius: 6, background: 'rgba(255,255,255,0.08)', marginBottom: 4 }} />
                  {[
                    { color: '#3B7EF7', w: '75%', label: isRTL ? 'סטנד-אפ צוות' : 'Team standup' },
                    { color: '#6366F1', w: '55%', label: isRTL ? 'עבודה עמוקה' : 'Deep work' },
                    { color: '#34D399', w: '45%', label: isRTL ? 'חדר כושר' : 'Gym session' },
                    { color: '#FBBF24', w: '65%', label: isRTL ? 'הפסקת צהריים' : 'Lunch break' },
                    { color: '#3B7EF7', w: '50%', label: isRTL ? 'סקירת קוד' : 'Code review' },
                  ].map((ev, i) => (
                    <div key={i} style={{
                      width: ev.w, height: 32, borderRadius: 8,
                      background: ev.color + '33', border: `1px solid ${ev.color}55`,
                      display: 'flex', alignItems: 'center', paddingLeft: 10,
                      fontSize: 10, color: ev.color, fontWeight: 600,
                      animation: `mockupSlide 0.5s ${0.55 + i * 0.1}s cubic-bezier(0.22,1,0.36,1) both`,
                    }}>{ev.label}</div>
                  ))}
                </div>
                <div style={{ width: 1, background: 'var(--border)' }} />
                <div style={{ width: 220, padding: 16, display: 'flex', flexDirection: 'column', gap: 10, justifyContent: 'flex-end' }}>
                  {c.mockupChat.map((msg, i) => (
                    <div key={i} style={{
                      alignSelf: msg.user ? 'flex-end' : 'flex-start', maxWidth: '85%',
                      padding: '7px 10px',
                      borderRadius: msg.user ? '12px 12px 3px 12px' : '12px 12px 12px 3px',
                      background: msg.user
                        ? 'linear-gradient(135deg,rgba(59,126,247,0.85),rgba(99,102,241,0.85))'
                        : 'rgba(22,22,38,0.9)',
                      border: msg.user ? 'none' : '1px solid rgba(255,255,255,0.08)',
                      fontSize: 10, color: '#fff', lineHeight: 1.4,
                      animation: `mockupBubble 0.45s ${0.65 + i * 0.18}s cubic-bezier(0.22,1,0.36,1) both`,
                    }}>{msg.text}</div>
                  ))}
                </div>
              </div>
            </div>
            <div style={{
              position: 'absolute', bottom: -40, left: '10%', right: '10%', height: 40,
              background: 'linear-gradient(to bottom, rgba(59,126,247,0.08), transparent)',
              filter: 'blur(16px)', borderRadius: '50%', pointerEvents: 'none',
            }} />
          </div>
        )}
      </section>

      {/* ── FEATURES ── */}
      <section style={{ padding: sp }}>
        <div style={{ maxWidth: 960, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 56 }}>
            <div
              ref={featTitleRef.ref}
              style={{
                fontSize: isMobile ? 40 : 56, fontWeight: 900, letterSpacing: '-0.04em', lineHeight: 1.05, marginBottom: 16,
                animation: featTitleRef.inView ? `${isRTL ? 'clipRevealRTL' : 'clipReveal'} 0.8s cubic-bezier(0.22,1,0.36,1) both` : undefined,
                opacity: featTitleRef.inView ? undefined : 0,
              }}
            >
              <span className="grad">{c.featTitle}</span>
            </div>
            <p style={{ fontSize: isMobile ? 17 : 20, color: 'var(--text-2)', letterSpacing: '-0.01em', maxWidth: 440, margin: '0 auto' }}>
              {c.featSub}
            </p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: 16 }}>
            {c.features.map((f, i) => (
              <FeatureCard
                key={i}
                title={f.title}
                desc={f.desc}
                icon={FEATURE_META[i].icon}
                iconColor={FEATURE_META[i].iconColor}
                iconBg={FEATURE_META[i].iconBg}
                inViewData={featureRefs[i]}
                delay={i * 0.1}
                isMobile={isMobile}
              />
            ))}
          </div>
        </div>
      </section>

      {/* ── STICKY SHOWCASE (desktop only) ── */}
      {!isMobile && (
        <div ref={showcaseRef} style={{ position: 'relative', height: '260vh' }}>
          <div style={{ position: 'sticky', top: 0, height: '100vh', overflow: 'hidden' }}>
            {/* Section label */}
            <div style={{
              position: 'absolute', top: 40, left: '50%', transform: 'translateX(-50%)',
              fontSize: 12, fontWeight: 600, color: 'var(--blue)', letterSpacing: '0.08em',
              textTransform: 'uppercase', opacity: 0.75,
            }}>{c.showcaseLabel}</div>

            <div style={{
              height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: 80, padding: '0 80px',
            }}>
              {/* Left: text */}
              <div style={{ flex: 1, maxWidth: 420 }}>
                <div
                  key={scene}
                  style={{
                    opacity: sceneEntering ? 1 : 0,
                    transform: sceneEntering ? 'translateY(0)' : 'translateY(-18px)',
                    transition: sceneEntering
                      ? 'opacity 0.4s cubic-bezier(0.22,1,0.36,1), transform 0.4s cubic-bezier(0.22,1,0.36,1)'
                      : 'opacity 0.15s ease-in, transform 0.15s ease-in',
                  }}
                >
                  <div style={{ fontSize: 58, fontWeight: 900, letterSpacing: '-0.04em', lineHeight: 1.04, marginBottom: 24 }}>
                    <span className="grad">{c.scenes[scene].title}</span>
                  </div>
                  <p style={{ fontSize: 20, color: 'var(--text-2)', lineHeight: 1.65, letterSpacing: '-0.01em' }}>
                    {c.scenes[scene].desc}
                  </p>
                </div>
              </div>

              {/* Right: visual */}
              <div style={{ flex: 1, maxWidth: 480 }}>
                <ShowcaseVisual scene={scene} entering={sceneEntering} isRTL={isRTL} chatLabels={c.mockupChat} />
              </div>
            </div>

            {/* Scroll hint — shown only when not on last scene */}
            {scene < 3 && (
              <div style={{
                position: 'absolute', bottom: 60, left: '50%', transform: 'translateX(-50%)',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                animation: 'scrollBounce 1.4s ease-in-out infinite',
                pointerEvents: 'none',
              }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--blue)', letterSpacing: '0.06em', textTransform: 'uppercase', opacity: 0.8 }}>
                  {isRTL ? 'גלול' : 'scroll'}
                </span>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.85 }}>
                  <path d="M12 5v14M5 12l7 7 7-7"/>
                </svg>
              </div>
            )}

            {/* Progress dots */}
            <div style={{
              position: 'absolute', bottom: 36, left: '50%', transform: 'translateX(-50%)',
              display: 'flex', gap: 8, alignItems: 'center',
            }}>
              {[0,1,2,3].map(i => (
                <div key={i} style={{
                  width: i === scene ? 24 : 8, height: 8, borderRadius: 99,
                  background: i === scene ? 'var(--blue)' : 'var(--border-hi)',
                  transition: 'width 0.3s cubic-bezier(0.22,1,0.36,1), background 0.3s',
                }} />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── HOW IT WORKS ── */}
      <section style={{
        padding: sp,
        background: 'rgba(255,255,255,0.018)',
        borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)',
      }}>
        <div style={{ maxWidth: 960, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 56 }}>
            <div
              ref={stepsTitleRef.ref}
              style={{
                fontSize: isMobile ? 36 : 52, fontWeight: 900, letterSpacing: '-0.04em', color: 'var(--text)', marginBottom: 14,
                animation: stepsTitleRef.inView ? `${isRTL ? 'clipRevealRTL' : 'clipReveal'} 0.8s cubic-bezier(0.22,1,0.36,1) both` : undefined,
                opacity: stepsTitleRef.inView ? undefined : 0,
              }}
            >{c.stepsTitle}</div>
            <p style={{ fontSize: 18, color: 'var(--text-2)', letterSpacing: '-0.01em' }}>{c.stepsSub}</p>
          </div>
          <div style={{
            display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)',
            gap: isMobile ? 32 : 0, position: 'relative', direction: 'ltr',
          }}>
            {!isMobile && (
              <div style={{
                position: 'absolute', top: 28, left: '16.5%', right: '16.5%', height: 1,
                borderTop: '1px dashed var(--border-hi)', zIndex: 0, pointerEvents: 'none',
              }} />
            )}
            {c.steps.map((s, i) => (
              <StepCard key={i} s={s} inViewData={stepRefs[i]} delay={i * 0.12} />
            ))}
          </div>
        </div>
      </section>

      {/* ── FINAL CTA ── */}
      <section
        ref={ctaRef.ref}
        style={{
          padding: isMobile ? '90px 24px' : '130px 60px',
          textAlign: 'center', position: 'relative', overflow: 'hidden',
          opacity: ctaRef.inView ? 1 : 0,
          transform: ctaRef.inView ? 'translateY(0)' : 'translateY(30px)',
          transition: 'opacity 0.7s cubic-bezier(0.22,1,0.36,1), transform 0.7s cubic-bezier(0.22,1,0.36,1)',
        }}
      >
        <div style={{
          position: 'absolute', width: 600, height: 400, borderRadius: '50%',
          background: 'radial-gradient(ellipse, rgba(59,126,247,0.10) 0%, transparent 70%)',
          top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          zIndex: 0, pointerEvents: 'none',
        }} />
        <div style={{ position: 'relative', zIndex: 1, maxWidth: 600, margin: '0 auto' }}>
          <div style={{ fontSize: isMobile ? 40 : 60, fontWeight: 900, letterSpacing: '-0.04em', lineHeight: 1.05, marginBottom: 20 }}>
            <span className="grad">{c.ctaTitle}</span>
          </div>
          <p style={{ fontSize: 19, color: 'var(--text-2)', marginBottom: 40, letterSpacing: '-0.01em' }}>{c.ctaSub}</p>
          <div style={{
            display: 'flex', flexDirection: isMobile ? 'column' : 'row',
            alignItems: 'center', justifyContent: 'center', gap: 12,
          }}>
            <a href="/login" className="btn-primary" style={{
              padding: '17px 36px', borderRadius: 'var(--radius-lg)',
              fontSize: 18, fontWeight: 700, textDecoration: 'none', display: 'inline-block',
              width: isMobile ? '100%' : 'auto', boxSizing: 'border-box', textAlign: 'center',
            }}>{c.ctaBtn}</a>
            <a href="/login" style={{
              padding: '16px 32px', borderRadius: 'var(--radius-lg)',
              border: '1px solid var(--border-hi)', background: 'transparent',
              color: 'var(--text-2)', fontSize: 18, fontWeight: 600, cursor: 'pointer',
              textDecoration: 'none', display: 'inline-block',
              width: isMobile ? '100%' : 'auto', boxSizing: 'border-box', textAlign: 'center',
              transition: 'color var(--t-base), border-color var(--t-base)',
            }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--text)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--blue)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--text-2)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-hi)' }}
            >{c.ctaSignIn}</a>
          </div>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer style={{
        padding: '28px 40px', borderTop: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: 12, direction: 'ltr',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 28, height: 28, borderRadius: 8,
            background: 'linear-gradient(135deg,#3B7EF7,#6366F1)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 12, fontWeight: 900, color: '#fff', flexShrink: 0,
          }}>Z</div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.02em' }}>Zman</div>
            <div style={{ fontSize: 11, color: 'var(--text-3)', letterSpacing: '-0.01em' }}>{c.footerTagline}</div>
          </div>
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-3)' }}>{c.copyright}</div>
      </footer>
    </div>
  )
}

/* ─── FeatureCard ─── */
function FeatureCard({ title, desc, icon, iconColor, iconBg, inViewData, delay, isMobile }: {
  title: string; desc: string; icon: React.ReactNode
  iconColor: string; iconBg: string
  inViewData: ReturnType<typeof useInView>
  delay: number; isMobile: boolean
}) {
  const [tilt, setTilt] = useState({ x: 0, y: 0 })
  const [hovered, setHovered] = useState(false)

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isMobile) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width - 0.5
    const y = (e.clientY - rect.top)  / rect.height - 0.5
    setTilt({ x, y })
  }

  return (
    <div
      ref={inViewData.ref}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setTilt({ x: 0, y: 0 }) }}
      onMouseMove={handleMouseMove}
      style={{
        opacity: inViewData.inView ? 1 : 0,
        transform: inViewData.inView ? 'translateY(0)' : 'translateY(32px)',
        transition: `opacity 0.65s ${delay}s cubic-bezier(0.22,1,0.36,1), transform 0.65s ${delay}s cubic-bezier(0.22,1,0.36,1)`,
      }}
    >
      <div className="glass" style={{
        border: '1px solid var(--border-hi)', borderRadius: 'var(--radius-xl)',
        padding: '28px 28px 32px', height: '100%', boxSizing: 'border-box',
        transform: hovered && !isMobile
          ? `perspective(800px) rotateY(${tilt.x * 8}deg) rotateX(${-tilt.y * 8}deg) translateZ(4px) translateY(-4px)`
          : 'perspective(800px) rotateY(0) rotateX(0) translateZ(0) translateY(0)',
        boxShadow: hovered ? 'var(--shadow-xl), 0 0 40px rgba(59,126,247,0.10)' : 'var(--shadow-lg)',
        transition: 'transform 0.4s ease-out, box-shadow var(--t-slow)',
      }}>
        <div style={{
          width: 48, height: 48, borderRadius: 14, background: iconBg,
          border: `1px solid ${iconColor}33`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: iconColor, marginBottom: 20,
        }}>{icon}</div>
        <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.03em', color: 'var(--text)', marginBottom: 14 }}>{title}</div>
        <div style={{ fontSize: 16, color: 'var(--text-2)', lineHeight: 1.72, letterSpacing: '-0.01em' }}>{desc}</div>
      </div>
    </div>
  )
}

/* ─── StepCard ─── */
function StepCard({ s, inViewData, delay }: {
  s: { num: string; title: string; desc: string }
  inViewData: ReturnType<typeof useInView>
  delay: number
}) {
  const [count, setCount] = useState(0)
  const target = parseInt(s.num)

  useEffect(() => {
    if (!inViewData.inView) return
    let cur = 0
    const interval = setInterval(() => {
      cur++; setCount(cur)
      if (cur >= target) clearInterval(interval)
    }, Math.floor(600 / target))
    return () => clearInterval(interval)
  }, [inViewData.inView, target])

  return (
    <div
      ref={inViewData.ref}
      style={{
        padding: '0 32px', textAlign: 'center', position: 'relative', zIndex: 1,
        opacity: inViewData.inView ? 1 : 0,
        transform: inViewData.inView ? 'translateY(0)' : 'translateY(28px)',
        transition: `opacity 0.65s ${delay}s cubic-bezier(0.22,1,0.36,1), transform 0.65s ${delay}s cubic-bezier(0.22,1,0.36,1)`,
      }}
    >
      <div style={{
        width: 56, height: 56, borderRadius: '50%',
        background: 'rgba(59,126,247,0.10)', border: '1px solid rgba(59,126,247,0.22)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px',
      }}>
        <span className="grad" style={{ fontSize: 24, fontWeight: 900, letterSpacing: '-0.04em' }}>
          {count.toString().padStart(2, '0')}
        </span>
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.03em', color: 'var(--text)', marginBottom: 12 }}>{s.title}</div>
      <div style={{ fontSize: 16, color: 'var(--text-2)', lineHeight: 1.72, letterSpacing: '-0.01em', maxWidth: 260, margin: '0 auto' }}>{s.desc}</div>
    </div>
  )
}

/* ─── ShowcaseVisual ─── */
function ShowcaseVisual({ scene, entering, isRTL, chatLabels }: {
  scene: number; entering: boolean; isRTL: boolean
  chatLabels: readonly { user: boolean; text: string }[]
}) {
  const visuals = [
    // Scene 0: chat
    <div key={0} style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 10, justifyContent: 'center', minHeight: 200 }}>
      {chatLabels.map((m, i) => (
        <div key={i} style={{
          alignSelf: m.user ? 'flex-end' : 'flex-start', maxWidth: '75%',
          padding: '10px 14px',
          borderRadius: m.user ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
          background: m.user ? 'linear-gradient(135deg,#3B7EF7,#6366F1)' : 'rgba(22,22,38,0.9)',
          border: m.user ? 'none' : '1px solid rgba(255,255,255,0.08)',
          fontSize: 13, color: '#fff', lineHeight: 1.45,
        }}>{m.text}</div>
      ))}
    </div>,
    // Scene 1: calendar slots
    <div key={1} style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {[
        { t: '9:00', label: isRTL ? 'חלון פנוי ✓' : 'Free slot ✓', free: true, color: '#34D399' },
        { t: '10:30', label: isRTL ? 'חלון פנוי ✓' : 'Free slot ✓', free: true, color: '#34D399' },
        { t: '12:00', label: isRTL ? 'הפסקת צהריים' : 'Lunch break', free: false, color: '#FBBF24' },
        { t: '14:00', label: isRTL ? 'חלון פנוי ✓' : 'Free slot ✓', free: true, color: '#34D399' },
        { t: '16:00', label: isRTL ? 'סקירת קוד' : 'Code review', free: false, color: '#3B7EF7' },
      ].map((row, i) => (
        <div key={i} style={{
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <span style={{ fontSize: 12, color: 'var(--text-3)', width: 38, flexShrink: 0 }}>{row.t}</span>
          <div style={{
            flex: 1, height: 36, borderRadius: 8,
            background: row.free ? 'rgba(52,211,153,0.12)' : row.color + '22',
            border: `1px solid ${row.color}44`,
            display: 'flex', alignItems: 'center', paddingLeft: 12,
            fontSize: 12, color: row.color, fontWeight: 600,
          }}>{row.label}</div>
        </div>
      ))}
    </div>,
    // Scene 2: conflict resolution
    <div key={2} style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {[
        { label: isRTL ? 'ישיבת צוות 14:00' : 'Team meeting 14:00', old: true,  color: '#F87171' },
        { label: isRTL ? 'ביקורת 14:30' : 'Review 14:30',       old: true,  color: '#F87171' },
        { label: isRTL ? '↓ זזו אוטומטית ↓' : '↓ Auto-resolved ↓', old: false, color: 'var(--text-3)', divider: true },
        { label: isRTL ? 'ישיבת צוות 13:00' : 'Team meeting 13:00', old: false, color: '#34D399' },
        { label: isRTL ? 'ביקורת 15:30' : 'Review 15:30',       old: false, color: '#34D399' },
      ].map((row, i) => (
        <div key={i} style={{
          height: row.divider ? 'auto' : 36, borderRadius: row.divider ? 0 : 8,
          background: row.divider ? 'transparent' : (row.old ? 'rgba(248,113,113,0.10)' : 'rgba(52,211,153,0.10)'),
          border: row.divider ? 'none' : `1px solid ${row.color}44`,
          display: 'flex', alignItems: 'center',
          paddingLeft: row.divider ? 0 : 12, justifyContent: row.divider ? 'center' : 'flex-start',
          fontSize: 12, color: row.color, fontWeight: 600,
          textDecoration: row.old ? 'line-through' : 'none', opacity: row.old ? 0.5 : 1,
        }}>{row.label}</div>
      ))}
    </div>,
    // Scene 3: full week view
    <div key={3} style={{ padding: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }}>
        {(isRTL ? ['א׳','ב׳','ג׳','ד׳','ה׳'] : ['Mon','Tue','Wed','Thu','Fri']).map((day, di) => (
          <div key={di} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 10, color: 'var(--text-3)', textAlign: 'center', marginBottom: 4 }}>{day}</div>
            {[...Array(3 + (di % 2))].map((_, ei) => (
              <div key={ei} style={{
                height: 28, borderRadius: 6,
                background: ['#3B7EF722','#6366F122','#34D39922','#FBBF2422','#F9731622'][ei % 5],
                border: `1px solid ${['#3B7EF7','#6366F1','#34D399','#FBBF24','#F97316'][ei % 5]}44`,
              }} />
            ))}
          </div>
        ))}
      </div>
    </div>,
  ]

  return (
    <div className="glass" style={{
      border: '1px solid var(--border-hi)', borderRadius: 'var(--radius-xl)',
      boxShadow: 'var(--shadow-xl)', overflow: 'hidden', minHeight: 260,
      opacity: entering ? 1 : 0,
      transform: entering ? 'translateY(0) scale(1)' : 'translateY(22px) scale(0.98)',
      transition: entering
        ? 'opacity 0.4s cubic-bezier(0.22,1,0.36,1), transform 0.4s cubic-bezier(0.22,1,0.36,1)'
        : 'opacity 0.15s ease-in, transform 0.15s ease-in',
    }}>
      <div style={{
        height: 36, background: 'rgba(255,255,255,0.04)', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', padding: '0 14px', gap: 6, direction: 'ltr',
      }}>
        {['#ef4444','#fbbf24','#34d399'].map(col => (
          <div key={col} style={{ width: 9, height: 9, borderRadius: '50%', background: col, opacity: 0.6 }} />
        ))}
      </div>
      {visuals[scene]}
    </div>
  )
}
