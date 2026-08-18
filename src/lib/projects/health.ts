/**
 * health.ts — the four signals on a project card.
 *
 * Pure, under the engine's own contract: no fs, no fetch, no `new Date()`, `now`
 * injected. Same input, same output, byte for byte — which is what lets a fixture
 * test assert an exact sentence.
 *
 * The invariant that governs every branch below: MISSING DATA MAY ONLY EVER MAKE
 * A STATE WORSE, NEVER BETTER. There is no path from absent data to 'ok'. The
 * corollary matters just as much — `na` (there is nothing to know) and `unknown`
 * (there IS something to know and we don't) are different states, because
 * conflating them makes a card look broken when it is merely finite.
 */

import { CalendarEvent, Project, Task } from '@/types'
import { LocalISO } from '@/lib/scheduling/clock'
import { normalizeToLocalISO } from '@/lib/scheduling/adapter'
import { SchedulingMethod } from '@/lib/scheduling/methodMapper'
import { getMethodRules } from '@/lib/scheduling/methodRules'
import { boardRulesFor } from './boardRules'
import { KIND_RULES, ResolvedSignal, SignalState, worseOf } from './types'
import { ProjectProbeResult } from './capacity'

export interface ProjectFacts {
  /** Open leaf tasks only, so a parent and its children are not counted twice. */
  openLeafTasks: Task[]
  doneLeafCount: number
  totalLeafCount: number
  /** Net of work already on the calendar. Zero when nothing is estimated. */
  remainingMinutes: number
  investedMinutes: number
  investedSessions: number
  /** Open leaf tasks carrying no estimate at all. */
  unestimatedCount: number
}

// ── Facts ───────────────────────────────────────────────────────────────────

/** A task nobody else claims as a parent. Counting a parent and its children double-counts. */
function leavesOf(tasks: Task[]): Task[] {
  const parentIds = new Set(tasks.map(t => t.parent_task_id).filter(Boolean))
  return tasks.filter(t => !parentIds.has(t.id))
}

function eventMinutes(ev: CalendarEvent): number {
  const start = normalizeToLocalISO(ev.start_time)
  const end = normalizeToLocalISO(ev.end_time)
  if (!start || !end) return 0
  const ms = Date.parse(`${end}Z`) - Date.parse(`${start}Z`)
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 60000)) : 0
}

/**
 * Everything the signals are computed from, in one pass.
 *
 * The subtraction in `remainingMinutes` is load-bearing. Without it, scheduling a
 * project makes its risk look WORSE — the work is still counted while the capacity
 * is now consumed by the project's own blocks. Double penalty, and the badge
 * becomes useless exactly when the feature starts working.
 */
export function computeFacts(
  project: Project,
  allTasks: Task[],
  allEvents: CalendarEvent[],
  now: LocalISO,
): ProjectFacts {
  const mine = allTasks.filter(t => t.project_id === project.id)
  const leaves = leavesOf(mine)
  const open = leaves.filter(t => t.status !== 'done')

  const projectEvents = allEvents.filter(e => e.project_id === project.id && !e.is_all_day)

  // Future minutes already booked per task, so remaining work is net of the plan.
  const futureByTask = new Map<string, number>()
  let investedMinutes = 0
  let investedSessions = 0
  for (const ev of projectEvents) {
    const end = normalizeToLocalISO(ev.end_time)
    if (!end) continue
    const mins = eventMinutes(ev)
    if (end <= now) {
      investedMinutes += mins
      investedSessions += 1
    } else if (ev.ref?.kind === 'task' && ev.ref.id) {
      futureByTask.set(ev.ref.id, (futureByTask.get(ev.ref.id) ?? 0) + mins)
    }
  }

  let remainingMinutes = 0
  let unestimatedCount = 0
  for (const t of open) {
    if (!t.estimated_hours || t.estimated_hours <= 0) { unestimatedCount++; continue }
    const estimated = Math.round(t.estimated_hours * 60)
    remainingMinutes += Math.max(0, estimated - (futureByTask.get(t.id) ?? 0))
  }

  return {
    openLeafTasks: open,
    doneLeafCount: leaves.length - open.length,
    totalLeafCount: leaves.length,
    remainingMinutes,
    investedMinutes,
    investedSessions,
    unestimatedCount,
  }
}

