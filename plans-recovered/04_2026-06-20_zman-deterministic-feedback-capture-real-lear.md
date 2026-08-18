<!-- שוחזר מתמליל | שיחה: 534d1944-ba27-409d-8a6a-6e03b74b1889 | זמן: 2026-06-20 09:08 -->

# Zman — Deterministic Feedback Capture (real "learn while running")

## Context

Today Zman "learns" only when the model *notices* a pattern in conversation and chooses to `save_memory` — unreliable. The user wants the system to genuinely learn from their **actions** as it runs. The fix: capture concrete user-feedback signals deterministically (no reliance on the model noticing), feed a compact summary back into every request, and let the AI both adapt immediately and promote clear repeated patterns to durable `pattern_*` memory.

This is the per-user, system-level learning discussed with the user (the model weights don't change; the app's behaviour does). It is cheap: capture is a tiny file write; injection adds a few tokens to the non-cached dynamic suffix.

Verified signal sources in the code:
- **Rejection** — deleting an AI-created event goes through `DELETE /api/events/[id]` ([route](src/app/api/events/[id]/route.ts)) via EventPopup. Reliable.
- **Move** — changing an event's time happens via the AI `move_event` handler in [chat/route.ts](src/app/api/chat/route.ts) (EventPopup edits title/color/mobility only; desktop drag isn't persisted). The handler already has the existing event (`created_by`, old `start_time`) + new time.

## Plan

### 1. Feedback store (new, reuses existing helpers)
New `src/lib/feedback/store.ts`:
- `FeedbackSignal` type (also add to [types/index.ts](src/types/index.ts)): `{ type: 'rejected' | 'moved'; title: string; fromHour?: number; toHour?: number; day?: string; at: string }`.
- `recordFeedback(userId, signal)` — append to `<DATA_DIR>/users/{id}/feedback.json`, FIFO-capped at ~40, via `readJsonFile`/`writeJsonFileAtomic` ([jsonStore.ts](src/lib/util/jsonStore.ts)) + `DATA_DIR` ([dataDir.ts](src/lib/util/dataDir.ts)) + `assertSafeUserId`.
- `readFeedback(userId)` — returns the list (or []).

### 2. Capture points (deterministic)
- **`DELETE /api/events/[id]`** ([route](src/app/api/events/[id]/route.ts)): before deleting, look the event up (`demoStorage.getEvents(userId).find(byId)`); if `created_by === 'ai'`, `recordFeedback('rejected', {title, fromHour: start hour, day})`. Best-effort, wrapped so it never blocks the delete.
- **`move_event`** in [chat/route.ts](src/app/api/chat/route.ts): when `existing.created_by === 'ai'`, `recordFeedback('moved', {title, fromHour, toHour, day})` using the old vs new `start_time`. (Skip AI-initiated deletes / non-AI events — those aren't feedback on an AI proposal.)

### 3. Inject + adapt
- In [chat/route.ts](src/app/api/chat/route.ts), demo path: load `readFeedback(userId)` (alongside the existing fresh-profile load) and pass it to `buildSystemPrompt`.
- In [systemPrompt.ts](src/lib/ai/systemPrompt.ts): add a `feedback?: FeedbackSignal[]` param; render a compact **RECENT FEEDBACK** block inside the existing `dynamicSuffix` (CURRENT CONTEXT). Show the last ~8 signals as one line each (e.g. `moved "Study" 09:00→20:00`, `rejected "Gym" ~08:00`) + one nudge: *"If a signal repeats, honour it now AND save_memory a pattern_* so it sticks; don't propose times the user keeps rejecting."* Bounded → minimal token cost, lives in the non-cached suffix so it never breaks prompt caching.

### Why this is enough
Even before the model promotes anything to durable memory, the concrete RECENT FEEDBACK block changes behaviour on the very next request — that *is* learning while running. Promotion to `pattern_*` (already wired in PATTERN LEARNING) makes it durable across the 40-signal window.

### Out of scope (told the user)
Cross-user/global learning; changing model weights; persisting desktop drag-moves (separate latent gap — noted, not fixed here).

## Files
- New: `src/lib/feedback/store.ts`
- Edit: `src/types/index.ts`, `src/app/api/events/[id]/route.ts`, `src/app/api/chat/route.ts`, `src/lib/ai/systemPrompt.ts`

## Verification
- `npx tsc --noEmit` + `npm run lint` clean (no new errors).
- Dev smoke: register/login (demo), have the AI create an event, then delete it via the calendar popup → confirm `data/users/<id>/feedback.json` gains a `rejected` signal; ask the AI to move an AI-created event → confirm a `moved` signal. Then send a new chat message and confirm (via the `[chat]` logs / behaviour) that a RECENT FEEDBACK block is present and the AI references it. Corrupt/empty feedback file → no crash (jsonStore fallback).
- Confirm the static prompt prefix is unchanged (caching intact) — feedback only appears in the dynamic suffix.
