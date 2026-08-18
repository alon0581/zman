/**
 * retire.ts — what "the semester ended, clear my lectures" should do to a
 * recurring series, as opposed to what it used to do.
 *
 * `delete_event` with `delete_series: true` (the `delete_series` branch in
 * src/lib/ai/executeTool.ts) does
 * `currentEvents.filter(e => e.series_id === sid)` with NO DATE BOUND, then
 * deletes every id that comes back — including every lecture already
 * attended. "End this series as of today" and "erase that it ever happened"
 * are different requests, and that filter cannot tell them apart. This is a
 * pure function rather than route code for the same reason cascade.ts is: it
 * is the destructive path, and the destructive path should be the
 * well-tested one. The route executes the plan; it does not decide it.
 *
 * The rule that shapes the whole file: PAST INSTANCES ARE HISTORY, NEVER
 * TOUCHED. The comparison is by calendar DATE, not by exact timestamp, and an
 * instance starting ON the cutoff date is deleted along with the future — if
 * the user says "I stopped going" today, today's lecture didn't happen
 * either. Nothing about that reasoning is negotiable per-caller: it is the
 * one thing this file is for.
 */

import { CalendarEvent } from '@/types'
import { LocalISO, localDateKey } from '@/lib/scheduling/clock'
import { normalizeToLocalISO } from '@/lib/scheduling/adapter'

export interface SeriesRetirementPlan {
  /** Instances starting on or after the cutoff DATE. */
  deleteIds: string[]
  /** Instances before it. History. Never touched. */
  keptPast: number
  /** LocalISO start of the final surviving instance — the sentence the user gets back. */
  lastKept?: string
}

/**
 * Works out which instances of a recurring series a "retire this series"
 * request would delete, without deleting any of it.
 *
 * Only events whose `series_id === seriesId` are ever considered — a
 * `seriesId` that matches nothing yields an empty plan, not a thrown error,
 * and an event from any other series is never even looked at, let alone
 * named. `cutoff` may arrive as a bare date ('2026-08-15') or a full LocalISO
 * ('2026-08-15T09:00:00'); only the first 10 characters — the date — are
 * read, so what time of day the cutoff carries never matters.
 *
 * `start_time` goes through `normalizeToLocalISO` before the same date-slice
 * comparison, because legacy rows can be `Z`-suffixed instants rather than
 * naive LocalISO strings. An event whose `start_time` cannot be parsed at all
 * is KEPT — never deleted. Silently dropping something this function cannot
 * read is exactly the failure mode this codebase refuses everywhere else
 * (see cascade.ts, adapter.ts); an unreadable date is not evidence the event
 * is safe to erase.
 *
 * The plan only ever contains ids drawn from `seriesId`'s own events, so
 * deleting anything outside the series is impossible by construction — the
 * shape has no field to put another event's id in.
 */
export function planSeriesRetirement(
  events: CalendarEvent[],
  seriesId: string,
  cutoff: LocalISO,
): SeriesRetirementPlan {
  const cutoffDate = cutoff.slice(0, 10)
  const seriesEvents = events.filter(e => e.series_id === seriesId)

  const deleteIds: string[] = []
  let lastKept: LocalISO | undefined

  for (const e of seriesEvents) {
    const normalized = normalizeToLocalISO(e.start_time)
    if (normalized === null) continue // unparseable: kept, not deleted — see header

    if (localDateKey(normalized) >= cutoffDate) {
      deleteIds.push(e.id)
    } else if (!lastKept || normalized > lastKept) {
      lastKept = normalized
    }
  }

  return {
    deleteIds,
    keptPast: seriesEvents.length - deleteIds.length,
    ...(lastKept ? { lastKept } : {}),
  }
}
