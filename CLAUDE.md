# Zman — AI Life Scheduler · CLAUDE.md

> Context file for Claude Code. Keep this updated whenever major changes are made.

---

## Project Overview

**Zman** is an AI-powered life scheduler built with Next.js 16 (App Router).
The user has a split-panel interface: calendar on the left, AI chat on the right.
The AI assistant (GPT-4o-mini) can create/move/delete calendar events via tool calls.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16.1.6 (App Router, TypeScript) |
| UI | React 19, Tailwind CSS v4, Lucide icons |
| Calendar | FullCalendar 6 (`daygrid`, `timegrid`, `interaction`, `list`) |
| AI | OpenAI SDK (`openai` v6) — GPT-4o-mini |
| Auth / DB | Supabase (`@supabase/supabase-js` v2) |
| Date utils | `date-fns` v4 |
| Run | `npm run dev` (port 3000) |
| Lint / Check | `npx tsc --noEmit` |

---

## Environment & Modes

### Demo Mode (no Supabase needed)
Active when `NEXT_PUBLIC_SUPABASE_URL` is **not** set or doesn't start with `http`.
- User ID is hardcoded as `'demo'`
- Events stored in `data/demo-events.json` (auto-created)
- Profile stored in `data/demo-profile.json`
- No auth redirect — loads directly into the app

### Production Mode
Requires `.env.local`:
```
NEXT_PUBLIC_SUPABASE_URL=https://...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
OPENAI_API_KEY=sk-...
```

---

## Project Structure

```
src/
  app/
    page.tsx                    — Root page (demo or Supabase auth)
    layout.tsx                  — Root layout (fonts, globals)
    globals.css                 — CSS variables (--bg, --text, --blue, etc.), theme vars
    api/
      chat/route.ts             — POST: AI chat endpoint (tool-call loop + SSE stream)
      transcribe/route.ts       — POST: Whisper transcription (multipart/form-data)
      events/route.ts           — GET: fetch all events
      events/[id]/route.ts      — PUT: update single event (title/time/color)
      demo-profile/route.ts     — GET/POST: demo profile read/write
      onboarding/route.ts       — POST: save onboarding data
  components/
    AppShell.tsx                — Layout shell: Header + CalendarPanel + ChatPanel
    CalendarPanel.tsx           — FullCalendar wrapper with EventPopup integration
    ChatPanel.tsx               — AI chat with mic (hold/toggle dual-mode)
    EventPopup.tsx              — Apple Calendar-style event editor popup
    Header.tsx                  — Top nav (theme toggle, language, user)
    OnboardingModal.tsx         — First-run onboarding form
  lib/
    ai/
      tools.ts                  — OpenAI tool definitions (create/move/delete/list/etc.)
      systemPrompt.ts           — System prompt builder (profile + events context)
    demo/
      storage.ts                — File-based demo storage (read/write demo-events.json)
    supabase/
      client.ts                 — Browser Supabase client
      server.ts                 — Server Supabase client (SSR cookies)
  types/
    index.ts                    — CalendarEvent, UserProfile, Task, Message, AIMemory
data/
  demo-events.json              — Demo event storage (auto-created, git-ignored)
  demo-profile.json             — Demo user profile (auto-created, git-ignored)
```

---

## Key Types (`src/types/index.ts`)

```ts
interface CalendarEvent {
  id: string; user_id: string; title: string; description?: string
  start_time: string; end_time: string; is_all_day: boolean
  color?: string; source: 'zman'|'apple_calendar'|'google_calendar'
  external_id?: string; created_by: 'user'|'ai'
  status: 'confirmed'|'proposed'; created_at: string
}
interface UserProfile {
  user_id: string; preferred_hours?: { start: number; end: number }
  productivity_peak?: 'morning'|'afternoon'|'evening'
  sleep_time?: string; wake_time?: string
  autonomy_mode: 'suggest'|'auto'|'hybrid'
  theme: 'dark'|'light'; voice_response_enabled: boolean
  language: string; onboarding_completed: boolean; occupation?: string
}
```

---

## Chat API (`src/app/api/chat/route.ts`)

The core AI logic lives here. Flow:

1. **Tool-call loop** (non-streaming, up to 10 iterations):
   - Sends messages + `calendarTools` to GPT-4o-mini
   - Executes any tool calls (`create_event`, `move_event`, `delete_event`, `get_free_slots`, `break_down_task`, `list_events`)
   - Loops until no tool calls remain
   - Saves the final AI text in `lastContent`

