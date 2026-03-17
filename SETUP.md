# Zman — Setup Guide

## 1. Supabase Setup

1. Go to [supabase.com](https://supabase.com) → New Project
2. In **SQL Editor**, run the full contents of `supabase/schema.sql`
3. In **Authentication → Providers**, enable:
   - Google (needs Google Cloud OAuth credentials)
   - Apple (needs Apple Developer account)
4. In **Authentication → URL Configuration**, set:
   - Site URL: `http://localhost:3000` (or your production URL)
   - Redirect URLs: add `http://localhost:3000/auth/callback`

## 2. Environment Variables

Copy `.env.local` and fill in:

```
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...   # from Supabase Project Settings → API

ANTHROPIC_API_KEY=sk-ant-...       # from console.anthropic.com
OPENAI_API_KEY=sk-...              # from platform.openai.com (for Whisper voice input)
```

## 3. Run Locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## 4. Deploy to Vercel

```bash
npm install -g vercel
vercel
```

Add all environment variables in Vercel dashboard under Project Settings → Environment Variables.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Frontend | Next.js 16 + React + Tailwind CSS |
| Backend | Next.js API Routes |
| Database | Supabase (PostgreSQL + Auth + Realtime) |
| AI Brain | Anthropic Claude API (claude-sonnet-4-6) |
| Speech-to-Text | OpenAI Whisper API |
| Calendar UI | FullCalendar.js |
| Hosting | Vercel |

## Features

- **Voice-first**: Hold the mic button to speak naturally
- **AI scheduling**: "I have an exam next Sunday" → AI creates study sessions
- **Split-screen**: Calendar on left, chat on right
- **Autonomy modes**: Suggest / Hybrid / Auto
- **Dark/Light theme**
- **Onboarding**: Conversational setup flow
- **PWA**: Install on mobile from browser
