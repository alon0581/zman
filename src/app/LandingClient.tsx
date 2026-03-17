'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'

/* ─── useInView: scroll-reveal hook ─── */
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

/* ─── Feature card data ─── */
const FEATURES = [
  {
    icon: <IconChat />,
    iconColor: '#3B7EF7',
    iconBg: 'rgba(59,126,247,0.15)',
    title: 'Talk, don\'t tap',
    desc: 'Describe your week in plain language. Zman\'s AI parses intent, resolves conflicts, and builds your schedule in seconds.',
  },
  {
    icon: <IconSparkles />,
    iconColor: '#6366F1',
    iconBg: 'rgba(99,102,241,0.15)',
    title: 'Thinks ahead',
    desc: 'Zman knows your productivity peaks, sleep schedule, and commitments. Events land where they fit best — automatically.',
  },
  {
    icon: <IconLock />,
    iconColor: '#34D399',
    iconBg: 'rgba(52,211,153,0.15)',
    title: 'Truly yours',
    desc: 'Your data lives on your device. No cloud syncing, no accounts required to try it. Privacy by default, always.',
  },
]

const STEPS = [
  { num: '01', title: 'Tell Zman', desc: 'Type or speak what you need scheduled. "Gym 3x this week, no earlier than 7am" — done.' },
  { num: '02', title: 'AI Does the Work', desc: 'Zman finds free slots, considers your habits and priorities, and fills your calendar intelligently.' },
  { num: '03', title: 'Review and Go', desc: 'Confirm or tweak conversationally. Your week, always under your control.' },
]