// ── Next step ───────────────────────────────────────────────────────────────

/** Ids of tasks this project considers finished, for dependency checks. */
function doneIds(allTasks: Task[]): Set<string> {
  return new Set(allTasks.filter(t => t.status === 'done').map(t => t.id))
}

const PRIORITY_RANK: Record<Task['priority'], number> = { high: 0, medium: 1, low: 2 }

/**
 * The single task to do next. Deterministic to a total order, the same discipline
 * `orderRequests` uses — a "next step" that reshuffles between renders is noise.
 */
export function pickNextStep(facts: ProjectFacts, allTasks: Task[]): Task | null {
  const finished = doneIds(allTasks)
  const ready = facts.openLeafTasks.filter(
    t => (t.depends_on ?? []).every(id => finished.has(id)),
  )
  // A blocked task is never the next step — but if EVERYTHING is blocked, saying
  // "nothing to do" would be worse than naming the thing that is waiting.
  const pool = ready.length > 0 ? ready : facts.openLeafTasks
  if (pool.length === 0) return null

  return [...pool].sort((a, b) => {
    if ((a.status === 'in_progress') !== (b.status === 'in_progress')) {
      return a.status === 'in_progress' ? -1 : 1
    }
    const da = a.deadline ?? '￿'
    const db = b.deadline ?? '￿'
    if (da !== db) return da < db ? -1 : 1
    const pa = PRIORITY_RANK[a.priority] ?? 1
    const pb = PRIORITY_RANK[b.priority] ?? 1
    if (pa !== pb) return pa - pb
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1
    return a.id < b.id ? -1 : 1
  })[0]
}

// ── Signals ─────────────────────────────────────────────────────────────────

const hours = (mins: number) => Math.round((mins / 60) * 10) / 10

/**
 * Turns a project into its four card signals, `na` ones already dropped.
 *
 * `probe` is injected rather than computed here so that the batched engine pass
 * stays a single call for all projects — see capacity.ts.
 */
export function resolveSignals(
  project: Project,
  allTasks: Task[],
  allEvents: CalendarEvent[],
  probe: ProjectProbeResult | undefined,
  method: SchedulingMethod | string | undefined,
  now: LocalISO,
): ResolvedSignal[] {
  const facts = computeFacts(project, allTasks, allEvents, now)
  const rules = boardRulesFor(method)

  const byName: Record<string, ResolvedSignal> = {
    deadline: deadlineSignal(project, facts, probe, rules.cycleDays),
    progress: progressSignal(facts, method),
    next: nextSignal(facts, allTasks, allEvents, now),
    invested: investedSignal(facts, rules.investedUnit, method),
  }

  return rules.signalOrder.map(s => byName[s]).filter(s => s.state !== 'na')
}

