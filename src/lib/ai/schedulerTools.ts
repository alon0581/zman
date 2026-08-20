/**
 * schedulerTools.ts — the decision half of the SCHEDULER_V2 tools.
 *
 * The split here is deliberate: everything in this file decides *what* should
 * happen and returns plain data, while the chat route keeps the parts that
 * touch storage (userStore). That is what makes the interesting
 * behaviour — which request the model's arguments become, which instances of a
 * recurring series clash, what the assistant is told when nothing fits —
 * testable without booting Next.js or mocking a database.
 *
 * Nothing here is reachable unless SCHEDULER_V2 is on; the route guards every
 * call site on `sched.enabled`.
 */

import { AIMemory, CalendarEvent, FeedbackSignal, Place, UserProfile } from '@/types'
import { LocalISO, addMinutes, minutesBetween } from '@/lib/scheduling/clock'
import {
  buildSchedulingContext, buildSchedulingProfile, horizonDaysFor, normalizeToLocalISO,
  PlanToolResult, planOutcomeToToolResult, resolveNow, toEngineBusy,
} from '@/lib/scheduling/adapter'
import { planSchedule } from '@/lib/scheduling/plan'
import { blockersFor } from '@/lib/scheduling/timeline'
import { Category, Energy, Mobility, PlacementRequest } from '@/lib/scheduling/types'
import { classifyMobility } from '@/lib/scheduling/mobilityClassifier'
import { StoredPlanBlock, savePlan } from './planStore'

/** What the engine-backed tools need beyond what the v1 dispatcher already carried. */
export interface SchedulerCtx {
  /** False ⇒ every call site in the route takes the pre-existing v1 branch. */
  enabled: boolean
  memory: AIMemory[]
  feedback: FeedbackSignal[]
  timezone?: string
  isHe: boolean
  /**
   * Phases the user has closed. Feedback stamped with one of them stops steering
   * the plan — last semester's evidence is about a calendar that no longer exists.
   * Undefined when PHASES is off, which keeps every signal, as before.
   */
  closedPhaseIds?: string[]
  /**
   * The user's declared places. Undefined when PLACES is off, and then no event
   * carries a travel window and every path here behaves exactly as before.
   */
  places?: Place[]
}

// ── Method-aware shaping ────────────────────────────────────────────────────
//
// Titles are shaped here. Session LENGTH deliberately is not.
//
// There used to be a `METHOD_SESSION_HOURS` table here that set `sessionMinutes`
// on every PlacementRequest, which OVERRODE `METHOD_RULES[m].sessionMinutes` in
// the engine. The two disagreed on ten of eighteen methods and nine of those
// disagreements survived `clampBlock`, so the user got a block their method never
// promised: `the_one_thing` 180 instead of 120, and `time_blocking` — the default
// everyone lands on — 90 instead of 60. methodRules.ts states the contract in its
// own header: "The UI is the promise; this file is the thing that has to keep it."
//
// It was deleted rather than synced, because a second table can drift again and a
// deleted one cannot. Omitting `sessionMinutes` is already the documented way to
// say "the method decides", and it is what plan_project has always done.
// Do not reintroduce a session-length table here.

/** Method-aware title format (all 18 methods). */
export const METHOD_TITLE: Record<string, (t: string, i: number) => string> = {
  pomodoro:     (t, i) => `${t} — פומודורו ${i + 1}`,
  deep_work:    (t, i) => `${t} — Deep Work ${i + 1}`,
  eisenhower:   (t, i) => `${t} — Session ${i + 1}`,
  gtd:          (t, i) => `${t} — Action ${i + 1}`,
  time_blocking:(t, i) => `${t} — Block ${i + 1}`,
  ivy_lee:      (t, i) => `#${i + 1} ${t}`,
  eat_the_frog: (t, i) => i === 0 ? `🐸 ${t}` : `${t} — Session ${i + 1}`,
  theme_days:   (t, i) => `${t} — Session ${i + 1}`,
  the_one_thing:(t, i) => i === 0 ? `🎯 ${t}` : `${t} — Session ${i + 1}`,
  weekly_review:(t) => `🔄 ${t}`,
  okr:          (t, i) => `${t} — OKR ${i + 1}`,
  kanban:       (t, i) => `${t} — ${i + 1}`,
  time_boxing:  (t, i) => `${t} (timebox ${i + 1})`,
  moscow:       (t, i) => `${t} — Session ${i + 1}`,
  rule_5217:    (t, i) => `${t} — 52/17 #${i + 1}`,
  scrum:        (t, i) => `${t} — Sprint Task ${i + 1}`,
  energy_management: (t, i) => `${t} — Session ${i + 1}`,
  twelve_week_year:  (t, i) => `${t} — W${i + 1}`,
}

