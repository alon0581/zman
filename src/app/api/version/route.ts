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
  // Replicate the chat route's env-level precedence (ignoring any per-user key,
  // which is request-scoped) so we can see what the server WOULD use by default.
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY
  const hasMinimax = !!process.env.MINIMAX_API_KEY
  const hasOpenAI = !!process.env.OPENAI_API_KEY
  const envProvider = process.env.AI_PROVIDER
  const envKeyPresent =
    envProvider === 'anthropic' ? hasAnthropic :
    envProvider === 'minimax' ? hasMinimax :
    envProvider === 'openai' ? hasOpenAI : false
  let resolvedProvider = 'none'
  if (envProvider && envKeyPresent) resolvedProvider = envProvider
  else if (hasAnthropic) resolvedProvider = 'anthropic'
  else if (hasMinimax) resolvedProvider = 'minimax'
  else if (hasOpenAI) resolvedProvider = 'openai'

  return NextResponse.json({
    sha: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.SOURCE_COMMIT ?? 'unknown',
    bootedAt: BOOT_TIME,
    env: {
      AI_PROVIDER: envProvider ?? null,
      AI_MODEL: process.env.AI_MODEL ?? null,
      AI_MODEL_SIMPLE: process.env.AI_MODEL_SIMPLE ?? null,
      has_ANTHROPIC_API_KEY: hasAnthropic,
      has_MINIMAX_API_KEY: hasMinimax,
      has_OPENAI_API_KEY: hasOpenAI,
    },
    resolvedProviderDefault: resolvedProvider,
  })
}
