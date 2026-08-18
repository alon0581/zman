<!-- שוחזר מתמליל | שיחה: 0e7467d0-5395-48df-bd2a-db77236b1fad | זמן: 2026-08-15 00:07 -->

# Zman — Life phases (`PHASES`)

## Context

Zman's model of its user is a **single flat snapshot, written once at onboarding
and never revisited**. When someone's life changes, everything the app "knows"
silently rots — and because nothing carries a date the model can read, it cannot
even tell that it is working from stale facts.

The owner raised this after finishing his first year of studies and starting work
while continuing side projects. But he corrected an early draft of this plan for
being written around his case, and the correction *is* the requirement:

> The system has to fit every kind of person and every kind of period — that is
> why we built 18 methods in the first place.

His examples of transitions it must handle:

- a business owner who suddenly stops working
- a salaried employee between jobs
- a **מלש"ב who enlists — and is then on base all week**
- a student finishing a semester, working shifts over the break, returning in October

So this is **not** a student/work toggle and **not** an enum of life situations.
It is a generic, user-named period.

### What the owner settled

1. **User declares, AI interviews.** He says *"התגייסתי"* / *"התחלתי לעבוד"* and
   Zman asks a few questions and opens the phase. Not auto-detected.
2. **Old knowledge is packed per phase and comes back with it.** Returning to
   studies in October must restore what Zman learned about him as a student —
   not re-learn it from zero. **Phases recur.**
3. **What changes between phases:** what matters to him, recurring calendar
   commitments, and hours/shifts.

---

## The mechanism is worse than "facts go stale"

Everything below is verified in the current code. This is not a design worry —
it is the behaviour shipping in production today.

**Nothing ages, anywhere.** There is no expiry, decay, re-validation or staleness
detection in the codebase. The only invalidation is the model voluntarily
overwriting a key, or the user clicking × in Settings.

**`AIMemory.created_at` is write-only.** `{id, user_id, key, value, learned_from,
created_at}` — no validity, no supersede, no confidence. It is preserved verbatim
on overwrite at all four write sites, **read by no code path**, and absent from
the prompt text. So the model literally cannot tell a two-year-old fact from
today's. `memory.json` has no cap and never prunes.

**`buildPersonProfile` is inverted — it protects exactly the facts that rot.**
Verified at `systemPrompt.ts:21-58`. `byKey.set()` preserves each key's *first*
insertion position, and emission does `items.slice(0, PROFILE_MAX - count)` —
**the head of each bucket, i.e. the oldest entries**. Combined with the category
order:

| # | Category | Matches | Consequence at the 40-fact cap |
|---|---|---|---|
| **1** | `Identity` | `occupation`, `study_field`, `university`, `year_of_study`, `persona` | **The most protected facts in the system — and precisely the ones a life change invalidates** |
| 6 | `Goals` | `current_goal`, `ongoing_*`, `upcoming_focus` | By definition the most time-sensitive; sixth in line |
| **8** | `Patterns` | `pattern_*` | **Newly observed behaviour is dropped FIRST** |
| — | `day_structure` | matches nothing | Falls to `[Other]`, dropped before everything |

So the longer the app is used, the more confidently it asserts who you used to be.

**Priors have no time term at all.** `FeedbackSignal.at` is written at both record
sites and **read by nothing** — `buildPriors(signals, memory)` doesn't even
receive `now`. A three-month-old signal weighs exactly as much as yesterday's,
clamped ±3 in both directions. And **there is no "accepted" signal**: the only
positive evidence in the entire system is the user physically dragging an AI event
*into* an hour. Silently accepting a proposal registers nothing — so a stale
negative prior on 09:00 can only be unwound by repeatedly dragging things into it.

**Feedback eviction is count-based, not time-based.** `MAX_SIGNALS = 40`,
`list.slice(-40)`. "How long until the old rhythm is forgotten" has no answer in
days — it takes 41 new signals, and signals are only produced for **AI-created**
events on a drag-with-hour-change or a delete. Months-old signals routinely survive.

