import { redirect } from 'next/navigation'
import { cookies, headers } from 'next/headers'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'
import LandingClient from './LandingClient'

export default async function RootPage() {
  const cookieStore = await cookies()
  const token = cookieStore.get(COOKIE_NAME)?.value
  const userId = getUserIdFromCookie(token)
  if (userId) redirect('/app')

  const headersList = await headers()
  const acceptLang = headersList.get('accept-language') ?? ''
  const lang: 'en' | 'he' = acceptLang.toLowerCase().startsWith('he') ? 'he' : 'en'

  return <LandingClient lang={lang} />
}
