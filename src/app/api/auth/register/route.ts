import { NextRequest, NextResponse } from 'next/server'
import { registerUser, checkRateLimit, RATE_MAX_REGISTER, COOKIE_NAME, COOKIE_MAX_AGE } from '@/lib/auth'
import path from 'path'
import { DATA_DIR } from '@/lib/util/dataDir'
import { writeJsonFileAtomic } from '@/lib/util/jsonStore'
import { UserProfile } from '@/types'

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json() as { email: string; password: string }

    if (!email || !password) {
      return NextResponse.json({ error: 'נדרשים אימייל וסיסמה' }, { status: 400 })
    }
    if (password.length < 12) {
      return NextResponse.json({ error: 'הסיסמה חייבת להכיל לפחות 12 תווים' }, { status: 400 })
    }

    // Rate limit: max 5 registrations per 15 min per IP
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0] ?? 'unknown'
    const rl = checkRateLimit(`register:${ip}`, RATE_MAX_REGISTER)
    if (!rl.allowed) {
      return NextResponse.json({ error: 'יותר מדי ניסיונות. נסה שוב בעוד 15 דקות.' }, { status: 429 })
    }

    const result = registerUser(email, password)
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 409 })
    }

    // Create default profile for new user (writeJsonFileAtomic creates the dir)
    const profileFile = path.join(DATA_DIR, 'users', result.userId, 'profile.json')
    // Auto-detect language from browser's Accept-Language header
    const acceptLang = req.headers.get('accept-language') ?? ''
    const detectedLang = acceptLang.toLowerCase().startsWith('he') ? 'he' : 'en'

    const defaultProfile: UserProfile = {
      user_id: result.userId,
      autonomy_mode: 'hybrid',
      theme: 'dark',
      language: detectedLang,
      onboarding_completed: false,
      productivity_peak: 'morning',
    }
    writeJsonFileAtomic(profileFile, defaultProfile)

    const res = NextResponse.json({ success: true })
    res.cookies.set(COOKIE_NAME, result.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: COOKIE_MAX_AGE,
      path: '/',
    })
    return res
  } catch (err) {
    console.error('Register error:', err)
    return NextResponse.json({ error: 'שגיאת שרת' }, { status: 500 })
  }
}
