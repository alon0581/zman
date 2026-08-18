<!-- שוחזר מתמליל | שיחה: 534d1944-ba27-409d-8a6a-6e03b74b1889 | זמן: 2026-06-19 20:47 -->

# Zman — Cost/Model Optimization + Deep Memory

## Context

Zman moved off the (now unpaid) MiniMax model. The user chose **Claude Sonnet 4.6** as the brain, wants it wired as a server-wide default ("one key works for everyone"), wants it **cheaper without hurting quality**, and wants the AI to **remember and know the person deeply and adapt to the scheduling method chosen for them**.

The real cost driver in Zman is not the model price — it's that the **huge system prompt (~8–12K tokens: rules + events + memory + tasks + method tables) is re-sent on every request *and* on every tool-loop iteration** ([systemPrompt.ts](src/lib/ai/systemPrompt.ts), the loops in [chat/route.ts](src/app/api/chat/route.ts)). So the savings come from *not paying for the same giant prompt over and over* — via prompt caching, a stable cacheable prefix, less re-sent history, and routing cheap messages to Haiku — none of which lowers model intelligence on the hard tasks.

All providers are already wired (Anthropic via `@anthropic-ai/sdk`, plus OpenAI/MiniMax/OpenRouter), so this is mostly configuration + prompt restructuring, not new plumbing.

---

## Part 1 — Cost & model (target ~70–85% input cost cut, quality-neutral)

### 1. Server-wide default model via env (`AI_PROVIDER` / `AI_MODEL` + `ANTHROPIC_API_KEY`)
In the provider-resolution block of [chat/route.ts](src/app/api/chat/route.ts) (currently `MINIMAX_API_KEY → minimax`, `OPENAI_API_KEY → openai`, both with hardcoded models): add a generic env-driven default. Precedence: **per-user Settings key (encrypted) > env default**. Read `AI_PROVIDER`, `AI_MODEL`, and the matching key (`ANTHROPIC_API_KEY` for anthropic). Result: set `AI_PROVIDER=anthropic`, `AI_MODEL=claude-sonnet-4-6`, `ANTHROPIC_API_KEY=...` in Railway → everyone uses Sonnet, no code change to switch later. Document in `RAILWAY_ENV.txt`. (Model IDs verified against the Claude reference: `claude-sonnet-4-6`, `claude-haiku-4-5`.)

### 2. Restructure the system prompt into a stable prefix + dynamic suffix (the caching enabler)
Caching only works on a **byte-identical prefix**. Today [systemPrompt.ts](src/lib/ai/systemPrompt.ts) interpolates the current time and event list *into the middle* of the static rules, so the prefix changes every request and nothing caches. Refactor `buildSystemPrompt` to return two pieces:
- **STATIC PREFIX** — all the rules, method context, session-size table, color rules, etc., plus profile-derived constants that are stable across a user's requests (peak hours, sleep/wake, autonomy, language). Per-user but per-request-stable → cacheable.
- **DYNAMIC SUFFIX** — a single `CURRENT CONTEXT` block at the end: current time, `hoursUntilSleep`, upcoming events, memory, tasks. These change per request and stay out of the cached prefix.

### 3. Turn on prompt caching
- **Anthropic branch:** change `system: systemPrompt` (string) → `system: [{type:'text', text: STATIC_PREFIX, cache_control:{type:'ephemeral'}}, {type:'text', text: DYNAMIC_SUFFIX}]`. GA — no beta header. Caches tools + static prefix; reads cost ~10%. Verify via `usage.cache_read_input_tokens` in logs.
- **OpenAI/OpenRouter branch:** automatic caching (no code), but only works because step 2 puts the stable prefix first — so the restructure benefits both providers.

### 4. Trim re-sent chat history
[useChatEngine.ts](src/hooks/useChatEngine.ts) sends `slice(-40)` messages every turn (re-sent on every loop iteration too). Reduce to ~12–15. The live calendar + memory state is injected fresh into the prompt, so old chat is rarely load-bearing → big input cut, negligible quality impact.

### 5. Tiered model routing (chosen: Haiku for simple, Sonnet for scheduling)
In [chat/route.ts](src/app/api/chat/route.ts), before the loop, pick the model:
- `mainModel` = resolved default (Sonnet); `simpleModel` = `AI_MODEL_SIMPLE` env (default `claude-haiku-4-5`).
- Route to `simpleModel` only when the latest user message is clearly non-scheduling chit-chat (no scheduling/calendar intent, not onboarding) — a conservative server-side keyword check mirroring `hasCalendarIntent` in [useChatEngine.ts](src/hooks/useChatEngine.ts). Everything tool-/scheduling-related stays on Sonnet. Haiku still has all tools, so a mis-route degrades gracefully. Configurable/disable-able via env.

