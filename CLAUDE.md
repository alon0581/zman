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
      events/[id]/route.ts      — PUT: update single event (title/time/color/mobility_type)
      memory/route.ts           — GET/POST/DELETE: AI memory key-value store
      demo-profile/route.ts     — GET/POST: demo profile read/write
      onboarding/route.ts       — POST: save onboarding data
  components/
    AppShell.tsx                — Layout shell; triggers MethodOnboardingModal if no scheduling_method
    CalendarPanel.tsx           — FullCalendar wrapper with EventPopup + pinch-to-zoom + swipe
    ChatOverlay.tsx             — Floating chat panel (desktop: side drawer; mobile: bottom sheet)
    ChatPanel.tsx               — ⚠️ UNUSED — was replaced by ChatOverlay + VoiceFAB
    EventPopup.tsx              — Apple Calendar-style inline editor (+ mobility_type + AI reasoning)
    Header.tsx                  — Top nav (desktop only; hidden on mobile)
    MethodOnboardingModal.tsx   — AI chat popup for users with no scheduling_method yet
    TasksPanel.tsx              — Task list with AI scheduling
    Toast.tsx                   — Notification toasts (Motion spring animations)
    VoiceFAB.tsx                — Floating mic button (hold=auto-send, tap=edit mode)
    OnboardingModal.tsx         — First-run onboarding form
  lib/
    ai/
      tools.ts                  — OpenAI tool definitions (create/move/update/delete/list/etc.)
      systemPrompt.ts           — System prompt builder (profile + events + recurring series context)
    scheduling/
      mobilityClassifier.ts     — classifyMobility() + getMobilityReason() + MOBILITY_INFO
      methodMapper.ts           — mapToMethod(persona, challenge, dayStructure) → primary+secondary
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
  users/{userId}/memory.json    — Per-user AI memory (key-value facts, deduped by key)
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
- `update_event` — updates properties WITHOUT changing time (title, color, mobility_type). `apply_to_series:true` updates ALL instances of a recurring series at once
- `delete_event` — deletes by id; `delete_series:true` deletes all future instances
- `get_free_slots` — finds gaps respecting profile hours
- `break_down_task` — splits task into N sessions across free slots
- `list_events` — lists events; returns `recurring_series` (grouped by series_id) + `logical_courses` (grouped by base course name) + `summary`
- `analyze_schedule` — deep analysis with pre-computed issues (back-to-back, missing lunch, overloaded days, etc.)
- `save_memory` / `delete_memory` — persistent key-value facts about the user
- `create_task` / `update_task` / `delete_task` / `list_tasks` — task management
- `send_notification` — real push notification to device
- `delete_all_events` — wipe all events (requires explicit confirmation)

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

### Timing
- **Double-tap window**: 450ms (was 300ms — expanded for comfort)
- **Single-tap recording delay**: 400ms (matches window so double-tap always cancels cleanly)
- If second tap arrives within 450ms: timer is cancelled before recording starts → mic never briefly activates

### Ref vs State for recording detection
- `activeRef.current` (sync ref) is used — NOT `recording` state (async React) — in `handlePointerDown` and `handlePointerUp` stop checks. This prevents the race condition where a second tap arrives before React re-renders with `recording=true`.

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
  - VoiceFAB **hidden** when `mobileTab === 'tasks'` (avoids overlap with Add Task button)
- VoiceFAB position: default **right** side, user can flip in Settings (`mic_position: 'left' | 'right'`)
- VoiceFAB color: violet-pink gradient (idle), red (recording), green (success)
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

- **Mobile default**: `timeGrid3Day`; **Desktop default**: `timeGridWeek`
- Custom `timeGrid3Day` view: `type: 'timeGrid', duration: { days: 3 }`
- Accepts `isMobile?: boolean` prop from AppShell