2. **SSE stream** (ReadableStream):
   - First chunk: `{ type: 'events', createdEvents, updatedEvents, deletedEventIds }`
   - If `lastContent` is set → sends it as `{ type: 'text', content: lastContent }` (no extra API call)
   - Otherwise → streams a fresh completion (for pure conversational replies)
   - Final chunk: `{ type: 'done' }`

### Tool definitions (`src/lib/ai/tools.ts`)
- `create_event` — creates event; server-side duplicate check built into `executeTool`
- `move_event` — updates start/end times
- `delete_event` — deletes by id
- `get_free_slots` — finds gaps respecting profile hours
- `break_down_task` — splits task into N sessions across free slots
- `list_events` — lists events in date range

### Color convention (used in tools.ts + systemPrompt.ts)
| Color | Hex | Use |
|---|---|---|
| Blue | `#3B7EF7` | Work / meetings / calls |
| Indigo | `#6366F1` | Study / exams / homework |
| Green | `#34D399` | Fitness / gym / sport |
| Yellow | `#FBBF24` | Personal / errands |
| Orange | `#F97316` | Social / friends / fun |

---

## Mic Dual-Mode (`src/components/ChatPanel.tsx`)

The mic button supports two modes:
- **Hold** (press & hold → speak → release) → transcription **auto-sends** to chat
- **Toggle** (tap once → speak → tap again) → transcription appears **in input** for editing

### Refs used
```ts
isHoldingRef  // true while pointer is pressed
holdModeRef   // true = hold mode (set at rec.start() time)
sendMsgRef    // ref to latest sendMessage (avoids stale closure in onstop)
```

### Guards in `onstop`
- Ignores recordings shorter than **600ms**
- Ignores blobs smaller than **3 KB** (near-silence)

### Button events
```tsx
onPointerDown={handlePointerDown}
onPointerUp={handlePointerUp}
onPointerLeave={handlePointerUp}   // drag off = same as release
disabled={micPending}
```

---

## ChatPanel SSE Reader

Parses `text/event-stream` line by line:
```
{ type: 'events', createdEvents, updatedEvents, deletedEventIds }  → store for later
{ type: 'text', content: '...' }  → append to streaming message
{ type: 'done' }  → apply event updates to calendar
{ type: 'error' }  → show error message
```

**Important**: Lines 138-141 in ChatPanel.tsx show a `'Done!'` fallback if streaming never started — this is intentional for edge cases but should rarely trigger.

---

## Responsive Layout (`src/components/AppShell.tsx`)

### Desktop (≥ 768px)
- Side-by-side: **Calendar** (flex:1) on the left · **Chat** (420px) on the right
- Layout wrapper always uses `direction: 'ltr'` so chat is always on the right regardless of RTL language
- Header also uses `direction: 'ltr'` so logo is always left, actions always right

### Mobile (< 768px)
- One panel visible at a time (Calendar or Chat)
- Bottom tab bar with two tabs: 📅 Calendar / 💬 Assistant
- `isMobile` state set via `window.innerWidth < 768` + resize listener
- `mobileTab: 'calendar' | 'chat'` state controls which panel is shown
- Safe-area padding for iPhone home bar (`env(safe-area-inset-bottom)`)

---

## CalendarPanel (`src/components/CalendarPanel.tsx`)

### Views
| Key | Label (HE) | Label (EN) |
|---|---|---|
| `timeGridDay` | יום | Day |
| `timeGrid3Day` | 3 ימים | 3 Days |
| `timeGridWeek` | שבוע | Week |
| `dayGridMonth` | חודש | Month |

- Custom `timeGrid3Day` view defined via FC `views` prop (`type: 'timeGrid', duration: { days: 3 }`)
- **Mobile default**: `timeGrid3Day`; **Desktop default**: `timeGridWeek`
- Accepts `isMobile?: boolean` prop from AppShell

### Navigation
- FullCalendar `headerToolbar={false}` — we use our own buttons
- `ChevronLeft` → `calApi.prev()` (always = back in time / older dates)
- `ChevronRight` → `calApi.next()` (always = forward in time / newer dates)
- `direction="ltr"` is explicitly set on FC — this ensures `prev()`/`next()` are always temporal regardless of Hebrew locale (Hebrew locale by default sets RTL which flips their meaning)
- View changes use `calApi.changeView(view)` via `useEffect` (no full remount)
- FC `key={language}` — remounts only on language change

