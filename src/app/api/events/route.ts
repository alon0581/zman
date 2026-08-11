import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { userStore } from '@/lib/store/userStore'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'

async function getAuthUserId(): Promise<string | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(COOKIE_NAME)?.value
  return getUserIdFromCookie(token)
}

export async function GET(req: NextRequest) {
  const userId = await getAuthUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const events = userStore.getEvents(userId)
  return NextResponse.json({ events })
}

export async function DELETE(req: NextRequest) {
  const userId = await getAuthUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await req.json()

  userStore.deleteEvent(id, userId)
  return NextResponse.json({ success: true })
}