export default function LandingClient() {
  const router = useRouter()
  const [scrolled, setScrolled] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const [ghostHover, setGhostHover] = useState(false)

  /* scroll + resize listeners */
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40)
    const onResize = () => setIsMobile(window.innerWidth < 768)
    onResize()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onResize, { passive: true })
    return () => { window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onResize) }
  }, [])

  /* scroll-reveal refs for each section */
  const featureRefs = [useInView(), useInView(), useInView()]
  const stepRefs    = [useInView(), useInView(), useInView()]
  const ctaRef      = useInView(0.2)

  const sp = isMobile ? '80px 24px' : '120px 60px'

  return (
    <div style={{ minHeight: '100vh', background: 'transparent', fontFamily: 'var(--font-inter, system-ui, sans-serif)', overflowX: 'hidden' }}>

      {/* Keyframes */}
      <style>{`
        @keyframes landingFadeUp {
          from { opacity: 0; transform: translateY(22px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes landingFloatOrb {
          0%, 100% { transform: translateY(0px) scale(1); }
          50%      { transform: translateY(-24px) scale(1.04); }
        }
        @keyframes landingPulseRing {
          0%   { box-shadow: 0 0 0 0 rgba(59,126,247,0.5); }
          70%  { box-shadow: 0 0 0 10px rgba(59,126,247,0); }
          100% { box-shadow: 0 0 0 0 rgba(59,126,247,0); }
        }
      `}</style>

      {/* ── NAVBAR ── */}
      <nav style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 100,
        height: 64,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 32px',
        background: scrolled ? 'rgba(7,7,15,0.88)' : 'rgba(7,7,15,0)',
        backdropFilter: 'blur(28px) saturate(180%)',
        WebkitBackdropFilter: 'blur(28px) saturate(180%)',
        borderBottom: scrolled ? '1px solid var(--border)' : '1px solid transparent',
        transition: 'background 0.3s, border-color 0.3s',
      }}>
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }} onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
          <div style={{
            width: 34, height: 34, borderRadius: 10,
            background: 'linear-gradient(135deg,#3B7EF7,#6366F1)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 15, fontWeight: 900, color: '#fff',
            boxShadow: '0 4px 14px rgba(59,126,247,0.45)',
            flexShrink: 0,
          }}>Z</div>
          <span style={{ fontSize: 17, fontWeight: 800, letterSpacing: '-0.03em', color: 'var(--text)' }}>Zman</span>
        </div>

        {/* Nav right */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {!isMobile && (
            <a href="/login" style={{
              padding: '8px 18px', borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-hi)',
              background: 'transparent', color: 'var(--text-2)',
              fontSize: 14, fontWeight: 600, cursor: 'pointer',
              textDecoration: 'none',
              transition: 'color var(--t-base), border-color var(--t-base)',
            }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--text)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--blue)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--text-2)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-hi)' }}
            >
              Sign In
            </a>
          )}
          <a href="/login" className="btn-primary" style={{
            padding: isMobile ? '8px 16px' : '8px 20px',
            borderRadius: 'var(--radius-md)', fontSize: 14, fontWeight: 700,
            textDecoration: 'none', display: 'inline-block',
          }}>
            Get Started
          </a>
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
          animation: 'landingFloatOrb 9s ease-in-out infinite',
        }} />
        <div style={{
          position: 'absolute', width: 560, height: 560, borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(99,102,241,0.12) 0%, transparent 70%)',
          bottom: '-10%', right: '-8%', zIndex: 0, pointerEvents: 'none',
          animation: 'landingFloatOrb 11s ease-in-out infinite',
          animationDelay: '3s',
        }} />

        {/* Content */}
        <div style={{ position: 'relative', zIndex: 1, maxWidth: 760, width: '100%' }}>

          {/* Badge */}
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '5px 14px', borderRadius: 99,
            background: 'rgba(59,126,247,0.12)',
            border: '1px solid rgba(59,126,247,0.28)',
            color: 'var(--blue)', fontSize: 12, fontWeight: 600,
            marginBottom: 28, letterSpacing: '0.01em',
            animation: 'landingFadeUp 0.6s cubic-bezier(0.22,1,0.36,1) both',
          }}>
            <span style={{ fontSize: 10 }}>✦</span> AI-Powered Scheduling
          </div>

          {/* Headline */}
          <div style={{
            fontSize: isMobile ? 'clamp(44px, 11vw, 64px)' : 'clamp(60px, 7vw, 92px)',
            fontWeight: 900, letterSpacing: '-0.04em', lineHeight: 1.04,
            marginBottom: 20,
            animation: 'landingFadeUp 0.7s 0.1s cubic-bezier(0.22,1,0.36,1) both',
          }}>
            <div style={{ color: 'var(--text)' }}>Your life,</div>
            <div className="grad">beautifully scheduled.</div>
          </div>

          {/* Sub-headline */}
          <p style={{
            fontSize: isMobile ? 17 : 20,
            color: 'var(--text-2)', lineHeight: 1.55,
            letterSpacing: '-0.01em', maxWidth: 520, margin: '0 auto 36px',
            animation: 'landingFadeUp 0.7s 0.22s cubic-bezier(0.22,1,0.36,1) both',
          }}>
            Just tell Zman what you need. It thinks, plans, and organizes — so you don&apos;t have to.
          </p>

          {/* CTA row */}
          <div style={{
            display: 'flex', flexDirection: isMobile ? 'column' : 'row',
            alignItems: 'center', justifyContent: 'center', gap: 12,
            animation: 'landingFadeUp 0.7s 0.34s cubic-bezier(0.22,1,0.36,1) both',
          }}>
            <a href="/login" className="btn-primary" style={{
              padding: '15px 30px', borderRadius: 'var(--radius-lg)',
              fontSize: 16, fontWeight: 700, textDecoration: 'none',
              display: 'inline-block',
              width: isMobile ? '100%' : 'auto', boxSizing: 'border-box', textAlign: 'center',
            }}>
              Get Started — It&apos;s Free
            </a>
            <a href="/login" style={{
              padding: '14px 28px', borderRadius: 'var(--radius-lg)',
              border: ghostHover ? '1px solid var(--blue)' : '1px solid var(--border-hi)',
              background: 'transparent',
              color: ghostHover ? 'var(--text)' : 'var(--text-2)',
              fontSize: 16, fontWeight: 600, cursor: 'pointer', textDecoration: 'none',
              display: 'inline-block',
              width: isMobile ? '100%' : 'auto', boxSizing: 'border-box', textAlign: 'center',
              transition: 'border-color var(--t-base), color var(--t-base)',
            }}
              onMouseEnter={() => setGhostHover(true)}
              onMouseLeave={() => setGhostHover(false)}
            >
              Sign In →
            </a>
          </div>

          {/* Social proof */}
          <p style={{
            marginTop: 22, fontSize: 13, color: 'var(--text-3)', letterSpacing: '-0.01em',
            animation: 'landingFadeUp 0.7s 0.44s cubic-bezier(0.22,1,0.36,1) both',
          }}>
            Free to use &nbsp;·&nbsp; No credit card &nbsp;·&nbsp; Takes 30 seconds
          </p>
        </div>

        {/* App Mockup Card — desktop only */}
        {!isMobile && (
          <div style={{
            position: 'relative', zIndex: 1, marginTop: 64,
            width: '100%', maxWidth: 720,
            animation: 'landingFadeUp 0.8s 0.5s cubic-bezier(0.22,1,0.36,1) both',
          }}>
            <div className="glass" style={{
              border: '1px solid var(--border-hi)',
              borderRadius: 'var(--radius-xl)',
              boxShadow: 'var(--shadow-xl), 0 0 80px rgba(59,126,247,0.1)',
              overflow: 'hidden',
            }}>
              {/* Mock toolbar */}
              <div style={{
                height: 42, background: 'rgba(255,255,255,0.04)',
                borderBottom: '1px solid var(--border)',
                display: 'flex', alignItems: 'center', padding: '0 16px', gap: 8,
              }}>
                {['#ef4444','#fbbf24','#34d399'].map(c => (
                  <div key={c} style={{ width: 11, height: 11, borderRadius: '50%', background: c, opacity: 0.7 }} />
                ))}
                <div style={{ flex: 1, height: 20, borderRadius: 6, background: 'rgba(255,255,255,0.05)', marginLeft: 8 }} />
              </div>

              {/* Mock app body */}
              <div style={{ display: 'flex', height: 280 }}>
                {/* Calendar panel mock */}
                <div style={{ flex: 1, padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ height: 18, width: 100, borderRadius: 6, background: 'rgba(255,255,255,0.08)', marginBottom: 4 }} />
                  {[
                    { color: '#3B7EF7', w: '75%', label: 'Team standup' },
                    { color: '#6366F1', w: '55%', label: 'Deep work' },
                    { color: '#34D399', w: '45%', label: 'Gym session' },
                    { color: '#FBBF24', w: '65%', label: 'Lunch break' },
                    { color: '#3B7EF7', w: '50%', label: 'Code review' },
                  ].map((ev, i) => (
                    <div key={i} style={{
                      width: ev.w, height: 32, borderRadius: 8,
                      background: ev.color + '33',
                      border: `1px solid ${ev.color}55`,
                      display: 'flex', alignItems: 'center', paddingLeft: 10,
                      fontSize: 10, color: ev.color, fontWeight: 600, letterSpacing: '-0.01em',
                    }}>
                      {ev.label}
                    </div>
                  ))}
                </div>

                {/* Divider */}
                <div style={{ width: 1, background: 'var(--border)' }} />

                {/* Chat panel mock */}
                <div style={{ width: 220, padding: 16, display: 'flex', flexDirection: 'column', gap: 10, justifyContent: 'flex-end' }}>
                  {[
                    { user: true,  text: 'Add gym 3x this week' },
                    { user: false, text: "Done! I've added Mon, Wed, Fri at 7am" },
                    { user: true,  text: 'Move Friday to 8am' },
                    { user: false, text: 'Updated — Friday gym moved to 8:00 AM' },
                  ].map((msg, i) => (
                    <div key={i} style={{
                      alignSelf: msg.user ? 'flex-end' : 'flex-start',
                      maxWidth: '85%',
                      padding: '7px 10px',
                      borderRadius: msg.user ? '12px 12px 3px 12px' : '12px 12px 12px 3px',
                      background: msg.user
                        ? 'linear-gradient(135deg,rgba(59,126,247,0.85),rgba(99,102,241,0.85))'
                        : 'rgba(22,22,38,0.9)',
                      border: msg.user ? 'none' : '1px solid rgba(255,255,255,0.08)',
                      fontSize: 10, color: '#fff', lineHeight: 1.4,
                    }}>
                      {msg.text}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Reflection / glow under mockup */}
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
          {/* Section header */}
          <div style={{ textAlign: 'center', marginBottom: 56 }}>
            <div style={{ fontSize: isMobile ? 36 : 48, fontWeight: 900, letterSpacing: '-0.04em', lineHeight: 1.05, marginBottom: 14 }}>
              <span className="grad">Built different.</span>
            </div>
            <p style={{ fontSize: isMobile ? 16 : 18, color: 'var(--text-2)', letterSpacing: '-0.01em', maxWidth: 420, margin: '0 auto' }}>
              Everything your calendar should have been.
            </p>
          </div>

          {/* Cards grid */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)',
            gap: 16,
          }}>
            {FEATURES.map((f, i) => (
              <FeatureCard key={i} f={f} inViewData={featureRefs[i]} delay={i * 0.1} />
            ))}
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ── */}
      <section style={{
        padding: sp,
        background: 'rgba(255,255,255,0.018)',
        borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)',
      }}>
        <div style={{ maxWidth: 960, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 56 }}>
            <div style={{ fontSize: isMobile ? 32 : 44, fontWeight: 900, letterSpacing: '-0.04em', color: 'var(--text)', marginBottom: 12 }}>
              Three steps to a better week.
            </div>
            <p style={{ fontSize: 16, color: 'var(--text-2)', letterSpacing: '-0.01em' }}>
              No setup. No learning curve. Just talk.
            </p>
          </div>

          <div style={{
            display: 'grid',
            gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)',
            gap: isMobile ? 32 : 0,
            position: 'relative',
          }}>
            {/* Connector line (desktop) */}
            {!isMobile && (
              <div style={{
                position: 'absolute', top: 28, left: '16.5%', right: '16.5%', height: 1,
                borderTop: '1px dashed var(--border-hi)', zIndex: 0, pointerEvents: 'none',
              }} />
            )}

            {STEPS.map((s, i) => (
              <StepCard key={i} s={s} inViewData={stepRefs[i]} delay={i * 0.12} />
            ))}
          </div>
        </div>
      </section>

      {/* ── FINAL CTA ── */}
      <section ref={ctaRef.ref} style={{
        padding: isMobile ? '90px 24px' : '130px 60px',
        textAlign: 'center', position: 'relative', overflow: 'hidden',
        opacity: ctaRef.inView ? 1 : 0,
        transform: ctaRef.inView ? 'translateY(0)' : 'translateY(30px)',
        transition: 'opacity 0.7s cubic-bezier(0.22,1,0.36,1), transform 0.7s cubic-bezier(0.22,1,0.36,1)',
      }}>
        {/* Center glow */}
        <div style={{
          position: 'absolute', width: 600, height: 400, borderRadius: '50%',
          background: 'radial-gradient(ellipse, rgba(59,126,247,0.10) 0%, transparent 70%)',
          top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          zIndex: 0, pointerEvents: 'none',
        }} />

        <div style={{ position: 'relative', zIndex: 1, maxWidth: 600, margin: '0 auto' }}>
          <div style={{ fontSize: isMobile ? 36 : 52, fontWeight: 900, letterSpacing: '-0.04em', lineHeight: 1.05, marginBottom: 16 }}>
            <span className="grad">Ready to reclaim your time?</span>
          </div>
          <p style={{ fontSize: 17, color: 'var(--text-2)', marginBottom: 36, letterSpacing: '-0.01em' }}>
            Free to use. No credit card. No setup required.
          </p>
          <div style={{
            display: 'flex', flexDirection: isMobile ? 'column' : 'row',
            alignItems: 'center', justifyContent: 'center', gap: 12,
          }}>
            <a href="/login" className="btn-primary" style={{
              padding: '15px 32px', borderRadius: 'var(--radius-lg)',
              fontSize: 16, fontWeight: 700, textDecoration: 'none',
              display: 'inline-block',
              width: isMobile ? '100%' : 'auto', boxSizing: 'border-box', textAlign: 'center',
            }}>
              Start Scheduling Free
            </a>
            <a href="/login" style={{
              padding: '14px 28px', borderRadius: 'var(--radius-lg)',
              border: '1px solid var(--border-hi)',
              background: 'transparent', color: 'var(--text-2)',
              fontSize: 16, fontWeight: 600, cursor: 'pointer', textDecoration: 'none',
              display: 'inline-block',
              width: isMobile ? '100%' : 'auto', boxSizing: 'border-box', textAlign: 'center',
              transition: 'color var(--t-base), border-color var(--t-base)',
            }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--text)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--blue)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--text-2)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-hi)' }}
            >
              Sign In →
            </a>
          </div>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer style={{
        padding: '28px 40px',
        borderTop: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: 12,
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
            <div style={{ fontSize: 11, color: 'var(--text-3)', letterSpacing: '-0.01em' }}>AI Life Scheduler</div>
          </div>
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-3)' }}>© 2026 Zman</div>
      </footer>
    </div>
  )
}

