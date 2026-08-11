import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { COOKIE_NAME, getUserIdFromCookie, revokeUserSessions } from '@/lib/auth'

export async function POST() {
  // Clearing the cookie only drops this browser's copy — a leaked or copied token
  // would stay valid for its full 30 days. Bump the user's tokenVersion so every
  // token issued so far stops verifying.
  const cookieStore = await cookies()
  const userId = getUserIdFromCookie(cookieStore.get(COOKIE_NAME)?.value)
  if (userId) {
    const revoked = revokeUserSessions(userId)
    // Best-effort: never block the logout on it, or a user with an unwritable
    // store could not sign out at all.
    if (!revoked.success) console.warn('[AUTH] Logout could not revoke sessions for', userId, '—', revoked.error)
  }

  const res = NextResponse.json({ success: true })
  res.cookies.set(COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  })
  return res
}