**The life-situation fields are write-once behind a one-way latch.**
`persona`, `challenge`, `day_structure`, `occupation` have **no Settings UI and no
tool** — their only writer is `complete_onboarding`, offered only when
`!onboarding_completed`, and that flag is auto-healed to `true` and never back
(`app/page.tsx:62-63`). There is **no `update_profile` tool** anywhere.

> **A live bug this plan must fix.** `preferred_hours` is read in **seven** places
> and **written in zero** — verified by grep. It has no UI, no tool, and is not
> even in `complete_onboarding`'s parameters. Yet it **silently overrides** the
> controls Settings *does* expose:
> ```ts
> // adapter.ts:120-121, duplicated at chat/route.ts:1102-1103 and :1793-1794
> const dayStartHour = profile?.preferred_hours?.start ?? parseHour(profile?.wake_time, 9)
> ```
> If a stale value is present, changing wake/sleep in Settings has **no effect on
> scheduling**, with nothing in the UI to say so.

**Settings and memory diverge permanently.** Profile facts are mirrored into
`memory.json` only at the one-time onboarding transition. Later Settings edits
write `profile.json` only — so changing `productivity_peak` leaves a contradicting
`productivity_peak: morning` memory entry injected into every prompt forever, with
no timestamp to arbitrate between them.

**Recurring commitments have no end.** A "series" is not an entity — just N rows
sharing `series_id`. `CalendarEvent` has no `series_end`/`until`/`count`. v1
generates 12 instances then stops dead; v2 clips to a 14-day horizon. And
**ending a series destroys its history**: `delete_series` filters by `series_id`
with no date bound and deletes every past instance. There is no "end this as of
today". Meanwhile a finished semester's lecture is still counted in the prompt's
course census, is still busy time for the engine, and is `fixed` mobility — so the
engine *refuses to reclaim the slot* and reports "no window" instead.

**Chat history is the only store that forgets** (100 cap, last 14 turns reach the
model). Everything that shapes long-term behaviour is the part that doesn't.

---

## The concept

**A phase is a named stretch of life that owns its own rhythm, commitments, and
definition of "important" — and that can come back.**

Three properties, and the generality requirement drives all three:

1. **Generic structure, specific content.** A phase has no `kind` enum. Its label
   is the user's own words — *"טירונות"*, *"בין עבודות"*, *"שנה ב'"*,
   *"חופשת לידה"*. What makes the interview possible without an enum is that
   **the questions a phase needs answered are universal even though the answers
   are not**: when are you available, what is fixed in your week, what matters
   most right now, what does your weekend look like. Those four are as meaningful
   to a soldier on base as to a freelancer between clients.
2. **Facts are scoped, not deleted.** Closing a phase does not throw knowledge
   away — it files it. "I work at Landver" belongs to a phase; "I have a fiancée"
   does not. Which is which is decided by a default the AI can override, because
   the category alone cannot always tell.
3. **Returning restores.** Reopening a phase brings back its hours, its method,
   and what the app had learned about how you actually behave in it. This is the
   property that makes the feature worth building rather than just adding an
   "archive memory" button.

The single sentence that captures it: **the app should be able to say "that was
true when you were a student" instead of asserting it as though it were true now.**

---

## 1. The `Phase` entity

`Phase` in `src/types/index.ts` beside `Project`; rules in `src/lib/phases/`.

