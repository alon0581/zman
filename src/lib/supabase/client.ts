import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const rawKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
  const url = rawUrl.startsWith('http') ? rawUrl : 'https://placeholder.supabase.co'
  const key = rawKey.startsWith('eyJ') ? rawKey : 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.placeholder'
  return createBrowserClient(url, key)
}
