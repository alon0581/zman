// Legacy route — redirects to /api/profile
import { NextRequest, NextResponse } from 'next/server'

export function GET(req: NextRequest) {
  return NextResponse.redirect(new URL('/api/profile', req.url))
}

export function POST(req: NextRequest) {
  return NextResponse.redirect(new URL('/api/profile', req.url), { status: 307 })
}