### Navigation
- FullCalendar `headerToolbar={false}` — we use our own buttons
- `ChevronLeft` → `calApi.prev()` (always = back in time / older dates)
- `ChevronRight` → `calApi.next()` (always = forward in time / newer dates)
- `direction="ltr"` is explicitly set on FC — this ensures `prev()`/`next()` are always temporal regardless of Hebrew locale (Hebrew locale by default sets RTL which flips their meaning)
- View changes use `calApi.changeView(view)` via `useEffect` (no full remount)
- FC `key={language}` — remounts only on language change
- **Mobile swipe**: touch listeners with `{ capture: true, passive: false }` — detected in `onTouchMove` (not `onEnd`) to prevent `touchcancel`. Threshold: 40px horizontal, 1.5× dominant.
- **Desktop swipe**: `mousedown/mousemove/mouseup` on container. Threshold: 60px. Skips `.fc-event` targets.
- Both trigger same spring nudge animation (`setSwipeOffsetRef`)

### Pinch-to-zoom (mobile) / Ctrl+wheel (desktop)
**Architecture — zero-flicker approach:**
- Slot height range: **28px – 110px** (default 44px)
- Zoom range is stored in `slotHeightRef` (sync) and `slotHeight` state (async for FC prop)
- **During gesture**: only CSS variable `--fc-slot-height` is updated directly on the DOM element (`el.style.setProperty`) — no React re-renders, no frame gap
- **Event positioning during gesture**: `.fc-pinch-active .fc-timegrid-col-events` gets `transform: scaleY(--pinch-scale)`. Math: `top = T × 2 × startH`; after `scaleY(newH/startH)` → `T × 2 × newH` = exact correct position.
- **Scroll anchor**: `pinch.startScrollTop` + `pinch.startHeight` captured ONCE at `onTouchStart`. Every move: `expectedScrollTop = startScrollTop × (newH / startH)`. Uses a single `cancelAnimationFrame` + `rAF` to restore.
- **On touch end**: remove `.fc-pinch-active` class + `--pinch-scale`, then `flushSync(() => updateSlotHeight(final))` for synchronous React+FC re-render, then immediately `target.scrollTop = savedScrollTop` — no frame gap.
- **Key import**: `import { flushSync } from 'react-dom'`
- Body scroller identified by: `Array.from(el.querySelectorAll('.fc-scroller')).find(s => s.scrollHeight > s.clientHeight)` (NOT `querySelector` which returns the axis scroller with no overflow)

### Event title display
- Day/3-day views: `webkit-line-clamp: 3` (up to 3 lines) — CSS specificity fix required: selector needs 3 classes to beat the general nowrap rule (`0,3,0` vs `0,2,0`)
- Week view: `white-space: nowrap` + `text-overflow: ellipsis` (columns too narrow)

### Month view
- Desktop: `dayMaxEvents: 4` — shows up to 4 events per day, then "+N more" popover
- Mobile: `dayMaxEvents: 2` — shows up to 2 events per day, then "+N more" popover (prevents tiny unreadable text)

### Localization
- Month title: `format(currentDate, 'MMMM yyyy', { locale: heLocale })` from `date-fns/locale`
- FullCalendar locale: `@fullcalendar/core/locales/he` loaded dynamically for Hebrew
- Header wrapper uses `direction: 'ltr'` so layout is always consistent

### Event Popup
- `eventClick` opens `EventPopup` near cursor (desktop) or centered on screen (mobile)
- `EventPopup` is an Apple Calendar-style inline editor (title, time, color, mobility_type, delete/save)
- `onEventUpdate(id, changes)` → calls `PUT /api/events/[id]` → updates demo storage + state
- `onEventDelete(id)` → calls `DELETE /api/events/[id]` → removes from storage + state
- Mobility selector shows AI reasoning via `getMobilityReason()` — why the event was classified as fixed/flexible/ask_first
- Manual override adds `(ידני)/(manual)` label and saves to DB
- `PUT /api/events/[id]` now persists `mobility_type` (previously only title/color/times were saved)

---

## Mobility Classification (`src/lib/scheduling/mobilityClassifier.ts`)

Every event has a `mobility_type: 'fixed' | 'flexible' | 'ask_first'` that controls how the AI handles scheduling conflicts.

### Classification logic (priority order)
1. **Fixed keywords** in title → `fixed` 🔒 (בחינה, הרצאה, מעבדה, טיסה, ראיון, exam, lecture, lab…)
2. **Created by AI** → `flexible` 🟡 (all AI-generated events default to flexible)
3. **Flexible keywords** in title → `flexible` 🟡 (session, work block, study block…)
4. **Created by user** → `ask_first` 🔵 (default for anything the user added)

