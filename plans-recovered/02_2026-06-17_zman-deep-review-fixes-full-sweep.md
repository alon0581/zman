<!-- שוחזר מתמליל | שיחה: 534d1944-ba27-409d-8a6a-6e03b74b1889 | זמן: 2026-06-17 19:17 -->

# Zman — Deep Review Fixes (Full Sweep)

## Context

The user asked for a deep, end-to-end review of Zman ("does it really arrange the calendar like it should, down to the small details, visuals, and general bugs") and wants **everything** fixed across the AI/scheduling logic, the frontend/UX/visuals, and the backend. Three parallel review agents + direct verification produced ~40 findings. The Railway "offline" screenshot was old — not a live issue — but the deploy env requirements still stand (documented, not code).

**Correction baked into this plan:** the VoiceFAB double-tap was reported as "broken" but verified working — it *does* open chat. The only real issue is the double-tap window drifted to 600ms vs the 400ms record delay, so taps 400–600ms apart briefly flash the mic. Fix is the constant, not a rewrite.

Reuse existing helpers everywhere: `readJsonFile`/`writeJsonFileAtomic` ([jsonStore.ts](src/lib/util/jsonStore.ts)), `assertSafeUserId` ([safeUserId.ts](src/lib/util/safeUserId.ts)), `parseHour`/`getFreeSlots`/`classifyMobility` (chat route), `mapToMethod` ([methodMapper.ts](src/lib/scheduling/methodMapper.ts)).

