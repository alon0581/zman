/**
 * capacity.ts — "do I actually have the hours?", answered by the real engine.
 *
 * This is the one number no other project tool can produce, because it needs the
 * user's actual calendar, working hours, method and habits. So it must not be a
 * second, simpler capacity calculation living alongside the planner: the moment
 * the board and the calendar disagree, both become untrustworthy. It runs the
 * real `planSchedule` as a dry run and throws the blocks away.
 *
 * ONE BATCHED CALL FOR ALL PROJECTS, never one per project. `orderRequests`
 * already sorts most-constrained-first, so within a single call the earlier
 * deadline claims capacity first — exactly as the real planner would. N separate
 * calls each get a fresh `emptyState(ctx)`, so two projects competing for the same
 * Tuesday would BOTH come back green while together they do not fit. That quiet
 * double-booking is precisely the class of bug this engine exists to remove.
 */

import { PlanOutcome, PlacementRequest, SchedulingContext } from '@/lib/scheduling/types'
import { LocalISO } from '@/lib/scheduling/clock'
import { planSchedule } from '@/lib/scheduling/plan'
import { planOutcomeToToolResult } from '@/lib/scheduling/adapter'
import { Category } from '@/lib/scheduling/types'

/**
 * A batch is a handful of projects, not a backlog. Beyond this the probe reports
 * `plan_unavailable` for the overflow rather than silently leaving it unscored —
 * an unscored project must never render as a scored one.
 */
export const MAX_PROBED_PROJECTS = 12

/**
 * The probe asks for MORE time than the project actually needs, and the surplus is
 * the whole point.
 *
 * Asking for exactly the remaining work can only ever answer "does it fit", which
 * is not the question a deadline badge should answer — the engine deliberately
 * SPREADS sessions across the available days, so the last block of any
 * multi-session project lands near the deadline whether the schedule is
 * comfortable or desperate. Measuring "how close did the last block land" would
 * therefore mark every project as tight.
 *
 * Asking for 125% and seeing how much of that lands measures the thing that
 * actually matters: whether there is room to slip. All of it fits -> real slack.
 * Only the base fits -> it works, with nothing spare. Less -> genuinely short.
 */
export const CAPACITY_SLACK = 1.25

export interface ProjectProbeInput {
  projectId: string
  title: string
  /** Work still to do, already net of anything on the calendar. See health.ts. */
  remainingMinutes: number
  deadline: LocalISO
  category: Category
}

export interface ProjectProbeResult {
  status: PlanOutcome['status']
  /**
   * Minutes the engine actually managed to place, out of the padded ask. A floor,
   * never an estimate. Compare against the project's real remaining work to get
   * "comfortable" vs "fits exactly" vs "short".
   */
  placedMinutes: number
  /** What was asked for: remaining work x CAPACITY_SLACK. */
  requestedMinutes: number
  /** End of the last placed block. */
  lastEnd?: LocalISO
  /** Rendered by UNPLACED_TEXT — the card never writes its own explanation. */
  reason?: string
  /** Rendered by RELAXATION_TEXT. */
  suggestions: string[]
}

export type ProbeMap = Map<string, ProjectProbeResult>

/**
 * Runs one planning pass over every project that has work and a deadline.
 *
 * Pure: `ctx` carries `now`, and nothing here touches fs, fetch or `new Date()`.
 */
export function probeCapacity(
  ctx: SchedulingContext,
  inputs: ProjectProbeInput[],
  isHe: boolean,
): ProbeMap {
  const out: ProbeMap = new Map()

  const eligible = inputs
    .filter(i => i.remainingMinutes > 0)
    // Earliest deadline first, so if the cap bites it drops the least urgent work.
    .sort((a, b) => (a.deadline === b.deadline ? (a.projectId < b.projectId ? -1 : 1) : a.deadline < b.deadline ? -1 : 1))

  const probed = eligible.slice(0, MAX_PROBED_PROJECTS)
  for (const overflow of eligible.slice(MAX_PROBED_PROJECTS)) {
    out.set(overflow.projectId, {
      status: 'blocked', placedMinutes: 0, requestedMinutes: overflow.remainingMinutes, suggestions: [],
    })
  }
  if (probed.length === 0) return out

  const askFor = (mins: number) => Math.ceil(mins * CAPACITY_SLACK)

  const requests: PlacementRequest[] = probed.map(i => ({
    ref: { kind: 'project', id: i.projectId },
    title: i.title,
    totalMinutes: askFor(i.remainingMinutes),
    deadline: i.deadline,
    category: i.category,
    mobility: 'flexible',
  }))

  const outcome = planSchedule(ctx, requests)
  const view = planOutcomeToToolResult(outcome, isHe, requests)

  const blocks = 'blocks' in outcome ? outcome.blocks : []
  const unplaced = outcome.status === 'ok' ? [] : outcome.unplaced

  probed.forEach((input, requestIndex) => {
    const mine = blocks.filter(b => b.requestIndex === requestIndex)
    const placedMinutes = mine.reduce((sum, b) => sum + minutesBetween(b.start, b.end), 0)
    const lastEnd = mine.reduce<LocalISO | undefined>(
      (max, b) => (!max || b.end > max ? b.end : max),
      undefined,
    )

    const failure = unplaced.find(u => u.requestIndex === requestIndex)
    const reason = failure
      ? view.unplaced?.find(u => u.code === failure.code)?.reason
      : undefined

    // Status is about the REAL work, not the padded ask: failing to place the
    // 25% cushion is not a failure, it is the absence of slack. Callers read
    // placedMinutes against remainingMinutes to tell those apart.
    const status: PlanOutcome['status'] =
      placedMinutes >= input.remainingMinutes ? 'ok'
        : placedMinutes > 0 ? 'partial'
          : 'blocked'

    out.set(input.projectId, {
      status,
      placedMinutes,
      requestedMinutes: askFor(input.remainingMinutes),
      lastEnd,
      reason,
      suggestions: (view.suggestions ?? []).map(s => s.suggestion),
    })
  })

  return out
}

/** Naive LocalISO difference in minutes. Both sides are wall-clock, never UTC. */
function minutesBetween(start: LocalISO, end: LocalISO): number {
  const ms = Date.parse(`${end}Z`) - Date.parse(`${start}Z`)
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 60000)) : 0
}