### Where it runs
- **EventPopup**: `event.mobility_type ?? classifyMobility(title, created_by)` — uses saved value or re-computes
- **Calendar tile badge**: same fallback logic — shows 🔒/🟡/🔵 icon at bottom-right of event (not top, to avoid overlapping time text)
- **AI tool `update_event`**: AI can change mobility_type; `apply_to_series:true` updates all instances of a recurring series at once

### `getMobilityReason(title, mobility, createdBy, isHe)`
Returns a human-readable explanation shown in EventPopup:
- "זוהה 'בחינה' — מועד שלא ניתן להזיז"
- "נוצר על ידי זמן — ניתן לשינוי בחופשיות"
- "הוספת את זה — ישאל לפני הזזה"

Manual overrides show `(ידני)` label and are persisted to the DB.

---

## Recurring Events & AI Intelligence

### `series_id` field
All instances of a recurring event share the same `series_id`. The AI uses this for bulk operations.

### `update_event` with `apply_to_series: true`
When the AI needs to change mobility_type (or title/color) for an entire series, it calls `update_event` once with `apply_to_series: true` — the server finds all events with the same `series_id` and updates them all. Never loops per-instance.

### `list_events` response enrichment
Returns extra context beyond raw events:
- `recurring_series` — array of `{ series_id, title, count, from, to }` (one entry per series)
- `logical_courses` — groups series by base course name (strips "מעבדה ל", "תרגול ל", "lab for" prefixes)
- `summary` — short human-readable text

### `systemPrompt.ts` — Recurring Series block
`buildSystemPrompt()` pre-computes a `courseIntelligence` block from the events array and injects it into the system prompt. This lets the AI answer "how many courses do I have?" accurately without an extra tool call. Key rules injected:
- Hebrew number words (אחד/שתיים/שלוש) in course names are part of the name, NOT arithmetic
- Answer from the series list, not from raw event count
- "INFER BEFORE YOU ANSWER" — reason from the data, don't report raw numbers directly

---

## AI Memory (`data/users/{userId}/memory.json`)

Key-value store of facts the AI learns about the user (occupation, wake_time, study_field, etc.).

- **API**: `GET/POST/DELETE /api/memory`
- **Deduplication**: POST deduplicates by `key` — same key = update in place, never duplicates
- **Tools**: `save_memory` (AI writes), `delete_memory` (AI removes outdated facts)
- **Settings display**: Collapsible section — collapsed by default, shows count badge. Keys translated to Hebrew labels (scheduling_method → "שיטת ניהול זמן"). Display also deduplicates by key client-side.

---

## Scheduling Methods (`src/lib/scheduling/methodMapper.ts`)

`mapToMethod(persona, challenge, dayStructure)` returns `{ primary, secondary[] }`.

### Personas: `student | manager | entrepreneur | developer | other`
### Challenges: `procrastination | overwhelmed | focus | scattered | goals`
### Day structures: `fixed | variable | mixed | independent`

### Available methods (13 total)
`pomodoro`, `deep_work`, `eisenhower`, `gtd`, `time_blocking`, `ivy_lee`,
`eat_the_frog`, `theme_days`, `the_one_thing`, `weekly_review`, `okr`, `kanban`, `time_boxing`,
`moscow`, `rule_5217`, `scrum`, `energy_management`, `twelve_week_year`

### MethodOnboardingModal
- Triggered by `AppShell` (800ms delay) when `onboarding_completed=true` but `scheduling_method` is missing
- AI chat popup with SSE streaming + inline mic
- Auto-closes when AI calls `complete_onboarding` and `memory_updated` event fires
- Mic button hides when input has text (avoids overlap)

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

## ChatOverlay (`src/components/ChatOverlay.tsx`)

- **No auto-focus**: the `useEffect(() => inputRef.current?.focus(), 300)` was removed — keyboard no longer opens automatically when the overlay opens on mobile.
- Messages scroll to bottom via `bottomRef.current?.scrollIntoView({ behavior: 'smooth' })` on every new message.

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