/* ─── FeatureCard sub-component ─── */
function FeatureCard({ f, inViewData, delay }: {
  f: typeof FEATURES[0]
  inViewData: ReturnType<typeof useInView>
  delay: number
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      ref={inViewData.ref}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        opacity: inViewData.inView ? 1 : 0,
        transform: inViewData.inView ? 'translateY(0)' : 'translateY(32px)',
        transition: `opacity 0.65s ${delay}s cubic-bezier(0.22,1,0.36,1), transform 0.65s ${delay}s cubic-bezier(0.22,1,0.36,1), box-shadow var(--t-slow)`,
      }}
    >
      <div className="glass" style={{
        border: '1px solid var(--border-hi)',
        borderRadius: 'var(--radius-xl)',
        padding: '28px 28px 32px',
        height: '100%', boxSizing: 'border-box',
        transform: hovered ? 'translateY(-5px)' : 'translateY(0)',
        boxShadow: hovered ? 'var(--shadow-xl), 0 0 40px rgba(59,126,247,0.10)' : 'var(--shadow-lg)',
        transition: 'transform var(--t-slow), box-shadow var(--t-slow)',
      }}>
        {/* Icon */}
        <div style={{
          width: 48, height: 48, borderRadius: 14,
          background: f.iconBg,
          border: `1px solid ${f.iconColor}33`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: f.iconColor, marginBottom: 20,
        }}>
          {f.icon}
        </div>
        <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-0.03em', color: 'var(--text)', marginBottom: 10 }}>
          {f.title}
        </div>
        <div style={{ fontSize: 14, color: 'var(--text-2)', lineHeight: 1.65, letterSpacing: '-0.01em' }}>
          {f.desc}
        </div>
      </div>
    </div>
  )
}