```ts
export interface Phase {
  id: string
  user_id: string
  /** The user's own words. "סמסטר א׳", "חופש גדול", "צבא", "בין עבודות". Never an enum. */
  label: string
  /**
   * Identity ACROSS recurrences. Two phases with the same slug are the same KIND of
   * period at two points in time — this is the whole mechanism behind "what Zman
   * learned about me as a student comes back in October". Chosen by the AI, matched
   * against existing slugs FIRST (that is what list_phases is for).
   */
  slug: string
  started_at: string            // 'YYYY-MM-DD', LocalISO discipline
  /** Absent ⇒ this is the open phase. Exactly one phase may have this absent. */
  ended_at?: string
  /** User-declared, surfaced, never enforced. */
  expected_end?: string
  status: 'active' | 'closed'
  /** The three things the owner said change. Free text, filled by the interview. */
  summary: { priorities?: string; commitments?: string; hours?: string }
  /** Rhythm settings as they stood at close. Restored on reopen — only these fields. */
  profile_snapshot?: Pick<UserProfile,
    'wake_time' | 'sleep_time' | 'productivity_peak' | 'schedule_weekend' | 'occupation' | 'day_structure'>
  /** Written at close. Becomes the reopen OFFER — never an automatic recreation. */
  retired_series?: { series_id: string; title: string; weekday: string; hour: number; last_kept: string }[]
  created_at: string
}
```

**No `PhaseKind`, and no `PHASE_RULES: Record<PhaseKind, …>`.** The exhaustive-Record
pattern (`METHOD_RULES`, `KIND_RULES`, `BOARD_RULES`) is right when the case set is
*closed* — 18 methods, 3 project kinds — because then "adding a case must be a compile
error" is a feature. Here the case set is *every kind of human life*, and a compile
error on `enlisted` means the app cannot describe a period until someone ships code.
**Write that reasoning into the header of `phases/types.ts`**, or a future session will
helpfully "fix" it into a table.

**No machine-readable `Phase.hours` either.** The codebase already has one ghost field
silently overriding the editable controls (`preferred_hours`); a phase-level override
would make that a three-deep chain with two ghosts. Live hours stay in
`profile.wake_time`/`sleep_time` — one source of truth, editable in Settings — and the
phase holds only the *archive* for restore.

**Storage:** `phases.json`, four `userStore` methods copying the Projects block verbatim
(including its better contract: `updatePhase` returns `null` on a miss and writes
nothing). **No migration script** — the first declaration creates the *outgoing* phase
retroactively (`started_at` = earliest `created_at` in memory), then opens the new one.
The bootstrap path *is* the close+open path. Before that, `phases.json` doesn't exist and
every read degrades to today's behaviour.

---

## 2. Scoping — phase-bound vs timeless

`AIMemory` gains **two** optional fields:

```ts
  phase_id?: string     // absent = timeless, or written before phases existed
  updated_at?: string   // last WRITTEN. See the correction below.
```

> **Correction to my earlier draft.** I planned to sort by `created_at`. That is wrong:
> `created_at` is *deliberately* preserved across overwrites at all four write sites, so
> on a key rewritten ten times it is the date of the **first** version. Using it for
> recency would be actively misleading. `created_at` is correct as it stands — it needed
> a sibling, not a reader. That sibling is `updated_at`.

**The category table decides the default; the AI overrides per entry** via an optional
`scope: 'phase' | 'always'` on `save_memory` (flag-gated parameter extra). The table
carries the load because the model is unreliable at a judgement it must make on *every*
write; the enum is the escape hatch for the rare case it knows better.

**When neither regex matches, default to `'always'` (timeless).** Mis-scoping a timeless
fact as phase-bound makes it **vanish** at close — silent forgetting, the exact failure
this feature exists to end. Mis-scoping the other way makes it **linger** — visible in
the prompt, correctable by the × that already exists in Settings.

Note this **inverts the projects layer's rule** ("missing data may only ever make a state
worse"). There the conservative direction is pessimism; here it is retention. Both are
"never claim more than you know", pointed in different directions — say so in the file
header, because the two will look contradictory to a future reader.

**Scoping is not deletion.** Rows stay in `memory.json` forever; they stop being
*injected* while another phase is open. That is what makes restore a `filter`, not an
`insert`.

---

## 3. Fixing `buildPersonProfile` — the inversion

```ts
function buildPersonProfile(memory?: AIMemory[], phase?: ActivePhaseCtx): string
```