function deadlineSignal(
  project: Project,
  facts: ProjectFacts,
  probe: ProjectProbeResult | undefined,
  cycleDays: number | null,
): ResolvedSignal {
  const deadline = normalizeToLocalISO(project.deadline)

  // No date, and the method has no rhythm to borrow one from. There is nothing to
  // know, so the signal is dropped entirely — a grey "?" would imply we lost
  // something, and a green chip would be an outright fabrication.
  if (!deadline && !cycleDays) {
    return sig('deadline', 'na', '', '')
  }
  if (!deadline) {
    return sig('deadline', 'ok',
      `לפי מחזור של ${cycleDays} ימים`,
      `On a ${cycleDays}-day cycle`)
  }

  // Open tasks is empty two different ways, and only one of them is 'ok': a
  // project with zero tasks has nothing to be on track FOR, so it must not read
  // better than the progress card's own 'no_tasks' — an empty project is not a
  // finished one. Only a project that actually had tasks and finished them all
  // earns the green chip.
  if (facts.openLeafTasks.length === 0) {
    if (facts.totalLeafCount === 0) {
      return sig('deadline', 'unknown',
        'אי אפשר להעריך סיכון — אין עדיין משימות',
        'Cannot estimate risk — no tasks yet',
        'no_tasks')
    }
    return sig('deadline', 'ok', 'הכול סגור', 'All done')
  }
  if (facts.remainingMinutes <= 0) {
    // remainingMinutes also lands on 0 after a SUCCESSFUL plan_project ->
    // apply_plan, once every open task's estimate is fully covered by a future
    // calendar block. That is the opposite of "no estimates" — distinguish by
    // whether anything is actually unestimated before blaming missing data.
    if (facts.unestimatedCount > 0) {
      return sig('deadline', 'unknown',
        `אי אפשר להעריך סיכון — אין הערכת זמן ל-${facts.unestimatedCount} משימות`,
        `Cannot estimate risk — ${facts.unestimatedCount} tasks have no time estimate`,
        'no_estimates')
    }
    return sig('deadline', 'ok',
      'כל שעות העבודה שנותרו כבר משובצות ביומן',
      'All remaining work is already on the calendar')
  }
  if (!probe) {
    return sig('deadline', 'unknown', 'לא הצלחתי לחשב סיכון כרגע', 'Could not compute risk right now', 'plan_unavailable')
  }

  const needed = hours(facts.remainingMinutes)
  let state: SignalState
  let he: string
  let en: string

  if (probe.status === 'ok') {
    // The probe asked for 125% of the work. Landing all of it means there is real
    // room to slip; landing only the base means it works with nothing spare.
    // (Measuring how close the LAST block sits to the deadline does not work here:
    // the engine spreads sessions across the available days on purpose, so the
    // last block is near the deadline whether the plan is comfortable or not.)
    // The chip already says the state in one word, so the sentence carries the
    // information instead of repeating it — "On track / On track — 12h to go"
    // reads like nobody looked at the card.
    const comfortable = probe.placedMinutes >= probe.requestedMinutes
    if (comfortable) {
      state = 'ok'
      he = `${needed} שעות עבודה עד היעד`
      en = `${needed}h of work before the deadline`
    } else {
      state = 'warn'
      he = `${needed} שעות — נכנס בלי מרווח`
      en = `${needed}h — fits with no room to spare`
    }
  } else if (probe.status === 'partial') {
    state = 'risk'
    he = probe.reason ?? `חסרות ${Math.max(0, hours(facts.remainingMinutes - probe.placedMinutes))} שעות`
    en = probe.reason ?? `Short by ${Math.max(0, hours(facts.remainingMinutes - probe.placedMinutes))}h`
  } else {
    state = 'risk'
    he = probe.reason ?? `אין זמן פנוי לפני היעד — צריך ${needed} שעות`
    en = probe.reason ?? `No free time before the deadline — needs ${needed}h`
  }

  // Partial estimates cap the state: a confident green over half the data is the
  // exact lie this module exists to prevent.
  if (facts.unestimatedCount > 0) {
    state = worseOf(state, 'warn')
    const known = facts.openLeafTasks.length - facts.unestimatedCount
    he += ` (מבוסס על ${known} מתוך ${facts.openLeafTasks.length} משימות)`
    en += ` (based on ${known} of ${facts.openLeafTasks.length} tasks)`
  }

  return sig('deadline', state, he, en)
}

