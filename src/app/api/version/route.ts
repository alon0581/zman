import { NextResponse } from 'next/server'

/**
 * Public deploy-verification endpoint. Returns the commit Railway built from
 * (Railway injects RAILWAY_GIT_COMMIT_SHA automatically) so we can confirm —
 * without logging in — that the latest push actually went live. No auth, no
 * secrets, just the SHA + boot time.
 */
export const dynamic = 'force-dynamic'

const BOOT_TIME = new Date().toISOString()

export async function GET() {
  // Replicate the chat route's key check (ignoring any per-request state) so we
  // can see what the server WOULD use by default. Anthropic is the only provider.
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY

  return NextResponse.json({
    sha: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.SOURCE_COMMIT ?? 'unknown',
    bootedAt: BOOT_TIME,
    env: {
      AI_MODEL: process.env.AI_MODEL ?? null,
      has_ANTHROPIC_API_KEY: hasAnthropic,
    },
    resolvedProviderDefault: hasAnthropic ? 'anthropic' : 'none',
  })
}