`buildSystemPrompt` gains an optional 7th param. **The entire new behaviour is selected
by that param being present** — omit it and the function returns byte-identical strings.
That is the flag mechanism, provable by an identity test the way `projectsFlag.test.ts`
proves the tool arrays.

1. **Phase filter first.** Keep iff `!m.phase_id || m.phase_id === active.id`. Doing this
   *before* anything else is the point: a closed phase's 30 stale facts never compete for
   the 40 slots at all.
2. **Dedupe newest-wins, fixing the Map-position bug.** `byKey.set()` updates the value
   but keeps the key's *original* insertion position — that is the oldest-first bug.
   Use `byKey.delete(k); byKey.set(k, m)` and pick by `max(updated_at ?? created_at)`.
3. **Sort each bucket newest-first.**
4. **New category order** — Goals, Commitments, Patterns, Rhythm (now including
   `day_structure`, which today matches nothing and dies in `[Other]`), Preferences,
   Identity, Method fit, Life, Other. The reasoning: *the injected block's job is to make
   the next proposal right.* Goals, commitments and observed patterns change **what the
   proposal should be**; identity mostly changes **how it is phrased**.
5. **Reserve-and-fill, not pure priority.** Pure ordering still starves the tail — that
   is the current bug in a new order, not a fix for it. An exhaustive
   `Record<ProfileCategory, number>` gives each category a floor (~35 of 40); the
   remaining 5 fill by **global recency** regardless of category. So `Patterns` can never
   be squeezed to zero, `[Other]` keeps a floor of 2, and a burst of fresh learning still
   gets extra room. **This** is where the house exhaustive-Record pattern belongs — the
   category set genuinely is closed.
6. **Ages on Goals and Patterns only** — `(~3d)` / `(~4mo)` from `updated_at`. Those are
   the two buckets where age changes the meaning. ~4 tokens × 10 lines, not × 40.
7. **Phase banner**, first line: `👤 PERSON PROFILE — current phase: "…" (since …, week 7)`.

**Cache safety:** `personProfile` is already interpolated into `dynamicSuffix`
(`systemPrompt.ts:571`) — verified — so all of this is free. The banner must never leak
into `staticPrefix`; the week counter alone would break the cache every seven days.
One accepted cost: `profileSummary` (`:180`) *is* in the prefix and carries
`occupation`/wake/sleep, so a transition breaks the prefix cache **for one turn**, then
re-stabilises. Transitions are monthly. Accept it.

---

## 4. Priors across phases — scoped **and** decayed

Phase-scoping alone does nothing about a stale prior *within* a long phase, so decay is
the more important half.

- `FeedbackSignal` gains `phase_id?`; `buildPriors` gains an optional third param
  `{ now?, phaseId? }` — additive, so every existing call site and all of
  `priors.test.ts` keep passing.
- `halfLifeDays: 30`, `floorDays: 120`. Decay applied **before** the ±3 clamp, so twenty
  fresh rejections still saturate. **When `now` is absent the factor is 1** — identical
  to today. `FeedbackSignal.at` finally gets a reader.
- Signals from *closed* phases are dropped. Un-stamped signals are kept and simply decay.

This gives "how long until an old signal stops mattering" a **time** answer for the first
time: ~1 month to half, ~4 months to nothing. Today the answer is "41 more signals", on a
store whose fill rate is near-zero.

> **Correction to my earlier draft — an old phase's priors must NOT come back.** I had
> planned to snapshot `Phase.priors` and restore them. That is wrong: a prior is evidence
> about *when to schedule against a particular calendar*, and last semester's calendar no
> longer exists. What returns is the **distilled** form — the `pattern_*` memory the
> prompt already tells the model to write after 2–3 repeats, which is phase-scoped,
> therefore restored, therefore read by `buildPriors`' memory arm on day one.
> So a returning phase starts with **weak priors and strong memory** — the calendar
> changed, the person didn't. This also deletes `Phase.priors` from the entity and needs
> no signal archive at all.

