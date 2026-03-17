import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin', 'latin-ext'], variable: '--font-inter' })

export const metadata: Metadata = {
  title: 'Zman — AI Life Scheduler',
  description: 'Your AI-powered life scheduler. Just talk, Zman handles the rest.',
  manifest: '/manifest.json',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#080D1A',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <body className={inter.variable}>{children}</body>
    </html>
  )
}