export function methodTitleFormatter(method: string | undefined): (t: string, i: number) => string {
  return (method && METHOD_TITLE[method]) || ((t: string, i: number) => `${t} — Session ${i + 1}`)
}

const FIXED_METHODS = new Set(['deep_work', 'the_one_thing'])
const ASK_FIRST_METHODS = new Set(['eat_the_frog', 'theme_days', 'weekly_review', 'scrum', 'moscow'])

/** Method-aware mobility default for AI-created blocks. */
export function methodMobility(method: string | undefined): Mobility {
  if (method && FIXED_METHODS.has(method)) return 'fixed'
  if (method && ASK_FIRST_METHODS.has(method)) return 'ask_first'
  return 'flexible'
}

// ── Argument validation ─────────────────────────────────────────────────────

export function isMobility(v: unknown): v is Mobility {
  return v === 'fixed' || v === 'flexible' || v === 'ask_first'
}

export function isCategory(v: unknown): v is Category {
  return v === 'study' || v === 'work' || v === 'fitness' || v === 'personal' || v === 'social' || v === 'admin'
}

export function isEnergy(v: unknown): v is Energy {
  return v === 'high' || v === 'medium' || v === 'low'
}

/** The colour convention from tools.ts / systemPrompt.ts, keyed by engine category. */
export function colorForCategory(category: unknown): string {
  switch (category) {
    case 'study': return '#6366F1'
    case 'fitness': return '#34D399'
    case 'personal': return '#FBBF24'
    case 'social': return '#F97316'
    case 'admin': return '#FBBF24'
    default: return '#3B7EF7'
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export interface PlanSpec {
  requests: PlacementRequest[]
  color: string
  mobility: Mobility
  titleFor: (title: string, index: number) => string
  deadline?: LocalISO
  /** Set by plan_project: stamped onto every block so the events link back. */
  projectId?: string
}

/** `schedule_item`'s arguments → an engine request. Returns null when unusable. */
export function buildScheduleItemSpec(
  input: Record<string, unknown>,
  profile: UserProfile | null | undefined,
  sched: SchedulerCtx,
): PlanSpec | null {
  const title = str(input.title).trim()
  if (!title) return null

  const method = profile?.scheduling_method as string | undefined
  const mobility = isMobility(input.mobility_type) ? input.mobility_type : methodMobility(method)
  const deadline = normalizeToLocalISO(str(input.deadline), sched.timezone) ?? undefined
  const earliest = normalizeToLocalISO(str(input.earliest), sched.timezone) ?? undefined

  return {
    requests: [{
      ref: { kind: 'task' },
      title,
      ...(isCategory(input.category) ? { category: input.category } : {}),
      ...(isEnergy(input.energy) ? { energy: input.energy } : {}),
      ...(num(input.total_minutes) > 0 ? { totalMinutes: Math.round(num(input.total_minutes)) } : {}),
      ...(num(input.session_minutes) > 0 ? { sessionMinutes: Math.round(num(input.session_minutes)) } : {}),
      ...(num(input.session_count) > 0 ? { sessionCount: Math.round(num(input.session_count)) } : {}),
      ...(deadline ? { deadline } : {}),
      ...(earliest ? { earliest } : {}),
      mobility,
    }],
    color: str(input.color) || colorForCategory(input.category),
    mobility,
    titleFor: methodTitleFormatter(method),
    deadline,
  }
}

/**
 * `break_down_task`'s arguments → an engine request.
 *
 * Session length still comes from the user's method — that is a promise the UI
 * already made them — but where the sessions land becomes the engine's answer.
 */
export function buildBreakdownSpec(
  input: Record<string, unknown>,
  profile: UserProfile | null | undefined,
  sched: SchedulerCtx,
): PlanSpec | null {
  const title = str(input.task_title).trim()
  const totalHours = num(input.total_hours)
  if (!title || totalHours <= 0) return null

  const method = profile?.scheduling_method as string | undefined
  // Only an explicit request survives. With none, `sessionMinutes` is omitted and
  // METHOD_RULES decides — one table for one number. See the note at the top.
  const sessionHours = num(input.session_length_hours) > 0
    ? num(input.session_length_hours)
    : undefined
  const mobility = methodMobility(method)
  const deadline = normalizeToLocalISO(str(input.deadline), sched.timezone) ?? undefined

  return {
    requests: [{
      ref: { kind: 'task' },
      title,
      category: 'study',
      energy: 'high',
      totalMinutes: Math.max(15, Math.round(totalHours * 60)),
      ...(sessionHours ? { sessionMinutes: Math.round(sessionHours * 60) } : {}),
      ...(deadline ? { deadline } : {}),
      mobility,
    }],
    color: str(input.color) || '#6366F1',
    mobility,
    titleFor: methodTitleFormatter(method),
    deadline,
  }
}

// ── Running the engine ──────────────────────────────────────────────────────

export interface ProposalResult {
  /** What the model is handed. Includes plan_id when there is something to apply. */
  toolResult: Record<string, unknown>
  /** The blocks that were stored, for the caller that wants to inspect them. */
  stored: StoredPlanBlock[]
}

/**
 * Runs the engine and stores the result under a plan id. Writes nothing.
 *
 * Storing rather than recomputing at apply time is the whole point of the
 * two-phase design: `now` moves between the proposal and the confirmation, and a
 * plan that quietly re-derives itself would hand the user times they never saw.
 */
export function proposePlan(
  userId: string,
  events: CalendarEvent[],
  profile: UserProfile | null | undefined,
  sched: SchedulerCtx,
  now: Date | LocalISO,
  spec: PlanSpec,
): ProposalResult {
  const nowLocal = resolveNow(now, sched.timezone || profile?.timezone)
  const horizonDays = horizonDaysFor(nowLocal, spec.deadline)

  let ctx
  try {
    ctx = buildSchedulingContext(profile, events, sched.memory, sched.feedback, sched.timezone, now, horizonDays, sched.closedPhaseIds, sched.places)
  } catch (err) {
    return {
      toolResult: { error: 'context_failed', message: `Could not read the calendar for planning: ${(err as Error)?.message}` },
      stored: [],
    }
  }

  let view: PlanToolResult
  try {
    view = planOutcomeToToolResult(planSchedule(ctx, spec.requests), sched.isHe, spec.requests)
  } catch (err) {
    console.error('[schedulerTools] planSchedule failed:', err)
    return {
      toolResult: { error: 'planning_failed', message: `The scheduling engine failed: ${(err as Error)?.message}. Do NOT invent times.` },
      stored: [],
    }
  }

  if (view.blocks.length === 0) {
    // "Blocked" is a real answer, not an error — but there is nothing to store,
    // and the model must be told in so many words not to fill the gap itself.
    return {
      toolResult: {
        ...view,
        next_step: sched.isHe
          ? 'אל תקבע כלום ואל תמציא שעות. הסבר למה זה לא נכנס והצע את האפשרויות מ-suggestions.'
          : 'Do not schedule anything and do not invent times. Explain why it did not fit and offer the options from `suggestions`.',
      },
      stored: [],
    }
  }

  // Session numbering is per REQUEST, not global. With one request the two are the
  // same, but for a project batch a global counter would render block 3 of task A
  // and block 1 of task B as "sessions 4 and 5" of one thing. Each task gets its
  // own 1, 2, 3.
  const seenPerRequest = new Map<number, number>()
  const ordinals = view.blocks.map(b => {
    const n = seenPerRequest.get(b.request_index) ?? 0
    seenPerRequest.set(b.request_index, n + 1)
    return n
  })
  const countPerRequest = new Map<number, number>()
  for (const b of view.blocks) {
    countPerRequest.set(b.request_index, (countPerRequest.get(b.request_index) ?? 0) + 1)
  }

  // A single block keeps the user's own words; a split gets the method's numbering.
  const stored: StoredPlanBlock[] = view.blocks.map((b, i) => {
    const multi = (countPerRequest.get(b.request_index) ?? 1) > 1
    const taskId = spec.requests[b.request_index]?.ref?.id
    const refKind = spec.requests[b.request_index]?.ref?.kind
    return {
      title: multi ? spec.titleFor(b.title, ordinals[i]) : b.title,
      start: b.start,
      end: b.end,
      color: spec.color,
      mobility: spec.mobility,
      why: b.why,
      ...(spec.projectId ? { project_id: spec.projectId } : {}),
      // PlacementRequest.ref.id is optional while CalendarEvent.ref.id is required,
      // so this needs a guard rather than a spread.
      ...(taskId && refKind ? { ref: { kind: refKind, id: taskId } } : {}),
    }
  })

  const plan = savePlan(userId, stored, view)
  return {
    toolResult: {
      ...view,
      plan_id: plan.planId,
      blocks: view.blocks.map((b, i) => ({ ...b, title: stored[i].title })),
      next_step: sched.isHe
        ? 'זו הצעה בלבד — כלום לא נשמר. הצג אותה למשתמש עם הנימוקים, ורק אחרי שהוא מאשר קרא ל-apply_plan עם plan_id הזה.'
        : 'This is a proposal — nothing was saved. Show it with the reasons, and only after the user agrees call apply_plan with this plan_id.',
    },
    stored,
  }
}

// ── move_event ──────────────────────────────────────────────────────────────

export type MoveDecision =
  | { ok: true; start: LocalISO; end: LocalISO; why: string[]; view: PlanToolResult }
  | { ok: false; toolResult: Record<string, unknown> }

/**
 * Where should this event go instead?
 *
 * The event being moved is taken out of the busy set first — otherwise it blocks
 * itself and the engine correctly reports that there is nowhere to put it.
 */
export function planMove(
  eventId: string,
  events: CalendarEvent[],
  profile: UserProfile | null | undefined,
  sched: SchedulerCtx,
  now: Date | LocalISO,
): MoveDecision {
  const existing = events.find(e => e.id === eventId)
  if (!existing) return { ok: false, toolResult: { error: 'not_found', message: 'Event not found' } }
  if (existing.mobility_type === 'fixed') {
    return { ok: false, toolResult: { error: 'fixed_event', message: `"${existing.title}" is marked as Fixed (🔒) and cannot be moved.` } }
  }

  const start = normalizeToLocalISO(existing.start_time, sched.timezone)
  const end = normalizeToLocalISO(existing.end_time, sched.timezone)
  if (!start || !end) {
    return { ok: false, toolResult: { error: 'invalid_date', message: 'This event has unreadable times and cannot be replanned.' } }
  }

  const durationMinutes = Math.max(15, minutesBetween(start, end))
  const others = events.filter(e => e.id !== eventId)

  let view: PlanToolResult
  try {
    const ctx = buildSchedulingContext(profile, others, sched.memory, sched.feedback, sched.timezone, now, undefined, sched.closedPhaseIds, sched.places)
    view = planOutcomeToToolResult(planSchedule({
      ...ctx,
      // A move is a relocation, not a re-plan. The method's block bounds shape
      // work the engine is inventing; this event already has a length the user
      // agreed to, and clamping it would turn "move my hour-long meeting" into a
      // 25-minute one under Pomodoro — a silent, destructive edit nobody asked
      // for. The bounds are widened just enough to admit the real duration.
      rules: {
        ...ctx.rules,
        sessionMinutes: durationMinutes,
        minBlock: Math.min(ctx.rules.minBlock, durationMinutes),
        maxBlock: Math.max(ctx.rules.maxBlock, durationMinutes),
        dailyCapMinutes: Math.max(ctx.rules.dailyCapMinutes, durationMinutes),
      },
    }, [{
      ref: { kind: 'event', id: eventId },
      title: existing.title,
      totalMinutes: durationMinutes,
      sessionMinutes: durationMinutes,
      sessionCount: 1,
      mobility: existing.mobility_type ?? 'flexible',
    }]), sched.isHe)
  } catch (err) {
    console.error('[schedulerTools] move planning failed:', err)
    return { ok: false, toolResult: { error: 'planning_failed', message: `Could not replan this event: ${(err as Error)?.message}. Do NOT invent a time.` } }
  }

  const block = view.blocks[0]
  if (!block) {
    return {
      ok: false,
      toolResult: { ...view, error: 'no_slot', message: 'No slot was found for this event. Report why, and do not move it.' },
    }
  }
  return { ok: true, start: block.start, end: block.end, why: block.why, view }
}

// ── Recurring create_event ──────────────────────────────────────────────────

export interface RecurringInstance {
  start: LocalISO
  end: LocalISO
  mobility: Mobility
}

export interface RecurringConflict {
  date: string
  time: string
  blocked_by: { title: string; mobility: Mobility }[]
}

export interface RecurringPlan {
  instances: RecurringInstance[]
  conflicts: RecurringConflict[]
  duplicates: LocalISO[]
  error?: { error: string; message: string }
}

/**
 * Which instances of a recurring series can actually be created.
 *
 * The user's chosen time is respected — they said "every Tuesday at 14:00", and
 * the engine's job here is verification, not relocation. What changes versus the
 * v1 path is that all-day and multi-day events now block (timeline.ts reads
 * `is_all_day`, which the naive overlap test ignored), the profile's buffer is
 * honoured, and each rejected instance comes back named instead of being tallied
 * into an anonymous `skipped` count the assistant then reports as success.
 */
export function planRecurring(
  input: Record<string, unknown>,
  knownEvents: CalendarEvent[],
  profile: UserProfile | null | undefined,
  sched: SchedulerCtx,
  recurrence: { frequency?: string; count?: number; end_date?: string },
): RecurringPlan {
  const empty = { instances: [], conflicts: [], duplicates: [] }
  const title = str(input.title)
  const baseStart = normalizeToLocalISO(str(input.start_time), sched.timezone)
  const baseEnd = normalizeToLocalISO(str(input.end_time), sched.timezone)
  if (!baseStart || !baseEnd) {
    return { ...empty, error: { error: 'invalid_date', message: 'start_time or end_time is not a valid date' } }
  }

  const durationMinutes = minutesBetween(baseStart, baseEnd)
  if (!(durationMinutes > 0)) {
    return { ...empty, error: { error: 'invalid_range', message: 'end_time must be after start_time' } }
  }

  const freq = recurrence.frequency
  const daysStep = freq === 'monthly' ? 30 : freq === 'biweekly' ? 14 : 7
  const maxCount = Math.max(1, Math.min(52, recurrence.count ?? (freq === 'monthly' ? 6 : 12)))
  const endDay = recurrence.end_date
    ? normalizeToLocalISO(recurrence.end_date, sched.timezone)?.slice(0, 10)
    : undefined

  const bufferMinutes = buildSchedulingProfile(profile, sched.timezone).bufferMinutes
  const mobility = isMobility(input.mobility_type) ? input.mobility_type : classifyMobility(title, 'ai', true)
  const titleLower = title.toLowerCase().trim()
  // Instances placed so far block later ones too: a monthly series that slides
  // can otherwise be scheduled on top of its own earlier instance.
  // Places are passed here for the same reason `blockersFor` now reads travel at
  // all: without them this check calls a slot free that `planSchedule` would
  // refuse, and a weekly series gets pinned to the exact half hour the user
  // spends driving. It used to ignore method breaks the same way.
  const liveBusy = [...toEngineBusy(knownEvents, sched.timezone, sched.places).busy]

  const instances: RecurringInstance[] = []
  const conflicts: RecurringConflict[] = []
  const duplicates: LocalISO[] = []

  for (let i = 0; i < maxCount; i++) {
    const start = addMinutes(baseStart, i * daysStep * 24 * 60)
    const end = addMinutes(start, durationMinutes)
    if (endDay && start.slice(0, 10) > endDay) break

    const isDuplicate = knownEvents.some(e =>
      e.title.toLowerCase().trim() === titleLower &&
      normalizeToLocalISO(e.start_time, sched.timezone) === start
    )
    if (isDuplicate) { duplicates.push(start); continue }

    const blockers = blockersFor({ start, end }, liveBusy, bufferMinutes)
    if (blockers.length > 0) {
      conflicts.push({
        date: start.slice(0, 10),
        time: `${start.slice(11, 16)}–${end.slice(11, 16)}`,
        blocked_by: blockers.map(b => ({ title: b.title, mobility: b.mobility })),
      })
      continue
    }

    instances.push({ start, end, mobility })
    liveBusy.push({
      id: `pending:${start}`,
      title,
      start,
      end,
      mobility,
      createdBy: 'ai',
      isAllDay: false,
    })
  }

  return { instances, conflicts, duplicates }
}

/** The tool result for a recurring create, once the caller has written what it could. */
export function recurringToolResult(
  seriesId: string,
  createdCount: number,
  plan: RecurringPlan,
  writeErrors: string[],
): Record<string, unknown> {
  return {
    success: writeErrors.length === 0,
    series_id: seriesId,
    instances_created: createdCount,
    duplicates_skipped: plan.duplicates.length,
    ...(plan.conflicts.length > 0 ? {
      conflicts: plan.conflicts,
      message: `${plan.conflicts.length} instance(s) were NOT created because something already occupies that time. Tell the user exactly which dates were skipped and what blocked them — do not claim the full series was created.`,
    } : {}),
    ...(writeErrors.length > 0 ? {
      error: 'write_failed',
      failed: writeErrors,
      message: `${writeErrors.length} instance(s) failed to save — do NOT claim those were created.`,
    } : {}),
  }
}
