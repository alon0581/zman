<!-- שוחזר מתמליל | שיחה: 534d1944-ba27-409d-8a6a-6e03b74b1889 | זמן: 2026-06-20 14:32 -->

# Zman — Make the AI genuinely excellent (deep quality pass)

## Context

The user wants the in-app AI assistant (the chat/scheduler powered by Claude Sonnet/Haiku) to feel "perfect" — proactive, smart, honest, and to stop producing the rough edges they keep hitting (clustering sessions, asking instead of proposing, claiming work it didn't do, cluttering the calendar). This is a holistic quality pass, not a single bug.

Three parallel Explore audits ran across the AI's execution layer (`chat/route.ts`), reasoning layer (`systemPrompt.ts`), and scheduling intelligence (`scheduling/*` + `getFreeSlots`/`break_down_task`/`analyze_schedule`). Every item below was **validated against the real code** and audit false-positives were dropped (e.g. the claim that `getFreeSlots` ignores `preferred_hours` — it does respect it, [route.ts:1669](src/app/api/chat/route.ts:1669)).

Already fixed earlier this session (live + verified): memory recall, smart-model routing for personal/organize verbs, recurring dedupe + fixed-event protection, always-reply, honest confirmations, N-times-a-week distribution, execute-now, duplicate removal, MiniMax auto-heal, method backfill, BOM hardening.

## Validated issues (what's actually wrong)

### A. Scheduling quality — highest user-visible impact
- **`break_down_task` clusters sessions** ([route.ts:1138](src/app/api/chat/route.ts:1138)): takes the first N free slots sequentially, so it stacks multiple sessions on the same day (e.g. Mon 2–4 + Mon 4–6) with no day-spreading and no rest. Same complaint the user had about workouts.
- **Peak sorting destroys chronological order** ([route.ts:1732](src/app/api/chat/route.ts:1732)): with `preferPeak`, slots are returned peak-first but not time-ordered, so `break_down_task` can assign sessions out of order / to the earliest peak day repeatedly.
- **`analyze_schedule` raises false alarms** ([route.ts:1286](src/app/api/chat/route.ts:1286)): flags BACK_TO_BACK even when **both events are fixed/unmovable**; lunch hardcoded 12:00–13:30 ignores `preferred_hours`; "no prep" only checks the day before, ignoring earlier prep. Erodes trust.

### B. The AI gets "dumber" when profile data is missing — consistency
- **Core intelligence is gated** behind `profile?.scheduling_method || challenge`: TASK INTAKE PROTOCOL ([systemPrompt.ts:155](src/lib/ai/systemPrompt.ts:155)), METHOD SESSION TABLE ([:150](src/lib/ai/systemPrompt.ts:150)), method context ([:125](src/lib/ai/systemPrompt.ts:125)). A partial-profile user gets a passive bot instead of the "genius" the prompt promises. (The method-backfill helps, but defaults should make this robust regardless.)

### C. System-prompt coherence & gaps
- **Autonomy mode defined 3 different/contradictory ways** ([:110](src/lib/ai/systemPrompt.ts:110), [:172](src/lib/ai/systemPrompt.ts:172), [:216](src/lib/ai/systemPrompt.ts:216)) — the AI doesn't know when "hybrid" should act vs ask.
- **Missing guidance** for common requests the tools already support: all-day events (`is_all_day`), `delete_task`, `send_notification`, recurrence `end_date` / "until June" / biweekly weekdays, "what should I do now?", "I'm overwhelmed" mid-session, move/shift a whole day.
- **Prompt is ~600 lines and dense** — key rules are buried; some redundant blocks.

### D. Execution robustness & honesty at the tool layer
- **Tool errors are stringified and handed back as data** ([route.ts:346](src/app/api/chat/route.ts:346)): an errored create/move can be summarized as success. The honesty prompt rule helps, but the loop should make failures explicit.
- **Silent write failures**: `break_down_task` Supabase insert has no error check ([route.ts:1160](src/app/api/chat/route.ts:1160)); demo writes can throw and be swallowed. Partial `break_down_task` failures can't be distinguished from "didn't fit".

### E. Mobility classification accuracy
- **Over-broad fixed keywords** ([mobilityClassifier.ts:12](src/lib/scheduling/mobilityClassifier.ts:12)): "דיון" (discussion), "הגנה"/"defense" misclassify flexible items as fixed.
- **Missing common flexible words**: "תרגול", "שיעור", "מטלה", etc. → user-typed study items default to ask_first.

## Direction (decided with the user): FIX IN PLACE — not a rebuild

The architecture (tool-calling agent loop + clean execution/reasoning/storage separation) is sound. Only the two genuinely weak parts get a **targeted rewrite**: the scheduling math (`getFreeSlots`/`break_down_task`) and the dense 600-line system prompt. Everything else — memory, recurring, mobility, methods, auth, push, calendar, Capacitor, and all fixes verified live today — is kept.

## Rollout (decided with the user): PHASED

- **Phase 1 — land + verify live first:** Workstream A (scheduling quality) + Workstream B (always-smart defaults). Highest impact, lower risk, provable each step.
- **Phase 2 — after Phase 1 is confirmed:** Workstreams C (prompt coherence/gaps), D (execution honesty), E (classification accuracy).

Each phase ends with `tsc` + `lint` clean and a live end-to-end check on Railway before moving on.

## Proposed approach (by workstream, priority order)

### Workstream A — Scheduling quality (do first)
1. **Spread `break_down_task` across days** ([route.ts:1082](src/app/api/chat/route.ts:1082)): after getting candidate slots, pick at most 1–2 sessions per day, prefer non-consecutive days, leave a rest gap; only stack same-day if the deadline forces it. Reuse the day-grouping idea from the N-times-a-week logic.
2. **Make `getFreeSlots` peak preference chronological** ([route.ts:1732](src/app/api/chat/route.ts:1732)): keep slots time-ordered; expose `is_peak` for the caller to prefer without scrambling order.
3. **Stop `analyze_schedule` false positives** ([route.ts:1286](src/app/api/chat/route.ts:1286)): only flag BACK_TO_BACK when ≥1 event is movable (mobility ≠ fixed); base lunch window on `preferred_hours`/wake-sleep; count prep across the days leading up to an exam, not just the day before.

### Workstream B — Always-smart defaults
4. **Ungate core intelligence** in `systemPrompt.ts`: render TASK INTAKE PROTOCOL, a default session-size table, and proactivity rules even when `scheduling_method`/`challenge` are absent, using sensible defaults (time_blocking, ~90-min sessions, morning peak). New/partial users get the full experience.

### Workstream C — Prompt coherence & gaps
5. **Resolve the autonomy contradiction**: one clear definition (hybrid = auto for ≤2 flexible moves / a single create, ask for 3+ moves or destructive/bulk).
6. **Add concise guidance** for: all-day events, `delete_task`, `send_notification` (reminders), recurrence `end_date`/biweekly weekdays, "what should I do now?", "I'm overwhelmed", whole-day reschedule.
7. **Trim/de-dup** the prompt where two blocks teach the same thing, so important rules aren't buried (conservative — keep behavior, cut redundancy).

### Workstream D — Execution honesty
8. **Surface tool failures**: wrap demo/Supabase writes so a failed create/move returns an explicit `{ error }` (not silent), and `break_down_task` distinguishes "DB error" from "didn't fit". The loop already feeds results back; the honesty rule then makes the AI report truthfully.

### Workstream E — Classification accuracy
9. **Tighten `mobilityClassifier`**: narrow over-broad fixed keywords (more specific phrases for "דיון"/"defense"), add common flexible study words.

## Files
- `src/app/api/chat/route.ts` — `getFreeSlots`, `break_down_task`, `analyze_schedule`, tool-result/error handling.
- `src/lib/ai/systemPrompt.ts` — ungate core blocks, resolve autonomy, add guidance, trim redundancy.
- `src/lib/scheduling/mobilityClassifier.ts` — keyword tuning.
- (No new files expected; reuse existing helpers.)

## Verification
- `npx tsc --noEmit` + `npm run lint` clean.
- Live end-to-end on Railway (established pattern: register throwaway user → drive `/api/chat` → assert behavior), per workstream:
  - A: "break this 8-hour task into sessions before next Friday" → sessions land on **different, non-consecutive days**, chronological, no same-day stacking unless forced.
  - A: a day with two adjacent **fixed** events → `analyze_schedule` does NOT flag BACK_TO_BACK.
  - B: empty profile (no method) → "organize my week" still **proposes** concretely (no interrogation).
  - C: "every other Wednesday until September" → recurrence respects end + cadence; "remind me to call mom Friday" → sensible task/notification.
  - D: simulate a write failure → AI reports honestly, no fake ✓.
  - E: user-typed "תרגול מתמטיקה" → flexible (movable); "דיון קבוצתי" not force-fixed.
- Clean up throwaway `ztest_*@verify.local` users noted (no delete endpoint yet).

## Open scope question (for the user)
Whether to land all five workstreams in one pass, or phase it (A+B first as the highest-impact core, then C–E).