### Month view
- Desktop: `dayMaxEvents: 4` — shows up to 4 events per day, then "+N more" popover
- Mobile: `dayMaxEvents: 2` — shows up to 2 events per day, then "+N more" popover (prevents tiny unreadable text)

### Localization
- Month title: `format(currentDate, 'MMMM yyyy', { locale: heLocale })` from `date-fns/locale`
- FullCalendar locale: `@fullcalendar/core/locales/he` loaded dynamically for Hebrew
- Header wrapper uses `direction: 'ltr'` so layout is always consistent

### Event Popup
- `eventClick` opens `EventPopup` near cursor (desktop) or centered on screen (mobile)
- `EventPopup` is an Apple Calendar-style inline editor (title, time, color, delete/save)
- `onEventUpdate(id, changes)` → calls `PUT /api/events/[id]` → updates demo storage + state
- `onEventDelete(id)` → calls `DELETE /api/events/[id]` → removes from storage + state

---

## CSS Theming (`src/app/globals.css`)

CSS variables are toggled via `data-theme="dark"` / `data-theme="light"` on `<html>`:
```
--bg, --bg-panel, --bg-card, --bg-input
--text, --text-2
--border, --border-hi
--blue (#3B7EF7), --purple (#6366F1)
```

### Animation classes
- `.ai-new` — pulse/highlight on newly created AI events
- `.ai-proposed` — dashed border for proposed events
- `.mic-recording` — pulsing red shadow on mic button
- `.typing-dot` — bouncing dots for typing indicator

---

## Known Patterns & Conventions

- All API routes are in `src/app/api/` as `route.ts` files
- Server components fetch from Supabase directly; client components call `/api/` routes
- `DEMO_MODE` constant defined at top of each file that touches storage/auth
- No test framework — use `npx tsc --noEmit` to type-check
- Language detection: `profile?.language ?? language` prop → `isRTL` computed from `'he'|'ar'`
- Event IDs are `crypto.randomUUID()` (browser & Node compatible)

---

## Pending / Known Issues (as of 2026-03-16)

| # | Issue | File | Status |
|---|---|---|---|
| 1 | AI sometimes returns "Done!" with no content | `ChatPanel.tsx` L138-141 | Fallback — rare edge case |
| 2 | EventPopup: investigate if `PUT /api/events/[id]` exists | `src/app/api/events/[id]/route.ts` | Check if implemented |
| 3 | Work hours from profile not always respected | `get_free_slots` in route.ts | Implemented via `preferred_hours`/`wake_time`/`sleep_time` |

---

## Authentication System (`src/lib/auth/index.ts`)

File-based auth — no external dependencies. Uses Node.js `crypto` only.

### How it works
- **Registration**: `crypto.scryptSync` password hash + 16-byte random salt → stored in `data/auth/users.json`
- **Session token**: HMAC-SHA256 signed, base64url encoded, 30-day expiry → set as `zman_session` HttpOnly cookie
- **Per-user data**: `data/users/{userId}/events.json` + `data/users/{userId}/profile.json`

### Auth API routes
| Route | Method | Description |
|---|---|---|
| `/api/auth/register` | POST | `{email, password}` → sets cookie, creates default profile |
| `/api/auth/login` | POST | `{email, password}` → sets cookie |
| `/api/auth/logout` | POST | Clears cookie |
| `/api/profile` | GET/POST | Read/write profile (auth via cookie) |

### Data files
```
data/
  auth/
    users.json            — [{id, email, passwordHash, salt, createdAt}]
  users/
    {userId}/
      events.json         — per-user events
      profile.json        — per-user profile
```

### Sign-out
Both Header and SettingsClient call `POST /api/auth/logout` then redirect to `/login`.

### Login page (`src/app/login/page.tsx`)
- Tab switcher: **כניסה** (login) / **הרשמה** (register)
- Email + password form → POST to `/api/auth/login` or `/api/auth/register`
- On success → `router.push('/')` + `router.refresh()`
- Error displayed inline in Hebrew

---

## Running the App

```bash
cd C:\Users\אלון עוזרי\Desktop\test\zman
npm run dev        # starts on http://localhost:3000
npx tsc --noEmit   # type check only (no build)
npm run lint       # eslint
```
