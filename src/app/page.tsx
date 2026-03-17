import { redirect } from 'next/navigation'
import { cookies, headers } from 'next/headers'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'
import LandingClient from './LandingClient'

const DEMO_MODE = !process.env.NEXT_PUBLIC_SUPABASE_URL?.startsWith('http')

export default async function RootPage() {
  if (DEMO_MODE) {
    const cookieStore = await cookies()
    const token = cookieStore.get(COOKIE_NAME)?.value
    const userId = getUserIdFromCookie(token)
    if (userId) redirect('/app')
  } else {
    const { createClient } = await import('@/lib/supabase/server')
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (user) redirect('/app')
  }

  const headersList = await headers()
  const acceptLang = headersList.get('accept-language') ?? ''
  const lang: 'en' | 'he' = acceptLang.toLowerCase().startsWith('he') ? 'he' : 'en'

  return <LandingClient lang={lang} />
}
