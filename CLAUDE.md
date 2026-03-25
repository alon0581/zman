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
| Auth | File-based (`crypto.scryptSync` + HMAC, no external service) |
| DB | File system (`data/users/{id}/`) — Supabase optional/legacy |
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
    AppShell.tsx                — Layout shell (desktop: Header+Calendar+Tasks; mobile: minimal top bar + 2-tab bar)
    CalendarPanel.tsx           — FullCalendar wrapper with EventPopup + pinch-to-zoom + swipe
    ChatOverlay.tsx             — Floating chat panel (desktop: side drawer; mobile: bottom sheet)
    ChatPanel.tsx               — ⚠️ UNUSED — was replaced by ChatOverlay + VoiceFAB
    EventPopup.tsx              — Apple Calendar-style inline event editor popup
    Header.tsx                  — Top nav (desktop only; hidden on mobile)
    TasksPanel.tsx              — Task list with AI scheduling
    Toast.tsx                   — Notification toasts (Motion spring animations)
    VoiceFAB.tsx                — Floating mic button (hold=auto-send, tap=edit mode)
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

## Mic (`src/components/VoiceFAB.tsx`)

Floating action button — handles all voice input.

- **Hold** (press & hold ≥400ms → speak → release) → transcription **auto-sends** to chat
- **Tap** (quick press → speak → tap again) → transcription appears **in input** for editing
- **Double-tap** → opens ChatOverlay

### Guards
- Ignores blobs smaller than **1 KB** (near-silence)
- `cachedStreamRef` — reuses the same `MediaStream` to avoid repeated permission prompts

---

## Chat Engine (`src/hooks/useChatEngine.ts`)

Shared hook used by both `AppShell` and `ChatOverlay`. Handles:
- Message state + streaming SSE reader
- Tool call results → calendar/task updates
- Toast notifications
- Onboarding flow

### SSE stream format
```
{ type: 'events', createdEvents, updatedEvents, deletedEventIds }
{ type: 'text', content: '...' }   → streamed AI text
{ type: 'done' }
{ type: 'error' }
```

---

## Responsive Layout (`src/components/AppShell.tsx`)

### Desktop (≥ 768px)
- Full `<Header>` at top
- Side-by-side: **Calendar** (flex:2) on the left · **Tasks** (340px) on the right
- `ChatOverlay` opens as a side drawer (spring animation from right/left)
- Layout wrapper always uses `direction: 'ltr'`

### Mobile (< 768px)
- Minimal top bar (Z logo + theme toggle + settings icon) — replaces full Header
- One panel visible at a time: Calendar **or** Tasks
- `mobileTab: 'calendar' | 'tasks'` controls which panel shows
- **Bottom tab bar: 2 tabs** — 📅 Calendar | ☑️ Tasks
  - `ChatOverlay` opens via **double-tap on the VoiceFAB mic button** (no separate tab)
- `isMobile = window.innerWidth < 768` + resize listener
- Safe-area padding for iPhone home bar (`env(safe-area-inset-bottom)`)

---

## CalendarPanel (`src/components/CalendarPanel.tsx`)

### Views
| Key | Desktop | Mobile |
|---|---|---|
| `timeGridDay` | ✅ | ✅ |
| `timeGrid3Day` | ✅ | ✅ |
| `timeGridWeek` | ✅ | ❌ (removed — unreadable on small screen) |
| `dayGridMonth` | ✅ | ✅ |

- **Mobile default**: `timeGridDay`; **Desktop default**: `timeGridWeek`
- Custom `timeGrid3Day` view: `type: 'timeGrid', duration: { days: 3 }`
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

## Motion Animations (`motion/react` v12)

All animations use spring physics via the `motion/react` package (Framer Motion v12).

| Component | Animation |
|---|---|
| `Toast.tsx` | `AnimatePresence` + spring slide-in/out (replaces CSS `toastSlideIn`) |
| `ChatOverlay.tsx` | Desktop: spring drawer from side; Mobile: spring sheet from bottom |
| `VoiceFAB.tsx` | `motion.button` with `whileTap`, animated bg/shadow, icon crossfade |
| `LandingClient.tsx` | `whileInView` stagger for features/steps, clip-path title reveal |
| `TasksPanel.tsx` | `layout` + stagger + exit animations for task list |
| `AppShell.tsx` | `AnimatePresence` wrapping `ChatOverlay` |

CSS keyframes removed: `toastSlideIn`, `backdropFadeIn`, `drawerSlideIn`, `sheetSlideUp`.

---

## Mobile UI (Native App Feel)

The mobile layout is designed to look like a native iOS app, not a website.

### Mobile-specific layout
- **Header**: Full `<Header>` is hidden on mobile. A minimal top bar replaces it (Z logo + theme toggle + settings icon).
- **Bottom tab bar**: 2 tabs — Calendar | Tasks
  - Settings accessible via ⚙️ in the top bar
- **VoiceFAB**: Floating mic button, positioned above the tab bar; **double-tap opens ChatOverlay**
- **Calendar views on mobile**: `timeGridDay` (Day), `timeGrid3Day` (3 Days), `dayGridMonth` (Month) — no week view
- **View switcher**: iOS segmented control style (gray pill, white selected, subtle shadow)

### Mobile breakpoint
`isMobile = window.innerWidth < 768`

