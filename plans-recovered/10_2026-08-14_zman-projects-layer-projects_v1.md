<!-- שוחזר מתמליל | שיחה: 0e7467d0-5395-48df-bd2a-db77236b1fad | זמן: 2026-08-14 18:18 -->

# Zman — Projects layer (`PROJECTS_V1`)

## Context

Zman today answers *when*. It owns the calendar, a pure scheduling engine, and a
Hebrew chat that puts work on the calendar. What it cannot answer is *where am I
on the things I actually care about* — a course, an exam, a side project. Tasks
exist, but they are a flat list grouped by a free-text `topic`; there is no
entity that says "this is one body of work, it is due then, and here is how much
of it is left".

The owner wants that layer: manage projects, see where he stands, set himself
work, and have it look good and be efficient — for coursework and for personal
build projects alike, in one place.

**Why this is an extension and not a rewrite.** The groundwork was laid
deliberately in an earlier session and never used:

| Already reserved | Where |
|---|---|
| `Task.project_id?: string` | `src/types/index.ts:37` |
| `CalendarEvent.project_id?: string`, `CalendarEvent.ref?: {kind, id}` | `src/types/index.ts:19-20` |
| `PlacementRequest.ref.kind: 'event' \| 'task' \| 'project'` | `src/lib/scheduling/types.ts:168` |
| `PlacementRequest.dependsOn?: string[]` — *"Reserved for projects"* | `src/lib/scheduling/types.ts:187` |
| `planSchedule(ctx, requests: PlacementRequest[])` — already batch | `src/lib/scheduling/plan.ts:70` |

Each of the three comments says *"nothing reads or writes this yet"*. This plan
makes them read and write.

**Owner's decisions, already settled:**
1. Scope = coursework **and** personal/dev projects — one entity, a `kind` discriminator, different creation templates.
2. UI = a third mobile tab, a Tasks/Projects toggle in the desktop 340px panel, and a full board overlay.
3. Scheduler coupling = **batch-plan-with-approval**, not auto-maintenance.
4. The card shows **all four** signals: deadline risk, progress %, next step, time invested.

---

## The concept

Trello, Notion and Linear tell you what you *should* do. None of them knows
whether you *have the hours*. Zman does — it owns the calendar and an engine
that already computes real free capacity against the user's method and habits.

So the organising idea is: **a project board denominated in hours, not in vibes.**

Three principles the design holds to:

1. **A project is a promise measured in hours.** Its headline is not "60% done",
   it is *"נשארו 14 שעות, יש לך 9 פנויות עד המבחן"*. That sentence is produced by
   a dry run of the real scheduling engine — the same code that places the
   blocks — so the board can never disagree with the calendar.
2. **One truth, two views.** The board's unit is the `Task`; the calendar's unit
   is the `CalendarEvent`; the link is `project_id` on both. Time invested is
   never self-reported — it is summed from calendar blocks that already
   happened.
3. **The AI plans a whole project at once.** Dependencies and a deadline only
   make sense together; scheduling task-by-task is how you end up doing step 3
   before step 1.

The one column no other tool has: **"ללא זמן משובץ"** — tasks that belong to the
project and have zero calendar time. That column is the entire product thesis in
one strip of UI.

---

## 1. The `Project` type

New, in `src/types/index.ts` next to `Task`:

```ts
export type ProjectKind = 'course' | 'build' | 'general'

export interface Project {
  id: string
  user_id: string
  title: string
  kind: ProjectKind
  description?: string
  /** Hex, reused as the calendar colour for every block this project generates. */
  color?: string
  /** Final due date, LocalISO or 'YYYY-MM-DD'. Drives deadline risk. */
  deadline?: string
  /** Owner's own estimate of total work. The denominator for progress. */
  estimated_hours?: number
  status: 'active' | 'paused' | 'done' | 'archived'
  created_at: string
  completed_at?: string
  /** kind-specific extras — additive, so a later kind cannot break existing reads. */
  meta?: {
    course_code?: string      // course
    semester?: string         // course
    repo_url?: string         // build
    [k: string]: string | undefined
  }
}
```