/* ─── StepCard sub-component ─── */
function StepCard({ s, inViewData, delay }: {
  s: typeof STEPS[0]
  inViewData: ReturnType<typeof useInView>
  delay: number
}) {
  return (
    <div
      ref={inViewData.ref}
      style={{
        padding: '0 32px',
        textAlign: 'center', position: 'relative', zIndex: 1,
        opacity: inViewData.inView ? 1 : 0,
        transform: inViewData.inView ? 'translateY(0)' : 'translateY(28px)',
        transition: `opacity 0.65s ${delay}s cubic-bezier(0.22,1,0.36,1), transform 0.65s ${delay}s cubic-bezier(0.22,1,0.36,1)`,
      }}
    >
      {/* Step number bubble */}
      <div style={{
        width: 56, height: 56, borderRadius: '50%',
        background: 'rgba(59,126,247,0.10)',
        border: '1px solid rgba(59,126,247,0.22)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        margin: '0 auto 20px',
      }}>
        <span className="grad" style={{ fontSize: 20, fontWeight: 900, letterSpacing: '-0.04em' }}>
          {s.num}
        </span>
      </div>
      <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-0.03em', color: 'var(--text)', marginBottom: 10 }}>
        {s.title}
      </div>
      <div style={{ fontSize: 14, color: 'var(--text-2)', lineHeight: 1.65, letterSpacing: '-0.01em', maxWidth: 220, margin: '0 auto' }}>
        {s.desc}
      </div>
    </div>
  )
}
