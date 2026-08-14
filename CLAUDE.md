# Zman — AI Life Scheduler · CLAUDE.md

> Context file for Claude Code. Keep it honest: this file is read at the start of
> every session, so a stale claim here costs more than a stale comment in code.
> Last full rewrite: 2026-08-11, after the accuracy rework.

---

## What Zman is

A Hebrew-first AI scheduler. Split-panel UI — calendar on the left, chat on the
right — where the user says what they need in plain Hebrew and the app puts it on
the calendar. Single real user (Alon, an engineering student in Israel), running
in production. Mobile and desktop matter equally.

---

## ⚠️ Read this before you touch anything

**Every turn auto-deploys to production.** `.claude/settings.json` has a Stop
hook that runs `git add -A && git commit && git push origin main`, and Railway
deploys from `main`. There is no staging. Consequences:

- Leave the tree green. `npx tsc --noEmit` and `npm test` must pass before your
  turn ends, or you have shipped a broken app to a live user.
- Anything risky lands behind a flag that is **off by default** (see
  `SCHEDULER_V2`), so the deploy is inert until someone opts in.
- Storage changes touch a live Railway volume with real data. Additive and
  backward-compatible only; never a shape change that breaks existing reads.

---

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router), React 19, TypeScript |
| UI | Tailwind v4, FullCalendar 6, `motion/react`, Lucide |
| AI | **Anthropic only** — `@anthropic-ai/sdk` 0.116, default `claude-sonnet-5` |
| Voice | OpenAI `gpt-4o-transcribe` — the *only* thing `OPENAI_API_KEY` is for |
| Auth | File-based: `crypto.scryptSync` + HMAC cookie. No external service |
| Storage | JSON files under `DATA_DIR` (Railway volume at `/app/data`) |
| Tests | **Vitest — 546 passing.** `npm test` |
| Notifications | ntfy (`NTFY_TOPIC_SECRET`) |

**Deleted on purpose — do not reintroduce:** Supabase (and `src/proxy.ts`, which
was its middleware), MiniMax, OpenRouter, the OpenAI *chat* path,
`parseXmlToolCalls`, per-user API keys, and the tiered Haiku/Sonnet routing.
Prompt caches are per-model, so per-message model switching missed the cache on
roughly every other turn.

---

## The scheduling engine — `src/lib/scheduling/`

**This is the centre of the project.** It exists because the LLM used to compute
slot placement itself and got it wrong invisibly: all-day events blocked nothing,
recurring series skipped conflict checks entirely, "free" slots were already
booked. The engine makes those failures structurally impossible.

```
types.ts        the contract — read this first, everything implements it
clock.ts        LocalISO: naive wall-clock time, NEVER UTC
windows.ts      profile + horizon -> DayWindow[]
timeline.ts     CalendarEvent[] -> BusyBlock[]; buffers, merging, gaps
methodRules.ts  all 18 methods -> block sizes, caps, breaks
priors.ts       feedback + memory -> learned hour/day weights
score.ts        candidate -> ScoredReason[]; WEIGHTS live here
place.ts        place one block, or say why it couldn't
repair.ts       bounded displacement of flexible events (depth 2)
plan.ts         planSchedule() — the public entry point
explain.ts      ScoredReason[] -> Hebrew sentences
adapter.ts      app state <-> engine input; the only UTC boundary
```

Three properties the design rests on. Breaking any of them breaks the engine:

1. **Pure.** No `fs`, no `fetch`, no `new Date()` — `now` is injected. Same
   context in, same plan out, byte for byte. That is what lets fixture tests
   assert exact start times.
2. **Every rejection is attributable.** A candidate never disappears silently; it
   becomes a `PlacedBlock` or an `Unplaced` with a code. "Nothing fits" is a bug.
3. **Every choice is explainable.** Blocks carry the `ScoredReason`s that won
   them. **The AI paraphrases those sentences and is forbidden to invent its
   own** — the reason is data, not narration.

### Time: `LocalISO` or nothing

All scheduling times are naive wall-clock strings (`"2026-08-11T14:00:00"`), never
UTC, never offset-bearing. `parseLocal` **throws** on a `Z` suffix on purpose.
Arithmetic in `clock.ts` runs through a UTC-backed instant specifically so the
host machine's DST rules cannot leak in — that bug was real: the same code gave
different answers on a developer machine and on the UTC server.