Deliberately **not** included in v1: members/assignees (single user), attachments,
comments, custom fields, per-project methods, budget. Each is a real feature and
none is needed to answer "where do I stand".

**`kind` earns its place** by changing only the creation template, not the
schema: a `course` opens pre-seeded with *מטלות / תרגילי בית / מבחן*, a `build`
with *אפיון / מימוש / בדיקות / פריסה*. `general` is empty. The templates live in
one pure table, `src/lib/projects/templates.ts`, so adding a kind is data.

**`Task` gains exactly two optional fields** — both optional, so live
`tasks.json` keeps reading:

```ts
  depends_on?: string[]   // ids of tasks that must finish first
  order?: number          // manual position within a board column
```

`project_id` already exists. `topic` stays as-is and is untouched — a task can
have both; `topic` is a lens, `project_id` is membership.

---

## 2. Storage + API

**`projects.json`, through `userStore`** — not a standalone module. `userStore`
already owns the two collections that projects joins to, and the repo's other
two conventions (a `lib/*/store.ts` module, helpers inlined in the route) are
the ones that produced three divergent copies of the profile default.

Add to `src/lib/store/userStore.ts`, mirroring the tasks helpers exactly
(`projectsFile` / `readProjects` / `writeProjects`, synchronous, `userId` last):

```ts
  getProjects(userId = 'demo'): Project[]
  addProject(project: Project, userId = 'demo')
  updateProject(id: string, updates: Partial<Project>, userId = 'demo')
  deleteProject(id: string, userId = 'demo')
```

Missing file reads as `[]` via `readJsonFile` — no bootstrapping, no migration.
This is not a theory: no user directory on disk currently contains a
`tasks.json` at all (they hold only `profile.json`, and for the active user
`events.json` / `memory.json` / `chat-history.json`), and tasks work. Adding
`projects.json` is the same path, already proven in production.

**Routes**, copying `src/app/api/tasks/route.ts` verbatim in shape (local
`getAuthUserId()`, `str()` coercer, whitelist-with-default enums,
`crypto.randomUUID()`, `{ projects }` / `{ project }` envelopes):

| Route | Handlers |
|---|---|
| `src/app/api/projects/route.ts` | `GET` (list) · `POST` (create, optionally seeding template tasks) |
| `src/app/api/projects/[id]/route.ts` | `PUT` (whitelisted fields only) · `DELETE` |

**Fix, do not copy, the known weakness**: `tasks/[id]` PUT spreads the raw body
into the store. The projects PUT whitelists its fields explicitly.

**Delete semantics — orphan, never cascade.** Deleting a project clears
`project_id` on its tasks and events; it never deletes a calendar block. Losing
a week of scheduled study because you archived a course is unrecoverable on a
live volume with no staging. The route returns `{ success: true, orphaned_tasks: n, orphaned_events: m }`
so the UI can say what happened. `status: 'archived'` is the normal exit; delete
is the rare one.

---

## 3. The four health signals

All four live in **one pure module**, `src/lib/projects/health.ts` — no `fs`, no
`fetch`, no `new Date()`, `now` injected. Same discipline as the engine, for the
same reason: it must be fixture-testable.

```ts
export interface ProjectHealth {
  progressPct: number            // 0-100, by HOURS not task count
  investedHours: number
  remainingHours: number
  capacityHours: number | null   // free hours before the deadline; null when no deadline
  risk: 'ok' | 'tight' | 'over' | 'unknown'
  nextStep: { taskId: string; title: string; scheduledAt: LocalISO | null } | null
}

export function computeProjectHealth(
  project: Project,
  tasks: Task[],
  events: CalendarEvent[],
  probe: CapacityProbe,     // injected — see below
  now: LocalISO,
): ProjectHealth
```

How each number is produced:

- **Progress %** — `investedHours / (investedHours + remainingHours)`, in **hours,
  not task count**. A task count lies the moment two tasks are unequal, and in
  coursework they always are. Falls back to task count only when no task carries
  `estimated_hours`.
