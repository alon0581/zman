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
  return NextResponse.json({
    sha: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.SOURCE_COMMIT ?? 'unknown',
    bootedAt: BOOT_TIME,
    provider: process.env.AI_PROVIDER ?? null,
  })
}