### `SCHEDULER_V2`

Off by default. Unset = the old behaviour byte for byte (proved by identity, not
just equality, in the tests). When on: `get_free_slots` disappears from the tool
list, `schedule_item` / `apply_plan` appear (propose then confirm, so a plan can't
drift between showing and committing), `break_down_task` and `move_event` become
engine front-ends, and recurring `create_event` checks every instance.

---

## The projects layer — `src/lib/projects/` (`PROJECTS`, off by default)

A project is a body of work with steps (a course, a deliverable, something you're
building). Tasks join one via the `project_id` that was reserved on `Task` and
`CalendarEvent` long before anything read it.

**The organising idea: the board is denominated in hours, not vibes.** Other
tools tell you what you should do; none of them knows whether you have the time.
So the deadline badge is a dry run of the real `planSchedule` — never a second,
simpler capacity formula, because the moment the board and the calendar disagree
both become untrustworthy.

```
types.ts       Project/KIND_RULES, CardSignal, SignalState, BoardRules
boardRules.ts  18 methods -> board shape. 5 presets, 18 rows of copy, 1 renderer
capacity.ts    the batched engine dry run
health.ts      resolveSignals() — the four card signals
cascade.ts     what deleting a project does (pure; the route just executes it)
```

Five things that are load-bearing:

1. **The board is keyed on `scheduling_method`, not `persona`.** They aren't
   siblings — method is *downstream*: `scheduling_method = the user's choice ??
   mapToMethod(persona, challenge, day_structure)`. `persona` has one writer and
   no UI to fix it; the method is backfilled on every load, changeable in
   Settings, and already self-corrects via `method_feedback`. A wrong method is a
   visible mismatch against a labelled control; a wrong persona is a silent
   default.
2. **One batched probe for all projects, never one per project.** Separate calls
   each get a fresh `emptyState`, so two projects competing for the same Tuesday
   would both read green.
3. **The probe asks for 125% of the work** (`CAPACITY_SLACK`). Asking for exactly
   the remaining work can only answer "does it fit" — and since the engine
   *spreads* sessions across the horizon, the last block always lands near the
   deadline, so measuring slack by its position marks every project as tight.
4. **`remainingMinutes` subtracts work already on the calendar.** Without it,
   scheduling a project makes its own risk look worse.
5. **`na` ≠ `unknown`.** `na` means there's nothing to know (no deadline) → the
   signal is dropped. `unknown` means there is and we don't → grey with a
   tappable "?". Missing data may only ever make a state worse, never better.

Numbers that exist elsewhere are **derived, never re-typed** — `BOARD_RULES`
stores no session length. That rule exists because the codebase already carries
the bug: `METHOD_SESSION_HOURS` and `METHOD_RULES[m].sessionMinutes` are two
tables for one number and **disagree on 10 of 18 methods** (`the_one_thing` 180
vs 120, `eisenhower` 90 vs 50, …). Mostly absorbed by `clampBlock`; worth fixing.

**Engine change that ships unflagged:** `PlacementRequest.dependsOn` is finally
read. `depOrder.ts` does a Kahn sort (not DFS — DFS lets a long chain jump ahead
of a tight deadline), and `plan.ts` raises a dependent's `earliest` to its
prerequisite's end. Ordering alone isn't enough: a greedy pass would still put A
on Tuesday afternoon and B on Tuesday morning. With no `dependsOn` present the
ordering is byte-identical to before, asserted by an identity test.

## Storage — `src/lib/store/`

`userStore` (synchronous read-modify-write) plus `withUserLock`. Everything goes
through `writeJsonFileAtomic` (temp file + rename) and `readJsonFile` (backs up a
corrupt file instead of overwriting it with the default).

**The lock is deliberately narrow.** A synchronous read-modify-write is already
atomic inside one Node process, so wrapping `userStore` in an async lock would
*add* `await` points that don't exist and manufacture the race it claims to
prevent. `withUserLock` covers exactly one shape: read a file → `await` something
→ write that file back. It is single-process only and does not protect against
multiple Railway replicas.

```
data/
  auth/users.json                 [{id, email, passwordHash, salt, tokenVersion}]
  users/{userId}/
    events.json  tasks.json  profile.json  projects.json
    memory.json  feedback.json  chat-history.json
```