- **Time invested** — sum of `CalendarEvent`s where `project_id === project.id`
  and `end_time <= now`. Never self-reported. Plus the `estimated_hours` of tasks
  marked `done` that had no blocks, so manual completion still registers.
- **Remaining** — sum of `estimated_hours` over tasks not `done`, falling back to
  `project.estimated_hours` minus invested when tasks carry no estimates.
- **Next step** — the first task that is not `done` and whose `depends_on` are all
  `done`, ordered by `order` then deadline then priority; plus the start of its
  earliest future calendar block, or `null` for the "לא משובץ" state that the UI
  makes actionable.
- **Deadline risk** — the hard one, and **it reuses the engine rather than
  computing capacity a second way**. A second capacity calculation is guaranteed
  to drift from the first, and then the board and the calendar contradict each
  other.

  `src/lib/projects/capacity.ts` exposes:

  ```ts
  export function probeCapacity(ctx: SchedulingContext, hoursNeeded: number, deadline: LocalISO): number
  ```

  It builds a **single synthetic `PlacementRequest`** — `ref: { kind: 'project' }`,
  `totalMinutes = hoursNeeded * 60`, the real `deadline` — and calls the real
  `planSchedule(ctx, [request])` (`plan.ts:70`) as a **dry run, discarding the
  result's blocks**. It reads `status` and sums placed minutes:
  `ok` → all of it fits; `partial` → placed minutes are the capacity floor;
  `blocked` → zero. The context comes from the existing
  `buildSchedulingContext(profile, events, memory, feedback, timezone, now, horizonDays)`
  (`adapter.ts:239`) with `horizonDays = horizonDaysFor(now, deadline)`
  (`adapter.ts:281`), clamped by the existing `MAX_HORIZON_DAYS = 120`.

  Thresholds: `over` when capacity < remaining; `tight` when capacity < remaining × 1.25;
  `ok` otherwise; `unknown` when the project has no deadline. The 25% cushion is
  a named constant, not a literal, because it is a judgement call that will be
  tuned.

**Cost note.** The probe is a real placement pass. It runs **server-side on
demand** — on `GET /api/projects` and after a mutation — never per render and
never in a 30s poll loop. The list route computes health once for all projects
against one shared `SchedulingContext` and returns `{ projects, health }`.

---

## 4. Batch planning with dependencies

### 4a. Implementing `dependsOn` in the engine

This is the only change to `src/lib/scheduling/`, and it is real work — the field
is declared and never read.

**Ordering** — a new pure export in `plan.ts` beside `orderRequests`:

```ts
export function orderRequestsWithDependencies(
  requests: PlacementRequest[],
  rules: MethodRules,
): { order: number[]; ignoredEdges: { from: number; to: number }[] }
```

Kahn's algorithm over the `dependsOn` graph, using the **existing
`orderRequests` result as the tie-break within each ready set** — so with no
`dependsOn` anywhere the output is byte-identical to today's `orderRequests`.
That identity is the regression test.

**Cycles must not crash.** Nodes still unresolved when Kahn's queue empties are
in a cycle; their incoming edges are dropped deterministically (lowest index
first), they are appended in `orderRequests` order, and the dropped edges are
returned in `ignoredEdges`. The engine stays total. **Rejecting a cycle is the
tool layer's job**, not the engine's, because that is where there is a user to
tell — `plan_project` validates first and returns an error naming the two tasks.

**Constraint propagation** — inside the `for (const requestIndex of order)` loop
at `plan.ts:83`, derive an effective request and pass it to
`placeSessions`/`placeRecurring` in place of `request`:

```ts
const effective = withDependencyEarliest(request, requestIndex, requests, blocks)
```

which returns `request` unchanged when `dependsOn` is empty, and otherwise a
shallow copy whose `earliest` is `max(request.earliest, latest end among blocks
already placed for its predecessors)`.

This works with **zero changes inside `place.ts`, `score.ts` or `repair.ts`**,
because `place.ts:128-129` already does exactly the right thing with the field:

```ts
const floor = maxISO(ctx.now, request.earliest)
const admissible = clipWindows(dayScoped, floor, request.deadline, durationMinutes)
```