**A brand-new phase gets `emptyPriors()`** — already the honest answer, already what
happens, `score.ts` already handles `{}`. Seed nothing.

**The missing `accepted` signal is cut from v1**, and that is a real cost worth naming:
it is the *root cause* of the asymmetry — only a positive signal can actively unwind a
stale negative. But it changes `apply_plan` semantics, needs a new weight calibrated
against `movedToHour`, and risks flooding the 40-slot FIFO with low-information positives
that evict high-information negatives. Bundling it means phases cannot ship until both are
right. Decay demotes it from *permanent* to *gone in four months*. Highest-value follow-up.

---

## 5. Retiring a phase's recurring commitments

`CalendarEvent` gains `phase_id?`, stamped at create. New pure module
`src/lib/phases/retire.ts`, shaped exactly like `projects/cascade.ts` — pure decision,
route executes, *the destructive path should be the well-tested one*:

```ts
export function planSeriesRetirement(
  events: CalendarEvent[], seriesId: string, cutoff: LocalISO
): { deleteIds: string[]; keptPast: number; lastKept?: string }
```

**Boundary pinned by a test:** an instance starting *on* the cutoff date is deleted — you
said "I stopped going" today, so today's lecture didn't happen.

**`end_series` is a dedicated tool, not a parameter on `delete_event`.** A parameter is
only reachable if the model *already chose the destructive tool*, and *"הפסקתי ללכת
לחדר כושר"* does not sound like "delete". This is the same lesson the projects layer
learned the hard way, and `delete_event`'s description gets a flag-gated override
pointing at it.

**Which series belong to a closing phase:** `phase_id` for anything created after this
ships. For everything already on the calendar there is **no backfill and no heuristic** —
the AI shows the series census the prompt already builds and asks one question:
*"מה מהסדרות האלה נגמר עם התקופה?"* Series the user doesn't name are left alone.

**Reopening does NOT recreate events — the single most important "must not".** A
timetable changes between semesters; recreating last semester's lecture times would be
confidently, invisibly wrong. `retired_series` becomes an *offer*: *"בסמסטר הקודם היו לך
5 סדרות — רוצה שנקים מחדש? תן לי את המערכת החדשה."*

---

## 6. The transition flow

**Detection lives in the tool description**, Hebrew triggers first: *"התחלתי לעבוד"*,
*"התגייסתי"*, *"סיימתי סמסטר"*, *"פוטרתי"*, *"אני בין עבודות"*, *"יצאתי לחופשת לידה"*.

**Three questions, capped structurally — not by asking the prompt to be brief:**

1. שם + אופק → `label`, `expected_end`
2. שעות/משמרות → `summary.hours` + optional profile writes
3. מה חשוב + מה חוזר שבועית → `summary.priorities`, `summary.commitments`

- `required: ['label']` **and nothing else** — a phase is not a form.
- The cap is *in the description*: "ask at most THREE questions; if the user answered
  fewer, open the phase anyway — a phase with one field filled beats no phase."
- **Carry-over pre-fill:** when the slug matches a closed phase the interview collapses to
  **one** question — *"חוזר ללימודים כמו בסמסטר שעבר? מה השתנה?"* The restore already
  answered the rest. That is the payoff of recurrence, and the user should feel it.

**There is no separate `close_phase` tool.** `start_phase` closes the previous one as an
atomic side effect. Two tools would let the model open a phase without closing the old
one — two active phases makes the §3 filter meaningless.

**Tasks: untouched, always.** A task is a promise to yourself; hiding it because you
changed jobs is the app losing your work. **Projects: offered, never automatic** —
`Project.status` already has `'paused'`, which means exactly this.

| Restored | **NOT** restored |
|---|---|
| memory rows with the matched `phase_id` (a filter, not an insert) | calendar events — **offered** from `retired_series` |
| `profile_snapshot`: wake, sleep, peak, weekend, occupation, day_structure | feedback signals and priors (§4) |
| `summary.*` as the interview pre-fill | `ongoing_*`, `current_goal`, `upcoming_focus` — **explicitly denied** |

