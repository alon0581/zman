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
| Tests | **Vitest — 996 passing.** `npm test` |
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

### Breaks are spacing, not blocks (2026-08-18)

`MethodRules.breakMinutes` / `breakAfterMinutes` had **no reader anywhere**, so
Pomodoro never scheduled its 5 minutes and 52/17 never scheduled its 17 — the UI
promised a cycle and the calendar delivered 25 minutes of work followed by
whatever hole the scorer left (35 minutes, typically). Now:

- `spacingAround` (place.ts) inflates *the plan's own* blocks by the method's
  break instead of `profile.bufferMinutes`. The buffer is breathing room around
  the user's **existing** commitments; between two sessions of the method's own
  rhythm the break governs. It cuts both ways — looser for Pomodoro (5 < 15),
  tighter for 52/17 (17 > 15).
- `placeCycled` (plan.ts) offers the next session the slot exactly one break
  later, reusing `pinnedStart` the same way `placeRecurring` defends a series'
  anchor time. Spacing alone was not enough: the *scorer* picks the slot, and
  `BUFFER_RESPECTED` rewards distance.

A break is **never a `PlacedBlock`** — it would have to ship without reasons
(breaking invariant 3), and it would eat a `maxSessionsPerDay` slot and
`dailyCapMinutes` minutes, halving Pomodoro's promised eight sessions. It is also
not part of the block length, so `clampBlock`'s bounds still describe work only.
Inert for the other 16 methods, asserted by digest identity in `breaks.test.ts`.

### Travel is spacing too, and asymmetric (2026-08-20, `PLACES`)

The engine knew *when* the user was free and never *where they were*, so it would
end a block at 09:00 and start a lecture across town at 09:00. `Place`
(`places.json`, joined by `CalendarEvent.place_id`) carries a per-place prep time
and declared travel minutes; `lib/places/travel.ts` turns a day's events into a
`{lead, trail}` per event, purely. `toEngineBusy` stamps them onto `BusyBlock`.
**The engine never computes travel — it only honours it.**

- `inflate` was symmetric, one scalar for both edges. It now delegates to
  `inflateSides(block, {before, after})`; its own signature and behaviour are
  unchanged, which is what preserved identity for every existing caller.
- `travelPad` (timeline.ts) is **the one place** spacing and travel are composed,
  because `blockersFor` needs the identical rule — this repo has been bitten
  twice by one number living in two tables.
- **Travel ADDS to the buffer; a method break REPLACES it.** Not an
  inconsistency: a break and a buffer answer the same question and compete, while
  the buffer is time to wrap up and travel is the journey. Neither substitutes.
- `drop_buffer` cannot take travel with it, structurally — the relaxation can
  only reach `spacing`. Otherwise the engine would offer "skip your commute" as
  advice.
- A travel window is **never a `PlacedBlock`** (same argument as breaks), and
  deliberately gets **no `ReasonCode`** — it is never drawn and never narrated on
  success. It does get `UnplacedCode` `blocked_by_travel`, because reporting
  `blocked_by_fixed` for a candidate that only clipped the approach to a lecture
  is a false sentence.
- Travel is **not** charged to `dailyCapMinutes`. It is genuinely consumed time,
  unlike a buffer, but charging it shrinks the day twice. This is the number to
  revisit if busy days come out too empty.
- **Already there ⇒ zero, including prep.** Two back-to-back shifts at one place
  need nothing held open: prep is "how long to get ready to leave FOR here" and
  was spent before the first shift. Charging it again would silently swallow the
  only gap in a ten-hour day.

### Time: `LocalISO` or nothing

All scheduling times are naive wall-clock strings (`"2026-08-11T14:00:00"`), never
UTC, never offset-bearing. `parseLocal` **throws** on a `Z` suffix on purpose.
Arithmetic in `clock.ts` runs through a UTC-backed instant specifically so the
host machine's DST rules cannot leak in — that bug was real: the same code gave
different answers on a developer machine and on the UTC server.

### `SCHEDULER_V2` — **on in production since 2026-08-14**

Off by *default*, but now SET on Railway, so the engine path is the live one.
Unset = the old behaviour byte for byte (proved by identity, not
just equality, in the tests). When on: `get_free_slots` disappears from the tool
list, `schedule_item` / `apply_plan` appear (propose then confirm, so a plan can't
drift between showing and committing), `break_down_task` and `move_event` become
engine front-ends, and recurring `create_event` checks every instance.

---