(Note: `earliest` is **not** handled by `windowsFor` at `plan.ts:560` — that
function only applies `hardWindows`. The propagation hook therefore belongs on
the request passed *into* placement, not on the windows.)

A dependent that then cannot fit gets an attributable code for free, since
`temporalFailure(ctx, request, dayScoped, floor, …)` at `place.ts:135` already
distinguishes "the deadline removed every window" from "the horizon did". A
predecessor that failed to place leaves `earliest` untouched and the dependent is
scheduled on its own merits; the predecessor's own `Unplaced` tells the honest
story rather than silently cascading.

**Do not add an `AFTER_DEPENDENCY` `ReasonCode`.** It is tempting — `RENDERERS`
in `explain.ts:73` is an exhaustive `Record<ReasonCode, …>`, so a new code is
compile-safe and cheap. But `ScoredReason` carries a `weight` that feeds the
score, and it answers *"why did this slot score well"*. A dependency is a **hard
constraint**, not a preference: it removes windows, it does not rank them.
Forcing it into `WEIGHTS` would mean either a meaningless zero-weight entry or a
score that double-counts a constraint. The user still deserves the explanation —
so `plan_project` attaches a plain `after: "<predecessor title>"` field to its
block view in `projectTools.ts`, at the tool-result layer where the sentence is
rendered. The engine stays a scorer; the tool layer stays the narrator.

### 4b. `plan_project`

`src/lib/ai/projectTools.ts` — the pure decision half, mirroring
`schedulerTools.ts`:

```ts
export function buildProjectSpec(project, tasks, profile, ctx): ProjectPlanSpec | { error: ... }
```

It maps each not-`done` task with remaining work to one `PlacementRequest`:
`ref: { kind: 'task', id: task.id }`, `title`, `totalMinutes` from
`estimated_hours`, `deadline` from `task.deadline ?? project.deadline`,
`dependsOn` from `task.depends_on`, `category` from `project.kind`
(`course → 'study'`, `build → 'work'`), and `energy: 'high'`. Session length is
left to the method — the engine's job, never the model's.

Then it reuses the **existing** `proposePlan` (`schedulerTools.ts:215`) so the
plan lands in `planStore` and is committed by the **existing** `apply_plan`
(`route.ts:826`) — with one addition: blocks stamped with `project_id` and
`ref: { kind: 'task', id }` when written, which is what makes invested-time and
next-step queries work later.

---

## 5. AI tool surface

Four new tools in `src/lib/ai/tools.ts`, appended to `calendarTools` so they
inherit the v1/v2 assembly untouched:

| Tool | Required | Optional |
|---|---|---|
| `create_project` | `title`, `kind` | `deadline`, `estimated_hours`, `description`, `color`, `seed_template` |
| `list_projects` | — | `status` |
| `update_project` | `project_id` | `title`, `status`, `deadline`, `estimated_hours`, `color` |
| `plan_project` | `project_id` | `horizon_days` |

`create_task` and `update_task` each gain an optional `project_id` property, and
`update_task` additionally gains `depends_on` — a one-line addition to the
existing whitelist at `route.ts:1243-1249`, which today silently drops anything
it does not know.

`plan_project` is the only one that is flag-gated to the engine: it joins
`V2_ONLY_TOOLS` behaviourally by requiring **both** `projectsEnabled()` and
`schedulerV2Enabled()`, because it returns a proposal that only `apply_plan` can
commit. The other three work under `PROJECTS_V1` alone.

**Dispatcher** — four new `case` arms in the `switch` at `route.ts:502`,
alongside `create_task` at `:1222`. Each sets `state.projectsUpdated = true`
where it mutates.

**Client refetch** — a **new SSE frame `projects_updated`**, not a reuse of
`tasks_updated`. They are genuinely different refetches (`/api/projects` carries
computed health; `/api/tasks` does not), and overloading one frame means every
task edit pays for a capacity probe. Emitted alongside the existing frames at
`route.ts:401-411`, consumed by a new branch in `useChatEngine.ts:386-431`.