`projects.json` needs no bootstrapping — a missing file reads as `[]`. Note
`updateProject` returns `null` on a miss and writes nothing, deliberately unlike
`updateTask`, which no-ops silently *and* writes the file back, which is why
`PUT /api/tasks/[id]` answers `{success:true}` for an id that doesn't exist.

---

## Auth — `src/lib/auth/`

scrypt password hashing, HMAC-signed session cookie (`zman_session`, 30 days).
Tokens carry a `tokenVersion` inside the signed payload; logout increments it,
which revokes every token already issued without needing a session store. A
record with no `tokenVersion` reads as `0`, so pre-existing sessions survive.

`roles.ts` gates `/api/admin/*` on `ADMIN_USER_IDS` and **fails closed** — unset
means nobody is an admin, including you.

---

## Chat — `src/app/api/chat/route.ts`

Tool-call loop → SSE stream. Client events: `events`, `text`, `done`, `error`,
`tasks_updated`, `memory_updated`, `onboarding_complete`.

Rules learned the hard way:
- **The terse-reply retry rule lives in exactly one place** (`src/lib/ai/followup.ts`).
  It used to exist twice with different thresholds; the weaker copy was on the
  default provider, which is why the assistant said "בוצע!" after doing nothing.
  Do not add a second copy.
- `done` is emitted in a `finally`. A stream that ends without it hangs the client.
- Sonnet 5 runs adaptive thinking by default and `max_tokens` caps thinking **plus**
  the reply — 8192, not 2048.
- `output_config.effort` defaults to `medium`, not `low`. While `SCHEDULER_V2` is
  off the model is still doing the placement reasoning, and `low` is documented for
  short, non-intelligence-sensitive turns. Drop to `low` once the engine carries it.
- `temperature` / `top_p` / `top_k` are rejected by Sonnet 5. None are sent.

---

## Client conventions

- **Check `res.ok`.** The whole client used to update local state regardless, so a
  401 looked exactly like success and silently reverted on the next 30s poll.
  Optimistic updates are fine — roll them back on failure and say so.
- Drag/resize on the calendar persists via `eventDrop`/`eventResize` →
  `PUT /api/events/[id]`, which also records the `moved` feedback signal. Before
  that existed, dragging an event did nothing at all, on desktop too.
- Chat history loads on mount and saves after each settled turn. It is not
  optional polish: without it the conversation is wiped on every reload.
- Bilingual everywhere. `isHe` / `language === 'he'`. Never ship a bare English
  string into a Hebrew screen.

---

## Notifications

`computeNotifications` in `src/lib/notifications/scheduler.ts` decides *what* to
send; `channels/ntfy.ts` sends it. One channel per notification, never two — ntfy
first when configured, then FCM, then web-push.

**Nothing is delivered unless both are true:** `CRON_SECRET` is set, *and* an
external scheduler actually calls `/api/cron/notifications?secret=…` every five
minutes. The app does not schedule itself. For a long time neither was true and
the entire feature was dead code.

---

## Commands

```bash
npm run dev          # localhost:3000
npm test             # Vitest — 546 tests
npx tsc --noEmit     # type check
npm run lint         # 4 pre-existing errors, all in untouched components
```

`--reporter=basic` was removed in Vitest 3 and now crashes with `ERR_LOAD_URL`.
Use `--reporter=verbose`.

Print the engine's plan for the fixture week (the human acceptance gate):

```bash
npx vitest run preview --reporter=verbose --disable-console-intercept
```

---

## Known gaps

| Gap | Note |
|---|---|
| Friday/Saturday held clear by default | Now a profile setting: `schedule_weekend` = `none` \| `friday` \| `both`, read by `weekendDaysFor` in `adapter.ts`. Measured on the fixture week: 15 sessions default, 19 with Friday, 23 with both. Awaiting the owner's answer, but it is a settings change now, not a code change |
| ~~No `extend_horizon` relaxation~~ | **Closed.** Proposes `+7d` and measures the payoff; reports 0 for deadline-bound work, which is the honest answer |
| `PlacedBlock.requestIndex` is `-1` for repair-created blocks | Ugly, not wrong |
| Plans held in process memory (10 min) | A redeploy between propose and confirm makes the user re-ask |
| The v1 system prompt still references `get_free_slots` | Overridden by the dynamic suffix under the flag rather than rewritten |
| `google-services.json` is a real Firebase project but `FIREBASE_SERVICE_ACCOUNT` is unset | Native push does not work; ntfy is the working path |