---

## Pending / Known Issues (as of 2026-03-25)

| # | Issue | File | Status |
|---|---|---|---|
| 1 | AI sometimes returns "Done!" with no content | `ChatPanel.tsx` L138-141 | Fallback — rare edge case |
| 2 | Push notifications require real Firebase project | `android/app/google-services.json` | Placeholder in place; real setup needed |
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
- On success → `window.location.href = '/app'`
- Error displayed inline in Hebrew

---

## Running the App

```bash
cd C:\Users\אלון עוזרי\Desktop\test\zman
npm run dev        # starts on http://localhost:3000
npx tsc --noEmit   # type check only (no build)
npm run lint       # eslint
```

---

## Platforms

Zman runs on **three platforms**. All share the same Railway backend. Capacitor wraps Railway in a native WebView — no static export needed.

---

### Platform 1: Browser / PWA

| Item | Value |
|---|---|
| URL | `https://zman-production.up.railway.app` |
| Push | VAPID web-push via `web-push` npm package |
| Auth | `zman_session` HttpOnly cookie |
| Mic | Requires permission per browser session (Safari resets each time) |
| Status | ✅ Live on Railway |

**Push flow:** `Header.tsx` → `Notification.requestPermission()` → `reg.pushManager.subscribe()` → `POST /api/push/subscribe`

---

### Platform 2: Android APK (Capacitor 8)

| Item | Value |
|---|---|
| Package | `com.zman.app` |
| Loads | Railway URL in native WebView |
| Mic | Permission remembered permanently (key advantage over browser) |
| Push | FCM via `@capacitor/push-notifications` |
| Status | ✅ Debug APK built — `Desktop/zman-debug.apk` (5.9MB) |

**Build prerequisites (installed on this machine):**
| Tool | Location |
|---|---|
| JDK 21 (Amazon Corretto) | `C:\Program Files\Amazon Corretto\jdk21.0.10_7` |
| Android SDK | `C:\android-sdk` |
| Platform | `android-36` |
| Build Tools | `36.0.0` |

**To build debug APK:**
```bash
npx cap sync android

powershell -Command "
  \$env:JAVA_HOME = 'C:\Program Files\Amazon Corretto\jdk21.0.10_7'
  \$env:ANDROID_SDK_ROOT = 'C:\android-sdk'
  \$env:PATH = \$env:JAVA_HOME + '\bin;' + \$env:PATH
  Set-Location 'C:\Users\6946~1\Desktop\test\zman\android'
  & .\gradlew.bat assembleDebug
"
# Output: android/app/build/outputs/apk/debug/app-debug.apk
```

**Known issues / gotchas:**
- `android/gradle.properties` must contain `android.overridePathCheck=true` (Hebrew path in project dir)
- `android/app/google-services.json` — placeholder exists; replace with real file for actual FCM push
- Without `google-services.json`, the app crashes after login (Firebase init failure at runtime)

**To set up real Firebase push:**
1. https://console.firebase.google.com → create project "Zman"
2. Add Android app with package `com.zman.app`
3. Download `google-services.json` → replace `android/app/google-services.json`
4. Project Settings → Service Accounts → Generate private key → Railway env: `FIREBASE_SERVICE_ACCOUNT=<JSON>`

**Push flow:** `registerCapacitorPush()` in AppShell → FCM token → `POST /api/push/subscribe` `{type:'fcm'}` → stored in profile → `sendFcmPush()` via Firebase Admin

---

### Platform 3: iOS (AltStore Sideload)

| Item | Value |
|---|---|
| Package | `com.zman.app` (same as Android) |
| Loads | Railway URL in WKWebView |
| Mic | Permission remembered permanently |
| Push | APNs via `@capacitor/push-notifications` |
| Status | ✅ Sideloaded via AltStore (no paid Apple Developer account) |

**Approach:** GitHub Actions builds the IPA (free macOS runners) → AltStore installs it via AltServer on Windows.

**Requirements:**
- Regular Apple ID (free) — no $99/year Developer Account needed
- AltServer installed on Windows (from altstore.io)
- iPhone connected via USB when refreshing
- IPA expires every **7 days** → AltStore auto-refreshes when AltServer is running on the PC

**Build flow:**
1. GitHub Actions CI (macOS runner) builds IPA via `xcodebuild`
2. IPA downloaded from GitHub Actions artifacts
3. AltServer on Windows → "Sideload .ipa" → selects IPA → installs to iPhone

**Refresh flow:**
- AltServer runs in Windows system tray
- iPhone on same WiFi or connected via USB
- AltStore auto-refreshes before 7-day expiry

**Push flow (iOS):** Same Capacitor plugin — `PushNotifications.register()` → APNs token → `POST /api/push/subscribe` `{type:'fcm'}` → Firebase handles APNs delivery

---

### Push Notification Summary
| Platform | Method | Status |
|---|---|---|
| Browser | VAPID web-push | ✅ Working |
| Android | FCM (Firebase Cloud Messaging) | ⏳ Needs real `google-services.json` |
| iOS | APNs via Firebase | ⏳ Needs Xcode + `GoogleService-Info.plist` |

Both native platforms use the same `registerCapacitorPush()` function in `AppShell.tsx`. FCM takes priority over VAPID in the `send_notification` AI tool.
