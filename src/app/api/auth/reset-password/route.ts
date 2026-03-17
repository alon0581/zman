import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { resetPassword, getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'

export async function POST(req: NextRequest) {
  try {
    // Require an active session — unauthenticated password resets are insecure
    // without email verification. Use this endpoint only from settings (logged in).
    const cookieStore = await cookies()
    const token = cookieStore.get(COOKIE_NAME)?.value
    const userId = getUserIdFromCookie(token)
    if (!userId) {
      return NextResponse.json({ error: 'נדרשת התחברות לשינוי סיסמה' }, { status: 401 })
    }

    const { newPassword } = await req.json() as { newPassword: string }

    if (!newPassword) {
      return NextResponse.json({ error: 'נדרשת סיסמה חדשה' }, { status: 400 })
    }

    const result = resetPassword(userId, newPassword)
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Reset password error:', err)
    return NextResponse.json({ error: 'שגיאת שרת' }, { status: 500 })
  }
}