Work in the order A → B → C → D so the scheduling *correctness* (the user's core concern) lands first.

---

## A. AI / Scheduling correctness — "does it really arrange the calendar right"

Primary file: [src/app/api/chat/route.ts](src/app/api/chat/route.ts); also [tools.ts](src/lib/ai/tools.ts), [systemPrompt.ts](src/lib/ai/systemPrompt.ts), [onboardingPrompt.ts](src/lib/ai/onboardingPrompt.ts).

- **A1 — Timezone (HIGH, the big one).** The correctly-computed `userNow` (Asia/Jerusalem) is passed only to `buildSystemPrompt`, not to scheduling. Thread `userNow` into `executeTool(...)` and down into `getFreeSlots` (replace the `const nowTs = new Date()` floor) and `break_down_task` (replace `new Date().toISOString()` from-date). Result: "free slots today" / break-down sessions stop being off by the UTC offset.
- **A2 — Onboarding never assigns a method (HIGH).** `mapToMethod` runs only when persona+challenge+day_structure are all present, but none are `required` in the `complete_onboarding` schema → user gets no `scheduling_method` and `MethodOnboardingModal` re-triggers forever. Add the three to the tool's `required`, and add a fallback: if partial, still persist whatever method info is available (don't silently skip).
- **A3 — `move_event` stacks events (MEDIUM-HIGH).** It only checks `fixed` mobility. Reuse the create_event overlap detection to return `{error:'conflict', alternatives}` when the target slot is occupied (excluding the event being moved).
- **A4 — `max_tokens:1024` truncates batch tool-calls (MEDIUM).** Raise non-reasoning cap to 2048+ in both the OpenAI and Anthropic loops, and wrap the per-tool-call `JSON.parse(tc.function.arguments)` in try/catch returning a tool error the model can retry from (instead of bubbling to a generic 500).
- **A5 — `is_all_day` read but not in schema (MEDIUM).** Add `is_all_day: {type:'boolean'}` to `create_event` in tools.ts.
- **A6 — Course-grouping bugs (MEDIUM).** Remove `חדווה ל` from the `baseCourse` strip regex (it's a course name, not a prefix). In systemPrompt.ts reconcile the two contradictory blocks (reason-from-names vs "ALWAYS use logical_courses") — mark `logical_courses` as heuristic; and remove the hardcoded "28 events → 7 courses" arithmetic example that anchors wrong counts.
- **A7 — Supabase writes false-success (MEDIUM).** `update_event`/`move_event`/`delete_event` (non-demo path) ignore the Supabase `error`. Capture and return it like `create_event` already does.
- **A8 — `parseXmlToolCalls` executes unvalidated tool names (MEDIUM, security).** Validate the parsed `name` against an allowlist of known tools before executing (blocks injected `delete_all_events` via echoed content); add an index to the synthetic `tool_call_id` to avoid same-ms collisions.
- **A9 — Silent partial results (LOW-MED).** `break_down_task` returns only `sessions_created`; add `sessions_needed`/`sessions_unscheduled` so the model can warn when slots run out. `update_event` with `apply_to_series` but no `series_id` → return a `warning`.
- **A10 — Consistency (LOW).** Unify the evening peak-end constant (analyze uses 24, scheduling uses 23); apply the same `classifyMobility` fallback in systemPrompt's event list that the tools use; fix onboardingPrompt A–F vs A–G topic-count mismatch; drop `title` from `required` on `delete_event`/`delete_task` schemas (handlers ignore it).

## B. Frontend — bugs, UX, visuals, a11y

- **B1 — 30s pollers clobber optimistic state (HIGH).** [AppShell.tsx](src/components/AppShell.tsx) events/tasks pollers do `setEvents(data.events)` wholesale and can revert an event the AI/user just created. Guard with an "in-flight / recently-mutated" ref and skip or merge-by-id while a chat request or optimistic update is pending.
- **B2 — No error/empty/failure states (HIGH).** Add an error+retry state to [CalendarPanel.tsx](src/components/CalendarPanel.tsx) (currently only a spinner). In [useChatEngine.ts](src/hooks/useChatEngine.ts) handle the SSE `{type:'error'}` frame explicitly and keep the failed user message with a retry affordance; show an empty-calendar hint.
- **B3 — EventPopup discards edits (HIGH).** [EventPopup.tsx](src/components/EventPopup.tsx) closes on outside `mousedown` and loses unsaved title/color/mobility edits. Auto-save on close (or confirm), and add a mobile backdrop so a tap behind the centered popup is intentional.
- **B4 — login password contradiction (MEDIUM).** [login/page.tsx](src/app/login/page.tsx) rule requires 12 chars but the placeholder says "לפחות 6". Align the placeholder/help text to 12.
- **B5 — VoiceFAB timing + a11y (MEDIUM).** [VoiceFAB.tsx](src/components/VoiceFAB.tsx): change the double-tap window from 600ms back to ~450ms to match the 400ms record delay (per CLAUDE.md), so taps don't flash the mic; clean the `pressStartRef` offset comment; add `aria-label` (localized) + `aria-pressed` for recording state. Distinguish `NotAllowedError` in `startRecording` to surface a "enable mic" toast instead of a silent red shake.
- **B6 — a11y pass (MEDIUM).** Add `aria-label`s to icon-only buttons across AppShell, CalendarPanel, TasksPanel, EventPopup, ChatOverlay, Toast. Make [ChatOverlay.tsx](src/components/ChatOverlay.tsx) a proper dialog: `role="dialog" aria-modal`, Escape-to-close, basic focus handling.
- **B7 — Light-theme dark blobs (MEDIUM).** Route hardcoded dark `rgba(...)` backgrounds through CSS vars / add light overrides: ChatOverlay assistant+typing bubbles, Toast surface, CalendarPanel mobile view-switcher. Verify against `data-theme="light"`.
- **B8 — Tasks "scheduled" badge false matches (HIGH, data-correctness).** [TasksPanel.tsx](src/components/TasksPanel.tsx) matches task↔event by fuzzy substring (`includes`). Proper fix: when `break_down_task`/`create_event` schedules a task, stamp the event with `source_task_id`, and match on that; fall back to exact (case-insensitive) title equality to kill the worst false positives.
- **B9 — Misc (LOW).** ChatOverlay inline-markdown `*` can swallow text — tighten the regex; EventPopup viewport-fit should re-clamp on resize/orientation; reconsider `userScalable:false` in [layout.tsx](src/app/layout.tsx) (blocks zoom) — at minimum keep calendar pinch working before disabling native zoom; Toast stacking opacity should track visual position not array index.
- **B10 — Performance (LOW).** `useMemo` the FullCalendar `fcEvents` mapping on `[events, newEventIds]`; read `language` via ref inside the gesture handlers so the big touch/mouse `useEffect` stops re-binding capture-phase listeners on unrelated dep changes.

## C. Backend robustness

- **C1 — Non-atomic writes (LOW-MED).** [push/subscribe/route.ts](src/app/api/push/subscribe/route.ts) and [memory/route.ts](src/app/api/memory/route.ts) still use raw `fs.writeFileSync`. Route them through `writeJsonFileAtomic`/`readJsonFile` + `assertSafeUserId`, consistent with the rest.
- **C2 — Config note.** `CRON_SECRET` unset → cron silently never runs (safe but inert). Document.

## D. Cleanup & docs

- **D1 — Dead code.** Delete confirmed-unused [ChatPanel.tsx](src/components/ChatPanel.tsx). Verify whether `OnboardingModal.tsx` is reachable (AppShell only renders `MethodOnboardingModal`); if truly unreferenced, remove — otherwise leave a note.
- **D2 — CLAUDE.md drift.** Fix methods count (says "13", code has 18); remove the `api/onboarding/route.ts` reference (doesn't exist — onboarding is the `complete_onboarding` tool); update the VoiceFAB timing numbers to the new 450/400.

## E. Deployment (not code — reaffirm only)

`RAILWAY_ENV.txt` already documents it: set `AUTH_SECRET` (boot throws without it in prod — the real "offline" cause), `OPENAI_API_KEY` (and **rotate the key sitting in `.env.local`**), volume mounted at `/app/data`, `NEXT_PUBLIC_APP_URL`. No code change.

---

## Verification

- **Static:** `npx tsc --noEmit` and `npm run lint` — clean (no new errors; pre-existing warnings unchanged).
- **Scheduling correctness (A):** in dev, with a profile timezone of Asia/Jerusalem, ask the AI for "free time today" late in the evening and confirm slots are local, not UTC-shifted; run onboarding to completion and confirm `scheduling_method` is saved (modal does not re-trigger); ask to move an event onto an occupied slot and confirm a `conflict` response; trigger a multi-event "schedule all my classes" and confirm no truncation 500.
- **Frontend (B):** `preview_start` → exercise: create an event via chat then let a poll run (event must not vanish); kill the network and send a chat (error bubble + retry, message preserved); open EventPopup, edit, tap outside (edit preserved); `preview_resize` + `data-theme="light"` screenshot to confirm no dark blobs; double-tap VoiceFAB (chat opens, no mic flash); tab/Escape on ChatOverlay.
- **Backend (C):** corrupt a `memory.json`/profile push file → confirm atomic write + corrupt backup behavior (same as jsonStore tests already passing).
- **Visual proof:** capture before/after light-theme screenshots and a successful scheduling flow via the preview tools.
