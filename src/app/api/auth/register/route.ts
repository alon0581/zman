import { NextRequest, NextResponse } from 'next/server'
import { registerUser, COOKIE_NAME, COOKIE_MAX_AGE } from '@/lib/auth'
import fs from 'fs'
import path from 'path'
import { UserProfile } from '@/types'

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json() as { email: string; password: string }

    if (!email || !password) {
      return NextResponse.json({ error: 'נדרשים אימייל וסיסמה' }, { status: 400 })
    }
    if (password.length < 6) {
      return NextResponse.json({ error: 'הסיסמה חייבת להכיל לפחות 6 תווים' }, { status: 400 })
    }

    const result = registerUser(email, password)
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 409 })
    }

    // Create default profile for new user
    const profileDir = path.join(process.cwd(), 'data', 'users', result.userId)
    if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true })
    const profileFile = path.join(profileDir, 'profile.json')
    // Auto-detect language from browser's Accept-Language header
    const acceptLang = req.headers.get('accept-language') ?? ''
    const detectedLang = acceptLang.toLowerCase().startsWith('he') ? 'he' : 'en'

    const defaultProfile: UserProfile = {
      user_id: result.userId,
      autonomy_mode: 'hybrid',
      theme: 'dark',
      voice_response_enabled: false,
      language: detectedLang,
      onboarding_completed: false,
      productivity_peak: 'morning',
    }
    fs.writeFileSync(profileFile, JSON.stringify(defaultProfile, null, 2))

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
