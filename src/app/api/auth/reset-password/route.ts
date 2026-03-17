import { NextRequest, NextResponse } from 'next/server'
import { resetPassword } from '@/lib/auth'

export async function POST(req: NextRequest) {
  try {
    const { email, newPassword } = await req.json() as { email: string; newPassword: string }

    if (!email || !newPassword) {
      return NextResponse.json({ error: 'נדרשים אימייל וסיסמה חדשה' }, { status: 400 })
    }

    const result = resetPassword(email, newPassword)
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Reset password error:', err)
    return NextResponse.json({ error: 'שגיאת שרת' }, { status: 500 })
  }
}