function progressSignal(facts: ProjectFacts, method: SchedulingMethod | string | undefined): ResolvedSignal {
  if (facts.totalLeafCount === 0) {
    return sig('progress', 'unknown', 'אין עדיין משימות', 'No tasks yet', 'no_tasks')
  }
  const done = facts.doneLeafCount
  const total = facts.totalLeafCount
  const pct = Math.round((done / total) * 100)

  // Same numerator and denominator, read in the method's own vocabulary.
  if (method === 'kanban') {
    const doing = facts.openLeafTasks.filter(t => t.status === 'in_progress').length
    const queued = facts.openLeafTasks.length - doing
    return sig('progress', 'ok', `${doing} בתהליך · ${queued} ממתינות`, `${doing} in progress · ${queued} queued`)
  }
  if (method === 'gtd') {
    const inbox = facts.openLeafTasks.filter(t => t.status === 'pending').length
    if (inbox > 0) return sig('progress', 'ok', `${inbox} לא מובהרות`, `${inbox} unclarified`)
  }
  return sig('progress', 'ok', `${pct}% · ${done}/${total}`, `${pct}% · ${done}/${total}`)
}

function nextSignal(
  facts: ProjectFacts,
  allTasks: Task[],
  allEvents: CalendarEvent[],
  now: LocalISO,
): ResolvedSignal {
  const task = pickNextStep(facts, allTasks)
  if (!task) return sig('next', 'na', '', '')

  const finished = doneIds(allTasks)
  const unmet = (task.depends_on ?? []).filter(id => !finished.has(id))
  if (unmet.length > 0) {
    const blockerTitle = allTasks.find(t => t.id === unmet[0])?.title ?? unmet[0]
    return sig('next', 'warn', `חסום: ממתין ל"${blockerTitle}"`, `Blocked: waiting on "${blockerTitle}"`)
  }

  // When is it actually happening? The precise ref link, not a title match.
  const scheduled = allEvents
    .filter(e => e.ref?.kind === 'task' && e.ref.id === task.id)
    .map(e => normalizeToLocalISO(e.start_time))
    .filter((s): s is LocalISO => !!s && s >= now)
    .sort()[0]

  if (!scheduled) {
    return sig('next', 'warn', `${task.title} — לא משובץ`, `${task.title} — not scheduled`, 'not_scheduled')
  }
  return sig('next', 'ok', `${task.title} · ${shortWhen(scheduled)}`, `${task.title} · ${shortWhen(scheduled)}`)
}

function investedSignal(
  facts: ProjectFacts,
  unit: 'hours' | 'sessions',
  method: SchedulingMethod | string | undefined,
): ResolvedSignal {
  if (facts.investedMinutes === 0) {
    return sig('invested', 'na', '', '')
  }
  const h = hours(facts.investedMinutes)
  if (unit === 'sessions') {
    // Count in the method's own unit — the calendar already names these blocks
    // "פומודורו", and a card saying "5.0h" next to that is the same mismatch
    // methodRules.ts exists to prevent.
    const per = method ? getMethodRules(method as SchedulingMethod)?.sessionMinutes : undefined
    const count = per && per > 0 ? Math.round(facts.investedMinutes / per) : facts.investedSessions
    return sig('invested', 'ok', `${count} מפגשים · ${h} שעות`, `${count} sessions · ${h}h`)
  }
  return sig('invested', 'ok', `${h} שעות הושקעו`, `${h}h invested`)
}

// ── helpers ─────────────────────────────────────────────────────────────────

function sig(
  signal: ResolvedSignal['signal'],
  state: SignalState,
  he: string,
  en: string,
  code?: ResolvedSignal['code'],
): ResolvedSignal {
  return { signal, state, text: { he, en }, ...(code ? { code } : {}) }
}

function shortWhen(iso: LocalISO): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)} ${iso.slice(11, 16)}`
}

/** Convenience for the API route: build probe inputs from projects + facts. */
export function probeInputFor(project: Project, facts: ProjectFacts) {
  const deadline = normalizeToLocalISO(project.deadline)
  if (!deadline || facts.remainingMinutes <= 0) return null
  return {
    projectId: project.id,
    title: project.title,
    remainingMinutes: facts.remainingMinutes,
    deadline,
    category: KIND_RULES[project.kind].category,
  }
}