**Prompt** — the new guidance goes in the **dynamic suffix only**, never the
static prefix. `systemPrompt.ts` builds a prompt-cached `staticPrefix`, and
`chat/route.ts:233-239` already carries an explicit comment that the cached
prefix must stay byte-identical whether a flag is on or off. `PROJECTS_GUIDANCE`
is defined next to `SCHEDULER_V2_GUIDANCE` at `route.ts:98-108` and concatenated
the same way. A `projectSummary` block joins `taskSummary`
(`systemPrompt.ts:155-177`) in the dynamic suffix: one line per active project —
title, deadline, remaining hours, risk — capped at 8.

---

## 6. UI

New components under `src/components/projects/`:

| File | Role |
|---|---|
| `ProjectsPanel.tsx` | The 340px / mobile-tab list. Cards, sorted by risk then deadline. |
| `ProjectCard.tsx` | One card — the four signals. Reused in the panel and the board header. |
| `ProjectBoard.tsx` | The full overlay: columns, task cards, drag between columns. |
| `ProjectBoardCard.tsx` | One task on the board. |
| `NewProjectSheet.tsx` | Create flow: kind → title → deadline → template seed. |

Conventions to follow, not invent: inline `style={{}}` reading the CSS custom
properties from `globals.css:4-43` (there are **zero** Tailwind utility classes
in this app despite Tailwind being installed), JS `onMouseEnter/onMouseLeave`
for hover, a bilingual `T = { en, he }` dict as in `TasksPanel.tsx:39-64`,
`motion/react` for transitions, and `as React.CSSProperties` wherever `env()`
appears. `SettingsClient.tsx:377-498` (the `METHOD_GROUPS` cards, with
`${color}18` tints and `inset 3px 0 0 ${color}`) is the closest in-repo
precedent for the card treatment and should be matched.

### The card

Four signals, one card, in a fixed vertical order so the eye learns it:

```
🗂️  אלגברה לינארית                      [🔴 חסרות 6 שע׳]
    ████████████░░░░░░░░  62%   ·   14 מתוך 22 שע׳
    הבא: לפתור תרגיל 7  ·  מחר 10:00
```

The risk pill is the only coloured element, so a healthy board is calm and a red
one is unmissable. `tight` is amber with *"צפוף"*, `unknown` renders no pill at
all rather than a grey one — an absent deadline is not a warning.

### The board

Columns come from `boardColumnsFor(method)` in `src/lib/projects/board.ts` — a
pure function. **v1 ships one column set** (`ללא זמן משובץ · לעשות · בתהליך ·
הושלם`), but behind that seam, because the app already has 18 methods and its
own *"פרויקטים ויעדים"* method group containing `kanban`, `scrum`, `okr`, `gtd`
and `twelve_week_year` (`SettingsClient.tsx:39-43`). Making the board's shape
follow the user's chosen method is the obvious next move and this keeps it from
being a rewrite.

**`ללא זמן משובץ` is the first column on purpose.** It holds tasks with no future
calendar block, and its header carries a single button — *"תכנן את אלה"* — which
sends `plan_project` through the chat engine. That column is the difference
between this and a Trello clone.

**375px legibility.** The board is horizontally scrollable with
`scroll-snap-type: x mandatory` and columns at `min(78vw, 300px)`, so exactly one
column sits on screen with the next one peeking. Column headers stick. This is
the same swipe idiom `CalendarPanel` already uses for week navigation, so it
needs no explanation.

### Shell integration — `AppShell.tsx`

- `mobileTab` widens: `useState<'calendar' | 'tasks' | 'projects'>` at `:31`.
- A third `MobileTab` (`:344-357`) using the existing local helper at `:443-476`,
  icon `FolderKanban` from Lucide, badge = count of `over`-risk projects.
- A `projectsPanel` variable joins `calendarPanel` / `tasksPanel` at `:232-253`,
  and a third `display:'block'/'none'` branch joins `:322-331` — **keeping the
  mount-always pattern**, which is what preserves FullCalendar's scroll state.
- Desktop: a small segmented Tasks/Projects control at the top of the 340px
  column (`:311-317`), switching which panel renders inside it. No layout change.
