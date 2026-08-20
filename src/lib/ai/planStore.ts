/**
 * planStore.ts — where a proposed plan waits between "here's what I'd do" and "yes".
 *
 * Scheduling is two-phase on purpose. `schedule_item` computes a plan and shows
 * it; `apply_plan` writes exactly those blocks. The alternative — recomputing at
 * apply time — looks equivalent and is not: between the proposal and the tap,
 * `now` has moved, and any event created in the meantime changes the answer. The
 * user would confirm 14:00 and get 16:00, with nothing in the transcript
 * explaining the drift. Storing the blocks makes that impossible by construction.
 *
 * In-memory and per-process. That is a real limitation: a redeploy or a second
 * instance loses pending proposals, and `apply_plan` then reports `plan_expired`
 * rather than writing something stale. For a proposal whose whole life is a few
 * seconds inside one conversation, failing closed is the right trade — but it is
 * the reason this is not a durable store, and it is why the TTL is short.
 */

import { PlanToolResult } from '@/lib/scheduling/adapter'
import { LocalISO } from '@/lib/scheduling/clock'

/** A proposal is answered in seconds, or it is stale. Ten minutes is already generous. */
export const PLAN_TTL_MS = 10 * 60 * 1000
/** Keeps a chatty session from pinning unbounded memory; oldest proposals fall off first. */
export const MAX_PLANS_PER_USER = 8

/** One concrete block, already resolved to the exact times that will be written. */
export interface StoredPlanBlock {
  title: string
  start: LocalISO
  end: LocalISO
  color: string
  mobility: 'fixed' | 'flexible' | 'ask_first'
  /** The rendered Hebrew/English sentences, stored so the event can carry its own "why". */
  why: string[]
  /**
   * Which project this block's time counts towards, and which task it is for.
   *
   * Stamped at apply time onto the written CalendarEvent. Without these the events
   * are not linked to anything, and both invested-time and next-step silently
   * return nothing — the feature would look like it worked and quietly not.
   */
  project_id?: string
  ref?: { kind: 'event' | 'task' | 'project'; id: string }
  /**
   * Where this block's time happens. Same rule as `project_id` above: stamped at
   * apply time onto the written CalendarEvent, and if it is dropped here it is
   * gone by the time the event exists — the exact silent-loss bug `project_id`
   * had until the apply_plan spread-guard was added for it.
   */
  place_id?: string
}

export interface StoredPlan {
  planId: string
  userId: string
  createdAt: number
  blocks: StoredPlanBlock[]
  /** What the model was shown, so a later turn can restate it without recomputing. */
  view: PlanToolResult
}

const plansByUser = new Map<string, Map<string, StoredPlan>>()

function prune(userPlans: Map<string, StoredPlan>, nowMs: number): void {
  for (const [id, plan] of userPlans) {
    if (nowMs - plan.createdAt > PLAN_TTL_MS) userPlans.delete(id)
  }
  while (userPlans.size > MAX_PLANS_PER_USER) {
    // Map preserves insertion order, so the first key is the oldest survivor.
    const oldest = userPlans.keys().next()
    if (oldest.done) break
    userPlans.delete(oldest.value)
  }
}

export function savePlan(
  userId: string,
  blocks: StoredPlanBlock[],
  view: PlanToolResult,
  nowMs: number = Date.now(),
): StoredPlan {
  const planId = `plan_${nowMs.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  let userPlans = plansByUser.get(userId)
  if (!userPlans) {
    userPlans = new Map()
    plansByUser.set(userId, userPlans)
  }
  const plan: StoredPlan = { planId, userId, createdAt: nowMs, blocks, view }
  userPlans.set(planId, plan)
  prune(userPlans, nowMs)
  return plan
}

/**
 * Fetches a plan for this user only. The user id is part of the lookup, not a
 * check after the fact — a plan id guessed from another session must not resolve.
 */
export function getPlan(userId: string, planId: string, nowMs: number = Date.now()): StoredPlan | null {
  const userPlans = plansByUser.get(userId)
  if (!userPlans) return null
  prune(userPlans, nowMs)
  return userPlans.get(planId) ?? null
}

/** Applied plans are consumed, so a double-tap cannot write the same blocks twice. */
export function consumePlan(userId: string, planId: string, nowMs: number = Date.now()): StoredPlan | null {
  const plan = getPlan(userId, planId, nowMs)
  if (plan) plansByUser.get(userId)?.delete(planId)
  return plan
}

/** Test seam. Never called by the app. */
export function __resetPlanStore(): void {
  plansByUser.clear()
}