**`RESTORE_DENY` is the sharpest call here.** The prompt already opens with *"אני רואה
שעבדנו על [ongoing_task] — רוצה להמשיך?"* Resurrecting a four-month-old one is this
feature's worst possible failure: it would make Zman *less* trustworthy than the flat
snapshot it replaces.

---

## 7. Tool surface

Flag **`PHASES`**, `phasesEnabled()` — the third reader beside the existing two.
`PHASE_ONLY_TOOLS` + the same fail-closed dispatcher guard.

| Tool | Notes |
|---|---|
| `start_phase` | Required `label` only. Closes the previous phase atomically. Returns what was restored. |
| `list_phases` | How the model finds an existing **slug** instead of minting `semester_1` vs `studies` vs `university` — the failure that would break recurrence entirely. |
| `end_series` | Contrasts with `delete_event` in sentence one. |
| `update_profile` | **See below — I was wrong to say this wasn't needed.** |

> **Correction to my earlier draft.** I wrote that `update_profile` should not be added.
> That is wrong: question 2 of the interview asks about hours, hours live in
> `profile.wake_time`/`sleep_time`, and the model has had **no way to write them since
> onboarding** — `complete_onboarding` is permanently unreachable once
> `onboarding_completed` latches true. Asking a question you cannot store the answer to is
> the worst kind of interrogation.

Scope it as a **deny-list asserted in a test**. Allowed: `wake_time`, `sleep_time`,
`productivity_peak`, `schedule_weekend`, `occupation`, `day_structure`, `challenge`.
**Never:** `autonomy_mode` (the user's consent setting — *the model must not be able to
widen its own permissions*), `scheduling_method` (self-corrects via `method_feedback`, has
a Settings control, and drives the projects board — a silent rewrite would fight visible
UI), `language`, `theme`, `preferred_hours`, anything `ai_*`/`push_*`.

**`update_profile` must mirror to memory.** Extract `api/profile/route.ts:81-90` into
`mirrorProfileToMemory()` and call it from all three writers — onboarding, **Settings'
POST** (which today writes only `profile.json`), and `update_profile`. That closes the
Settings↔memory divergence as a byproduct of work this feature needs anyway. Best
value-per-line in the plan.

`PHASES_GUIDANCE` goes in the **dynamic suffix** only. It explains the *concept*; the
**descriptions carry the routing** — prose lost to a more specific description once
already in this repo, and that is documented in `tools.ts` as a bug that shipped.

---

## 8. The `preferred_hours` bug — first commit, unflagged

This feature makes the bug **reachable and worse**: the interview asks "when are you
available now?", `update_profile` writes wake/sleep, and a legacy `preferred_hours`
silently wins. The user would watch Zman ask about their new shifts, agree, and then
schedule against the old hours. Not flagged, because a flag on a bug fix ships the bug on
by default.

**Check the Railway volume first.** No local profile carries it and nothing writes it, so:
- **(a), if unused in prod:** delete the three `??` reads. Keep the field on the type —
  removing it would break existing reads.
- **(b), if some profile has it:** invert precedence so the editable control wins.

Either way `adapter.test.ts:105` — *"prefers preferred_hours over wake/sleep"* —
currently **pins the bug as correct** and must be rewritten and retitled, not deleted.

**Same commit, two more characters of risk:** `chat/route.ts:261` passes the *client-sent*
`profile` to `buildSystemPrompt`, while `freshProfile` (`:211`) is read and used only for
push tokens. After `update_profile` writes mid-turn, the rest of that turn reasons from
stale hours — and the transition turn is precisely the turn where the profile changed.
Pass `freshProfile ?? profile`.

---

## 9. Scope