- The board overlay renders as a sibling of `ChatOverlay` inside the existing
  `AnimatePresence` (`:386-404`), covering the calendar area only on desktop and
  full-screen on mobile.
- Projects state and its fetch join the existing single poller at `:96-114`,
  under the same `pollAllowed()` guard — **not** a second timer. The comment at
  `:92-95` explains why there is exactly one.

**The two hard-coded `340`s.** `AppShell.tsx:312` (panel width) and
`VoiceFAB.tsx:247` (`calc(340px + 20px)`) are a duplicated literal. This plan
touches both files anyway, so extract `SIDE_PANEL_WIDTH = 340` into
`src/components/layout.ts` and import it in both. Small, and it stops the FAB
from drifting the next time the panel resizes.

**`VoiceFAB` hide rule.** Today it hides when `mobileTab === 'tasks'`
(`AppShell.tsx:364`). It must also hide on `'projects'` and while the board
overlay is open — otherwise the mic sits on top of the board's action button.

---

## 7. Feature flag + rollout

`src/lib/ai/featureFlags.ts` gains a second reader beside `schedulerV2Enabled()`,
same shape and same rule — read through the function, never `process.env`
directly:

```ts
export function projectsEnabled(): boolean {
  const raw = process.env.PROJECTS_V1
  return raw === '1' || raw === 'true'
}
```

**Inert when off:** no third tab, no desktop toggle, no projects tools in the
model's list, no `projects_updated` frame, no prompt text, and `/api/projects`
returns `404`. The types, the store methods and the engine's `dependsOn` support
all ship live — they are additive and unreachable. `orderRequestsWithDependencies`
with no `dependsOn` present is byte-identical to `orderRequests`, so the engine's
behaviour with the flag off is unchanged by construction, and that is asserted.

Five phases. **Every one ends with `npx tsc --noEmit` and `npm test` green and is
independently shippable**, because every turn auto-commits and deploys to
production with no staging.

| # | Lands | Proves |
|---|---|---|
| **1** | `Project` type, `Task.depends_on`/`order`, `userStore` methods, `/api/projects` routes, `projectsEnabled()` | Data layer round-trips; nothing user-visible |
| **2** | `dependsOn` in `plan.ts` (`orderRequestsWithDependencies`, `withDependencyEarliest`) | Dependencies order correctly; no-`dependsOn` output is identical to today |
| **3** | `health.ts` + `capacity.ts`; `GET /api/projects` returns health | The four signals are correct against a fixture week |
| **4** | UI — panel, card, board, third tab, desktop toggle, overlay | Alon can create and run a project by hand |
| **5** | AI tools, dispatcher arms, `projects_updated` frame, prompt guidance | "תכנן לי את הפרויקט" works end to end |

Phases 1–3 are invisible with the flag off, so they can land ahead of any UI.

---

## 8. Tests

Vitest 4.1.10, `src/**/*.test.ts`. Baseline verified green while writing this
plan: **373 passing in 17 files** (CLAUDE.md says 368 — stale, worth correcting
in the same pass). Following the house style:
a doc-comment at the top of each file saying *what regression it exists for*,
module-level frozen fixtures (never `new Date()`), `xOf(over: Partial<T> = {})`
builders, adversarial sentence-shaped test names, Hebrew asserted directly.

| File | Proves | ~n |
|---|---|---|
| `src/lib/scheduling/plan.dependencies.test.ts` | Topological order; a dependent never starts before its predecessor ends; **a request set with no `dependsOn` produces the identical order to `orderRequests`**; a cycle is broken deterministically and reported, not thrown; a predecessor that fails to place does not strand its dependent | ~12 |
| `src/lib/projects/health.test.ts` | Progress by hours not task count; invested counts only past blocks; next step skips blocked tasks; risk thresholds at the boundary; `unknown` when there is no deadline | ~14 |
| `src/lib/projects/capacity.test.ts` | The probe agrees with a real `planSchedule` run; `partial` yields a floor, never an over-estimate; horizon clamps at `MAX_HORIZON_DAYS` | ~6 |
| `src/lib/projects/templates.test.ts` | Every `ProjectKind` has a template; seeded tasks carry `project_id` | ~4 |
| `src/lib/ai/projectTools.test.ts` | `buildProjectSpec` skips `done` tasks; inherits the project deadline; rejects a cycle by naming both tasks; never invents a session length | ~10 |
| `src/lib/ai/tools.test.ts` *(extend)* | The new tools appear only under the flag; no duplicate names; the v1 array is not mutated | +4 |