## The projects layer — `src/lib/projects/` (`PROJECTS`, **on in production since 2026-08-14**)

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
../ai/projectTools.ts   tasks -> PlacementRequest[] for plan_project
```

**AI surface:** `create_project` (takes its steps inline, so one call replaces
six), `list_projects` (returns computed health — the model paraphrases the risk,
never re-derives it), `update_project`, `delete_project`, and `plan_project`.
`plan_project` needs **both** `PROJECTS` and `SCHEDULER_V2`: it returns a
`plan_id` only `apply_plan` can commit, and that tool is V2-only. It reuses the
existing `proposePlan`/`apply_plan` two-phase flow rather than adding a second
approval path. A dependency cycle is *refused here by name* even though the
engine tolerates one — the engine must stay total, but this layer has a user who
can fix the data.

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
stores no session length, and `BOARD_RULES.kanban.wipLimit` imports
`METHOD_RULES.kanban.maxSessionsPerDay` instead of restating it. That rule exists
because the codebase carried the bug twice: `METHOD_SESSION_HOURS` was a second
session-length table disagreeing with `METHOD_RULES[m].sessionMinutes` on 10 of
18 methods (**deleted 2026-08-17 — do not reintroduce one anywhere, including in
the prompt**), and Kanban's WIP limit existed as three different values (rules 4,
board 3, prompt "max 3") until 2026-08-18.

**Engine change that ships unflagged:** `PlacementRequest.dependsOn` is finally
read. `depOrder.ts` does a Kahn sort (not DFS — DFS lets a long chain jump ahead
of a tight deadline), and `plan.ts` raises a dependent's `earliest` to its
prerequisite's end. Ordering alone isn't enough: a greedy pass would still put A
on Tuesday afternoon and B on Tuesday morning. With no `dependsOn` present the
ordering is byte-identical to before, asserted by an identity test.

## Life phases — `src/lib/phases/` (`PHASES`, **on in production since 2026-08-17**)

The app's model of its user was a single flat snapshot written once at onboarding.
Nothing aged: no expiry, no decay, no re-validation. A phase is a **named period**
that owns its rhythm, commitments and definition of "important" — and that can
come back.

**No `PhaseKind` and no `PHASE_RULES` table, deliberately.** The exhaustive-Record
pattern is right for closed case sets (18 methods, 3 project kinds); here the case
set is every kind of human life — enlisting, being laid off, parental leave,
a semester. A compile error on `enlisted` would mean the app cannot describe a
period until someone ships code. The structure lives in the *interview*: the
questions are universal even when the answers are not.

Three things were badly wrong and are now fixed:

1. **`buildPersonProfile` was inverted.** A Map keeps a key's FIRST insertion
   position and emission took `slice(0, n)` — the head — so it preferred the
   OLDEST fact, with `Identity` as category #1 and `Patterns` as #8. The facts a
   life change invalidates were the most protected in the system; freshly observed
   behaviour was dropped first. Now: phase-filter, newest-first, and
   **reserve-and-fill** (`PROFILE_RESERVE`) so no category can be starved.
   Reordering alone would have moved the bug, not fixed it.
2. **`preferred_hours` was a ghost** — read in 7 places, written in 0, no UI, yet
   it overrode the wake/sleep controls Settings does expose. Verified against the
   production volume (no profile carries it) and removed from the precedence.
   It stays on the type marked vestigial; do not reintroduce a read.
3. **Settings and memory diverged forever.** Mirroring ran only at the onboarding
   transition, so a later `productivity_peak` edit left a contradicting memory row
   injected into every prompt. `mirrorProfileToMemory()` is now the single writer.

`AIMemory` gained `phase_id` (absent = timeless) and `updated_at`. **`created_at`
is FIRST-seen and is preserved across overwrites everywhere — it is not a recency
signal**; that is why `updated_at` exists. Scoping is not deletion: a closed
phase's rows stay in `memory.json` and merely stop being injected.

`buildSystemPrompt` takes an optional phase context; **with it absent the block is
byte-identical to before** (legacy path kept verbatim and separate).

Priors carry a 30-day half-life and a 120-day floor, applied before the ±3 clamp
and inert unless `now` is passed. **That parameter went unpassed for two days**:
`adapter.ts` called `buildPriors(feedback, memory)` with no `opts`, so decay and
the closed-phase filter were unreachable in production while 13 tests asserted
them. Fixed 2026-08-17 — `buildSchedulingContext` now forwards `now` and
`closedPhaseIds`. If you add another `buildPriors` call site, forward both, or
you have silently reintroduced "a three-month-old signal weighs as much as
yesterday's".

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

## Chat — the brain, and two mouths

```
lib/ai/runTurn.ts       the turn: prompt, Anthropic tool-call loop, follow-up retry
lib/ai/executeTool.ts   the dispatcher: every tool, and the writes they perform
app/api/chat/route.ts   transport only (167 lines) — SSE for the browser
app/api/ingest/route.ts transport only — JSON for the iPhone Shortcut
```

**A route file may export nothing but HTTP handlers and Next's route config**, so
while the loop lived inside `chat/route.ts` nothing else could ever reuse it. That
is why the brain is in `lib/`. The split was only possible because the tool loop
always finished *before* the stream was built — by the first SSE byte the reply
text and every flag were already final, and the word-by-word emission is
re-chunking, not generation. **Keep it that way.** The moment a route starts
deciding anything, the two callers can disagree, which is exactly how this
codebase acquired two session-length tables and three WIP limits.

`route.identity.test.ts` compares the full SSE body against a string written by
hand from the pre-refactor handler. It is what stops a tidy-looking change to the
wrapper from reordering a frame or word-splitting the backstop line.

SSE frames (browser): `events`, `onboarding_complete`, `memory_updated`,
`tasks_updated`, `projects_updated`, `text`, `error`, `done`.

### `POST /api/ingest` — the Shortcut ingress

Press the iPhone Action Button, speak, and the sentence is handled as if it had
been spoken in the app. `Authorization: Bearer $SHORTCUT_TOKEN`, multipart
`audio` (or `text`), and it answers JSON: `{ ok, heard, reply, created }`.

Four things it does that the browser path does not, each closing a real trap:

1. **It loads the calendar itself.** `/api/chat` takes `events` from the body
   because the browser holds them; a caller sending `[]` gets a model that thinks
   the week is empty — no conflict detection, cheerful double-booking. There is no
   `events` field here to get wrong.
2. **It defaults `timezone` to `Asia/Jerusalem`.** A phone reports no zone, and
   without one `userNow` is UTC, so a sentence spoken at 00:30 lands on yesterday.
3. **It writes `chat-history.json` directly**, under `withUserLock`. Never via
   `POST /api/chat-history` — that route overwrites the whole array from the
   client's copy and would race an open tab.
4. **It is rate limited** (20 / 15 min, keyed on the token). Nothing else under
   `src/app/api/` is, and this is the only credential that lives in an exported
   file on a phone.

The token is read from `Authorization: Bearer`, then `X-Zman-Token`, then `?t=`
in the URL. The query parameter contradicts the position taken elsewhere in this
file and the reasoning still stands — a secret in a URL is written to every
access log it passes through — but it is accepted here because **the Shortcuts
app silently discards headers and the request body whenever the HTTP method is
changed**, so the credential could not be reliably attached at all. Three
separate failures in one evening (missing header, missing body, missing query)
all surfaced as "the network connection was lost", which is why the route logs
content-type, byte count, token source and the received path on arrival. Keep
those logs: they turn that class of failure from an evening into one line.

Identified by `SHORTCUT_USER_EMAIL`, not a uuid: the local `users.json` carries a
different id for the same person plus three test accounts, so a mistyped uuid
would write into a neighbouring account in silence. Both env vars unset ⇒ 401 to
everything.

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
npm test             # Vitest — 996 tests
npx tsc --noEmit     # type check
npm run lint         # 2 pre-existing errors / 35 warnings, all in untouched components
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
| Friday/Saturday held clear by default | Now a profile setting: `schedule_weekend` = `none` \| `friday` \| `both`, read by `weekendDaysFor` in `adapter.ts`. Measured on the fixture week: 16 sessions default, 21 with Friday, 26 with both — remeasured 2026-08-18, since making Pomodoro's break real fits more work into the same days. Awaiting the owner's answer, but it is a settings change now, not a code change |
| ~~No `extend_horizon` relaxation~~ | **Closed.** Proposes `+7d` and measures the payoff; reports 0 for deadline-bound work, which is the honest answer |
| `PlacedBlock.requestIndex` is `-1` for repair-created blocks | Ugly, not wrong |
| Plans held in process memory (10 min) | A redeploy between propose and confirm makes the user re-ask |
| The v1 system prompt still references `get_free_slots` | Overridden by the dynamic suffix under the flag rather than rewritten |
| `buildMethodContext` still hand-writes the other 13 methods' copy | The five that stated a number the engine owns (pomodoro, rule_5217, theme_days, time_boxing, kanban) now interpolate it from `METHOD_RULES`. The rest state no number, so there is nothing to drift — but add a number there and you must derive it |
| `NTFY_TOPIC_SECRET` and `ADMIN_USER_IDS` are unset on Railway | Verified 2026-08-16. Nothing is ever delivered (ntfy is the working channel and it has no secret), and `/api/admin/*` 403s even for the owner. `FIREBASE_SERVICE_ACCOUNT` **is** set — an earlier note here claiming otherwise was stale |