### 6. Keep outputs tight (output is the priciest per-token on Sonnet)
Keep the existing "max 4–5 sentences" instruction and modest `max_tokens` (2048 for tool batches; final answers are short). No change beyond confirming it stays after the restructure.

---

## Part 2 — Deep, method-adaptive memory ("knows the person best")

Reuse the existing infra — `AIMemory` ([types/index.ts](src/types/index.ts)), `save_memory`/`delete_memory` ([tools.ts](src/lib/ai/tools.ts) + handlers in [chat/route.ts](src/app/api/chat/route.ts)), the categorized `memorySummary` injection ([systemPrompt.ts](src/lib/ai/systemPrompt.ts)), and the Settings memory viewer ([SettingsClient.tsx](src/app/settings/SettingsClient.tsx)). Improvements:

### A. A defined "Person Profile" taxonomy
Formalize the key namespaces the AI fills in, and inject them as a clean labelled **PERSON PROFILE** block (refine the existing prefix→category mapping in `memorySummary`):
- **identity** (occupation, study_field, year, role, location)
- **rhythm** (wake/sleep, productivity_peak, energy_dips, commute)
- **fixed_commitments** (`recurring_*`: classes, shifts, gym, volunteering)
- **preferences** (pref_session_length, pref_study_time, prefers_buffers, no-go times)
- **life** (relationship, family, hobbies — for real life-balance scheduling)
- **goals** (current_goal, upcoming_focus, ongoing_task)
- **method_fit** (scheduling_method, secondary_methods, method_feedback)
- **patterns** (`pattern_*` learned behaviours)

Update the `save_memory` description in [tools.ts](src/lib/ai/tools.ts) to list this taxonomy so capture is consistent.

### B. Behavioural pattern learning (learn from actions, not just words)
Strengthen the existing PATTERN LEARNING prompt section: after 2–3 consistent behaviours (user repeatedly moves morning study to evening, rejects pre-9am slots, prefers 2h blocks), the AI saves a `pattern_*` memory and **applies it** on the next schedule. Wire it into the TASK INTAKE PROTOCOL so scheduling consults `pref_*`/`pattern_*` before proposing times.

### C. Method-adaptive memory + friction detection (the "adapt to the chosen method" part)
The chosen `scheduling_method` shapes *what's worth remembering and how memory is used*. Add short per-method "what to remember / how to apply" guidance to the injected method context:
- Eat the Frog → their dreaded task types ("frogs") + best morning window.
- Deep Work → longest uninterrupted windows + focus-breakers.
- Pomodoro → effective cycle length + break style.
- Time Blocking → category rhythms.
- **Friction signal:** if patterns show the user keeps fighting the method (a Deep Work user fragmenting into short sessions), the AI records `method_feedback` and may propose adjusting `secondary_methods` — so the method **adapts to the person over time**, not the other way round.

### D. Bounding for cost (memory is injected every request)
- Keep dedupe-by-key (done) and the `MEM_KEY_MAX`/`MEM_VALUE_MAX` limits already added.
- Add a **core-profile cap** (~40 high-signal facts) + relevance ordering in the injection: always inject the core categories; truncate the low-signal `general` bucket; prompt the AI to `delete_memory` stale facts when over cap.
- Inject memory in the **DYNAMIC suffix** (Part 1.2), so memory updates only invalidate the cheap tail, never the cached static prefix.

### E. Settings transparency
Extend the Hebrew label map in [SettingsClient.tsx](src/app/settings/SettingsClient.tsx) to the new taxonomy so the user can see and curate exactly what the AI knows — trust + control.

---

## Suggested order
1. Part 1.1 (env default model) + `RAILWAY_ENV.txt` — unblocks running on Sonnet immediately.
2. Part 1.2 + 1.3 (prompt restructure + caching) — the core saving.
3. Part 1.4 (history trim) + 1.5 (Haiku/Sonnet routing).
4. Part 2 A–E (memory taxonomy, pattern learning, method-fit, bounding, Settings labels).

## Verification
- **Static:** `npx tsc --noEmit` + `npm run lint` clean.
- **Model/caching (dev):** set `ANTHROPIC_API_KEY` + `AI_PROVIDER=anthropic` + `AI_MODEL=claude-sonnet-4-6`; send a scheduling message twice; confirm logs show `usage.cache_read_input_tokens > 0` on the 2nd request and the response is from Sonnet. Log input-token totals before/after the restructure to show the drop.
- **Routing:** a plain "תודה" / "מה שלומך" routes to Haiku; "תקבע לי לימודים" stays Sonnet (assert via logged model per request).
- **Memory:** run onboarding + a few chats; confirm `save_memory` writes taxonomy keys, the injected PERSON PROFILE block is organized and bounded (≤ cap), method-fit guidance appears for the user's method, and Settings shows the curated facts with Hebrew labels.
- **Cost sanity:** estimate per-message cost from logged usage with caching on vs off, on a tool-heavy "schedule my week" message.
