import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'
import { userStore } from '@/lib/store/userStore'

/**
 * Read-only. Settings shows the active phase's label + start date so the user
 * can see what the app currently believes about them — the declaration itself
 * stays conversational (start_phase / end_phase via chat), so there is no
 * POST/PUT here and there must not be one; see CLAUDE.md's phases section.
 */
export async function GET(req: NextRequest) {
  const cookieStore = await cookies()
  const token = cookieStore.get(COOKIE_NAME)?.value
  const userId = getUserIdFromCookie(token)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json({ active: userStore.getActivePhase(userId) })
}
