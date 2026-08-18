import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import path from 'path'
import { userStore } from '@/lib/store/userStore'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'
import { AIMemory, UserProfile } from '@/types'
import { DATA_DIR } from '@/lib/util/dataDir'
import { assertSafeUserId } from '@/lib/util/safeUserId'
import { readJsonFile } from '@/lib/util/jsonStore'
import { readFeedback } from '@/lib/feedback/store'
import {
  buildSchedulingContext, horizonDaysFor, resolveMethod, resolveNow,
} from '@/lib/scheduling/adapter'
import { probeCapacity, ProjectProbeInput } from '@/lib/projects/capacity'
import { computeFacts, probeInputFor, resolveSignals } from '@/lib/projects/health'
import { boardRulesFor } from '@/lib/projects/boardRules'
import { phasesEnabled } from '@/lib/ai/featureFlags'

async function getAuthUserId(): Promise<string | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(COOKIE_NAME)?.value
  return getUserIdFromCookie(token)
}

/**
 * Health is its own route, separate from GET /api/projects, for two reasons: the
 * list and board can then paint immediately while the engine-backed badges fill in
 * a beat later, and this can poll on a slower cadence than the 30s task poll.
 *
 * The engine runs SERVER-side, which also keeps plan/place/score/repair out of the
 * browser bundle.
 */
export async function GET() {
  const userId = await getAuthUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const safeId = assertSafeUserId(userId)
  const dir = path.join(DATA_DIR, 'users', safeId)
  const profile = readJsonFile<UserProfile | null>(path.join(dir, 'profile.json'), null)
  const memory = readJsonFile<AIMemory[]>(path.join(dir, 'memory.json'), [])
  const feedback = readFeedback(userId)

  const projects = userStore.getProjects(userId).filter(p => p.status === 'active')
  const tasks = userStore.getTasks(userId)
  const events = userStore.getEvents(userId)

  // The board's badge is a dry run of the REAL planSchedule, so it has to see the
  // same priors the chat route does — otherwise the card and the calendar would
  // disagree about the same week, which is the one thing this layer must never do.
  const closedPhaseIds = phasesEnabled()
    ? userStore.getPhases(userId).filter(p => p.status === 'closed').map(p => p.id)
    : undefined

  const isHe = (profile?.language ?? 'en') === 'he'
  const timezone = profile?.timezone
  const now = resolveNow(undefined, timezone)

  // Facts first — they carry the remaining-work figure the probe needs, already
  // net of anything this project has on the calendar (see the double-count trap
  // in health.ts).
  const facts = new Map(projects.map(p => [p.id, computeFacts(p, tasks, events, now)]))

  const probeInputs: ProjectProbeInput[] = []
  for (const p of projects) {
    const input = probeInputFor(p, facts.get(p.id)!)
    if (input) probeInputs.push(input)
  }

  // The horizon must reach the furthest deadline we are asked about, or that
  // project is judged against days the engine was never allowed to look at.
  const horizonDays = probeInputs.reduce(
    (max, i) => Math.max(max, horizonDaysFor(now, i.deadline)),
    14,
  )

  const ctx = buildSchedulingContext(profile, events, memory, feedback, timezone, now, horizonDays, closedPhaseIds)
  const probe = probeCapacity(ctx, probeInputs, isHe)

  const method = resolveMethod(profile).primary
  const health: Record<string, unknown> = {}
  for (const p of projects) {
    const f = facts.get(p.id)!
    health[p.id] = {
      signals: resolveSignals(p, tasks, events, probe.get(p.id), method, now),
      board: boardRulesFor(method),
      // Raw numbers for debugging only — the card reads `signals[].text`, which is
      // what keeps phrasing out of the component.
      raw: {
        remaining_minutes: f.remainingMinutes,
        invested_minutes: f.investedMinutes,
        done_leaves: f.doneLeafCount,
        total_leaves: f.totalLeafCount,
        unestimated: f.unestimatedCount,
        capacity_minutes: probe.get(p.id)?.placedMinutes ?? null,
      },
    }
  }

  return NextResponse.json({ health, method, now })
}