| # | Work | Flagged? |
|---|---|---|
| 1 | `preferred_hours` fix + `freshProfile` fix + `mirrorProfileToMemory` | **No** — bug fixes, valuable alone |
| 2 | `Phase` type, `phases.json`, 4 `userStore` methods | Inert (no writer) |
| 3 | `AIMemory.phase_id`/`updated_at`, `phases/scope.ts` | Inert (additive) |
| 4 | `buildPersonProfile` rewrite + 7th param | By param presence |
| 5 | `start_phase`, `list_phases`, `update_profile`, guidance | `PHASES` |
| 6 | `planSeriesRetirement`, `end_series`, description override | `PHASES` |
| 7 | `FeedbackSignal.phase_id`, decay, phase filter | By `opts` presence |

**Steps 1–4 ship and are valuable with `PHASES` never turned on.** That is the test of an
honest decomposition: the app gets better before the feature exists. Step 4 alone stops
the prompt preferring a stale `occupation` over a fresh `pattern_*`.

**Cut:** all Phases UI (the declaration is conversational by decision; UI comes after the
model proves it opens phases correctly — *optional*: a read-only phase name above the
memory card, ~20 lines); the `accepted` signal; phase-scoped tasks/projects; machine-
readable `Phase.hours`; auto-detection; memory eviction (phase filtering bounds the
*injected* set, which is the cost and quality problem — file growth at one user is not).

---

## 10. Tests

~60 new on a **589** baseline.

| File | Proves | ~n |
|---|---|---|
| `phases/scope.test.ts` | Each regex arm; **an unmatched key stays timeless, because losing a true fact is worse than keeping a stale one**; `RESTORE_DENY` catches all three families | ~12 |
| `phases/retire.test.ts` | **Past instances survive** (the regression); the cutoff-date instance is deleted (boundary); an all-past series is a no-op; unknown id returns empty | ~10 |
| `ai/systemPrompt.phases.test.ts` | **Identity: 7th param omitted ⇒ byte-identical prefix *and* suffix**; newest-wins dedupe; closed-phase facts absent; **at the 40 cap a fresh `pattern_*` survives where a closed-phase `occupation` does not** (the inversion, asserted directly); `day_structure` no longer in `[Other]`; `[Other]` keeps its floor; banner in suffix and **not** in prefix; ages on Goals/Patterns only | ~18 |
| `scheduling/priors.decay.test.ts` | No `now` ⇒ byte-identical (identity); a 30-day signal weighs exactly half; 120-day contributes zero; **decay before clamp** so 20 fresh rejections still hit −3; closed-phase signals dropped | ~12 |
| `ai/phasesFlag.test.ts` | Flag-off returns the **identical array object**; `save_memory` has no `scope` when off; `delete_event`'s description untouched when off; and an explicit **deny assertion that `update_profile` never exposes `autonomy_mode`, `scheduling_method` or `preferred_hours`** | ~14 |

**New fixture `__fixtures__/cafe-shift-week.ts`.** Every scheduling fixture in the repo is
a student week, so *"the system fits every kind of person"* is currently **untested by
construction** — the only life the engine has ever been proven against is the one it was
built for. Evening + weekend café shifts, no lectures, two side projects. The cheapest
possible proof, and it makes the human acceptance gate show two lives instead of one.

---

## Verification

```bash
npx tsc --noEmit && npm test && npm run lint
npx vitest run preview --reporter=verbose --disable-console-intercept
```

End to end with `PHASES=1`:

1. *"התגייסתי"* → at most three questions → phase opens, previous closes.
2. PERSON PROFILE now leads with the new phase and **labels** old facts instead of
   asserting them; a fresh `pattern_*` is present where it used to be dropped.
3. Last semester's lectures retire **as of today** — past instances still on the calendar.
4. Change wake/sleep in Settings → it now actually affects scheduling.
5. Declare a return to studies → slug matches → **one** question; hours and method come
   back; `current_goal` does **not**; retired series are *offered*, not recreated.
6. Unset `PHASES` → tools gone, profile block byte-identical to today.