**Extend `src/lib/scheduling/__fixtures__/student-week.ts`** with an exported
`STUDENT_WEEK_PROJECT` — a linear-algebra course with five dependent tasks and
an exam eleven days out, reusing the existing `STUDENT_WEEK_BUSY`. Then add a
project section to `__fixtures__/preview.test.ts`, the deliberate
non-assertion Hebrew printout, so the board's numbers get the same human
acceptance gate the schedule already has:

```bash
npx vitest run preview --reporter=verbose --disable-console-intercept
```

> Note: `--reporter=basic` (still referenced in one place in the repo docs) was
> removed in Vitest 3 and now crashes with `ERR_LOAD_URL`. Use `verbose`.

---

## 9. Risks, and what v1 deliberately does not build

**Risks**

- **Probe cost.** Health for N projects is N engine passes. Mitigated by computing
  server-side on the list route against one shared context, never per render and
  never inside the 30s poll. If it ever bites, the fix is a short-TTL memo keyed
  by `(projectId, events hash)` — not a second capacity formula.
- **Estimates are the weak input.** Every number on the card descends from
  `estimated_hours`. A project with no estimates degrades to task-count progress
  and `risk: 'unknown'` — which is honest, and the UI must say *"אין הערכת שעות"*
  rather than render a confident-looking bar over nothing.
- **`planStore` is in-process with a 10-minute TTL.** A redeploy between a project
  proposal and approval loses it. A project plan is bigger than a single-item one,
  so re-asking costs more. Accepted for v1; `apply_plan` already fails closed with
  `plan_expired` rather than writing something stale.
- **Touching `plan.ts` touches the engine.** Mitigated by the identity test: with
  no `dependsOn`, ordering output must be byte-identical to `orderRequests`.

**Explicitly out of scope for v1**

- Auto-maintaining projects (re-planning when you fall behind) — the owner chose
  approval-based, and unattended rewrites of a live calendar are the highest-risk
  thing this app could do.
- Per-method board layouts beyond the default column set — the seam is in,
  the implementations are not.
- Gantt / timeline / dependency graph visualisation.
- Sub-projects, milestones, multi-level nesting. `depends_on` covers ordering;
  hierarchy can wait until there is evidence it is needed.
- Time tracking beyond "a block existed and has passed". No start/stop timer.
- Templates as a user-editable library — they stay a code table until the shape
  settles.

---

## Verification

```bash
npx tsc --noEmit && npm test && npm run lint
```

(`npm run lint` has 4 pre-existing errors in untouched components — the count
must not grow.)

Then the human gate, which is how this repo checks that the engine's output is
actually sensible rather than merely self-consistent:

```bash
npx vitest run preview --reporter=verbose --disable-console-intercept
```

End to end, with `PROJECTS_V1=1 SCHEDULER_V2=1 npm run dev`:

1. Create a `course` project with a deadline ~2 weeks out and seed the template.
2. Confirm the card shows four signals and that `risk` is `unknown` until
   estimates exist, then turns `ok`/`tight`/`over` as hours are added.
3. Add a `depends_on` link between two tasks.
4. In chat: *"תכנן לי את הפרויקט"* → a single proposal covering every task, with
   Hebrew reasons drawn from `explain.ts` (**never invented by the model**), and
   the dependent task placed after its predecessor.
5. Approve → blocks appear on the calendar carrying `project_id`; the card's
   *next step* and *invested* update; the *ללא זמן משובץ* column empties.
6. Decline → nothing is written.
7. Delete the project → tasks and events survive with `project_id` cleared.
8. Unset `PROJECTS_V1`, reload: the third tab, the desktop toggle and the tools
   are all gone, and `/api/projects` returns 404.
