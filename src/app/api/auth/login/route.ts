import { NextRequest, NextResponse } from 'next/server'
import { loginUser, checkRateLimit, RATE_MAX_LOGIN, COOKIE_NAME, COOKIE_MAX_AGE } from '@/lib/auth'

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json() as { email: string; password: string }

    if (!email || !password) {
      return NextResponse.json({ error: 'נדרשים אימייל וסיסמה' }, { status: 400 })
    }

    // Rate limit: max 10 attempts per 15 min per email
    const rl = checkRateLimit(`login:${email.toLowerCase().trim()}`, RATE_MAX_LOGIN)
    if (!rl.allowed) {
      return NextResponse.json({ error: 'יותר מדי ניסיונות. נסה שוב בעוד 15 דקות.' }, { status: 429 })
    }

    const result = loginUser(email, password)
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 401 })
    }

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
    console.error('Login error:', err)
    return NextResponse.json({ error: 'שגיאת שרת' }, { status: 500 })
  }
}
