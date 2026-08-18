<!-- שוחזר מתמליל | שיחה: 534d1944-ba27-409d-8a6a-6e03b74b1889 | זמן: 2026-06-20 09:56 -->

# Zman — Settings: fix sync + remove dead controls

## Context

The Settings screen ([SettingsClient.tsx](src/app/settings/SettingsClient.tsx)) has an inconsistent save model that the user experiences as "doesn't sync", plus one dead control:
- Most settings persist **only** when the bottom **"Save Settings"** button is pressed; closing via the X or the backdrop silently discards changes.
- Notification toggles, in contrast, auto-save instantly (`saveField`) — inconsistent.
- Theme & language don't apply **live** (only after Save), while the header has its own live theme toggle → two sources of truth that disagree.
- The **Voice Responses** toggle (`voice_response_enabled`) is wired to nothing — there is no TTS anywhere, so toggling it does nothing.
- Dead code: `MEMORY_SOURCE_LABELS` (unused), a full block of **AI Model** i18n strings for a section that isn't rendered, and `setSaved` is never called so "Saved!" never shows.

A cross-codebase audit confirmed the other 18 profile fields ARE wired (read by `systemPrompt.ts`, `notifications/scheduler.ts`, chat route, AppShell). So the work is: make persistence consistent + instant, and remove the dead bits.

**Decisions (from the user):** remove the Voice Responses toggle; switch to **auto-save on every change**.

## Plan — all in [SettingsClient.tsx](src/app/settings/SettingsClient.tsx)

### 1. Auto-save + live-apply on every change
Add one unified updater and route every persisted control through it:
```
const update = (key, value) => {
  setP(prev => { const next = { ...prev, [key]: value }; onProfileUpdate?.(next); return next })
  saveField(key, value)   // already posts a single-key patch to /api/profile (merged server-side)
}
```
- Replace the `set(...)` calls for: `autonomy_mode`, `language`, `theme`, `mic_position`, `productivity_peak`, `wake_time`, `sleep_time` with `update(...)`.
- `onProfileUpdate?.(next)` makes theme/language/mic apply **live** to the app behind (AppShell.handleProfileUpdate already sets `data-theme`, profile language → RTL, and passes `mic_position` to VoiceFAB).
- **Scheduling method** (`handleMethodClick`): after computing the new `scheduling_method`/`secondary_methods`, persist both via `saveField` (and `onProfileUpdate`). It currently only mutates local state.
- Keep `handleNotificationsToggle` and the notification sub-toggles as-is (they already auto-save) — optionally route them through `update` for consistency.
- The single-key patch is safe: POST /api/profile merges `{...existing, ...body}` ([profile/route.ts](src/app/api/profile/route.ts)).

### 2. Replace the "Save Settings" button
Everything auto-saves, so the bottom button becomes **"Done"** → `onClose?.()` (standalone mode → navigate home). Add a small, ephemeral "✓ נשמר/Saved" flash on each auto-save (reuse the existing `saved`/`setSaved` state — set it true for ~1.2s after a save) so the user gets feedback. This also makes `setSaved` actually used.

### 3. Remove dead / disconnected items
- Delete the **Voice Responses** `Row` (and the `voiceLabel`/`voiceDesc` strings + the field from the default profile object).
- Delete the unused `MEMORY_SOURCE_LABELS` const.
- Delete the dead **AI Model** i18n strings (`aiModelSection`, `connectBtn`, `connectedLabel`, `disconnectBtn`, `*Desc`, `modelLabel`, `modelDesc`, `wizard*`, `verify*`, `cancelBtn`, `saveConnectBtn`) — the section isn't rendered. (Server still supports a per-user `ai_api_key_encrypted`; there's just no UI for it, and the user runs on the server key — out of scope to re-add.)

## Verification
- `npx tsc --noEmit` + `npm run lint` clean (no new errors).
- Dev smoke ([preview_*]): open Settings →
  - change **Theme** → the app behind flips **instantly** (no Save press); the header toggle now agrees.
  - change **Language** / **Mic side** → applies live.
  - change **Peak/Wake/Sleep/Autonomy/Method**, close via the **X** or backdrop, reopen → the change **persisted** (no data loss).
  - notification toggles still work.
  - the **Voice Responses** row is gone; a brief "✓ נשמר" appears on changes.
- Confirm `data/users/<id>/profile.json` reflects each change immediately after toggling (without pressing a Save button).
