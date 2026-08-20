/**
 * executeTool.ts — the AI tool dispatcher, lifted verbatim out of
 * `src/app/api/chat/route.ts`.
 *
 * It lives here and not in the route for one hard reason: an App Router route
 * file may export nothing but HTTP method handlers and Next's route config, so
 * a second caller (the iPhone Shortcut endpoint) could never have reached it
 * there. Nothing about the dispatcher changed in the move — same switch, same
 * arguments, same fail-closed flag checks, same storage writes.
 *
 * Its only caller is `runTurn.ts`; `memoryFile` is exported alongside because
 * the turn loader reads the same file to recall memory server-side.
 */

import {
  PHASE_ONLY_TOOLS, PLACE_ONLY_TOOLS, PROJECT_ONLY_TOOLS, V2_ONLY_TOOLS,
} from '@/lib/ai/tools'
import { phasesEnabled, placesEnabled, projectsEnabled } from '@/lib/ai/featureFlags'
import { consumePlan } from '@/lib/ai/planStore'
import {
  buildBreakdownSpec, buildScheduleItemSpec, methodMobility,
  methodTitleFormatter, planMove, planRecurring, proposePlan, recurringToolResult, SchedulerCtx,
} from '@/lib/ai/schedulerTools'
import { getMethodRules } from '@/lib/scheduling/methodRules'
import { buildProjectPlanSpec } from '@/lib/ai/projectTools'
import { CalendarEvent, UserProfile, AIMemory, Phase, Place, Project, Task } from '@/types'
import { planProjectDeletion } from '@/lib/projects/cascade'
import { planSeriesRetirement } from '@/lib/phases/retire'
import { defaultScopeFor, isRestoreDenied } from '@/lib/phases/scope'
import { mirrorProfileToMemory } from '@/lib/store/profileMirror'
import { probeCapacity, ProjectProbeResult } from '@/lib/projects/capacity'
import { computeFacts, probeInputFor, resolveSignals } from '@/lib/projects/health'
import {
  buildSchedulingContext, horizonDaysFor, resolveMethod, resolveNow,
} from '@/lib/scheduling/adapter'
import { addDays, addHours, addMinutes, format, parseISO, startOfDay, endOfDay } from 'date-fns'
import { userStore } from '@/lib/store/userStore'
import { classifyMobility } from '@/lib/scheduling/mobilityClassifier'
import { mapToMethod } from '@/lib/scheduling/methodMapper'
import { sendPush, sendFcmPush } from '@/lib/push'
import { sendNtfy, defaultTopicFor, isNtfyConfigured } from '@/lib/notifications/channels/ntfy'
import { assertSafeUserId } from '@/lib/util/safeUserId'
import { readJsonFile, writeJsonFileAtomic } from '@/lib/util/jsonStore'
import { DATA_DIR } from '@/lib/util/dataDir'
import { recordFeedback } from '@/lib/feedback/store'
import crypto from 'crypto'
import path from 'path'

// Shared constants
const BUFFER_MIN = 15        // minutes of breathing room between events
const MEM_KEY_MAX = 100      // max length of a memory key
const MEM_VALUE_MAX = 10000  // max length of a memory value

export function memoryFile(userId: string) {
  return path.join(DATA_DIR, 'users',assertSafeUserId(userId), 'memory.json')
}

/**
 * The bag of "something changed" flags a turn accumulates. `runTurn` owns one and
 * hands the same object to every tool call, which is what lets the SSE stream
 * decide, once at the end, which refresh frames to emit.
 */
export type ToolState = {
  completedProfile: UserProfile | null
  memoryUpdated: boolean
  tasksUpdated: boolean
  projectsUpdated: boolean
}

/** Parse an "HH:mm" string to an hour in [0,23], falling back on bad input. */
function parseHour(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const m = /^(\d{1,2})/.exec(value.trim())
  if (!m) return fallback
  const h = parseInt(m[1], 10)
  return h >= 0 && h <= 23 ? h : fallback
}

// ─── Tool executor ────────────────────────────────────────────────────────────

export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  userId: string,
  currentEvents: CalendarEvent[],
  createdEvents: CalendarEvent[],
  updatedEvents: CalendarEvent[],
  deletedEventIds: string[],
  profile: UserProfile | null,
  state: ToolState = { completedProfile: null, memoryUpdated: false, tasksUpdated: false, projectsUpdated: false },
  pushSubscription?: string,
  fcmToken?: string,
  now: Date = new Date(),  // user-local "now" (Asia/Jerusalem), not server UTC — used for scheduling
  // Absent (or disabled) ⇒ every `sched?.enabled` branch below is dead and the
  // dispatcher behaves exactly as it did before the engine existed.
  sched?: SchedulerCtx,
): Promise<unknown> {
  // ── Input validation helpers ──────────────────────────────────────────────
  const str  = (v: unknown): string  => (typeof v === 'string' ? v : '')
  const num  = (v: unknown): number  => (typeof v === 'number' ? v : 0)
  const bool = (v: unknown): boolean => (typeof v === 'boolean' ? v : false)

  // A v2-only tool reached through a stale transcript when the flag is off must
  // fail loudly rather than silently doing nothing.
  if (!sched?.enabled && V2_ONLY_TOOLS.has(toolName)) {
    return { error: 'unknown_tool', message: `Unknown tool: ${toolName}` }
  }

  // Same fail-closed rule for the projects surface: a stale transcript must not be
  // able to reach a tool the flag has turned off.
  const projectsOn = projectsEnabled()
  if (!projectsOn && PROJECT_ONLY_TOOLS.has(toolName)) {
    return { error: 'unknown_tool', message: `Unknown tool: ${toolName}` }
  }

  if (!phasesEnabled() && PHASE_ONLY_TOOLS.has(toolName)) {
    return { error: 'unknown_tool', message: `Unknown tool: ${toolName}` }
  }

  // Same fail-closed rule for the places surface: a stale transcript must not be
  // able to reach a tool the flag has turned off.
  const placesOn = placesEnabled()
  if (!placesOn && PLACE_ONLY_TOOLS.has(toolName)) {
    return { error: 'unknown_tool', message: `Unknown tool: ${toolName}` }
  }

  switch (toolName) {
    case 'create_event': {
      // Validate required fields
      if (!str(input.title) || !str(input.start_time) || !str(input.end_time)) {
        return { error: 'missing_required_fields', message: 'title, start_time, and end_time are required' }
      }
      if (isNaN(Date.parse(str(input.start_time))) || isNaN(Date.parse(str(input.end_time)))) {
        return { error: 'invalid_date', message: 'start_time or end_time is not a valid date' }
      }
      if (Date.parse(str(input.end_time)) <= Date.parse(str(input.start_time))) {
        return { error: 'invalid_range', message: 'end_time must be after start_time' }
      }
      // Resolved BEFORE the recurrence branch below, so a series and a single
      // event cannot disagree about it. `place_id` exists as a parameter only
      // when PLACES is on (PLACES_PARAMETER_EXTRAS in lib/ai/tools.ts), so with
      // the flag off this resolves to undefined and create_event behaves
      // byte-identically to before.
      //
      // A place_id that does not resolve is refused rather than dropped — the
      // exact bug that made project_id useless for weeks.
      let resolvedPlaceId: string | undefined
      if (placesOn) {
        const placeId = str(input.place_id)
        if (placeId) {
          const place = userStore.getPlaces(userId).find(p => p.id === placeId)
          if (!place) return { error: 'not_found', message: `No place with id ${placeId}` }
          resolvedPlaceId = place.id
        }
      }

      // ── Recurring shortcut: generate N instances, skip conflict checks ───
      const recurrence = input.recurrence as { frequency?: string; count?: number; end_date?: string } | undefined
      if (recurrence?.frequency && sched?.enabled) {
        // Same generation, but every instance is checked against the real
        // timeline — the one that understands all-day events and multi-day
        // spans — and every skip is reported. The v1 path below checks only
        // `fixed` clashes with a naive overlap test and then swallows the
        // result in a bare `skipped` count, which is how a weekly series
        // quietly double-booked itself from week three onward.
        return applyRecurringPlan(input, userId, currentEvents, createdEvents, profile, sched, recurrence)
      }
      if (recurrence?.frequency) {
        const seriesId = crypto.randomUUID()
        const baseStart = new Date(input.start_time as string)
        const baseEnd   = new Date(input.end_time as string)
        const durationMs = baseEnd.getTime() - baseStart.getTime()
        const freq = recurrence.frequency
        const daysStep = freq === 'monthly' ? 30 : freq === 'biweekly' ? 14 : 7
        const maxCount = recurrence.count ?? (freq === 'monthly' ? 6 : 12)
        const endDate  = recurrence.end_date ? new Date(recurrence.end_date) : null
        const recTitleLower = str(input.title).toLowerCase().trim()
        let created = 0
        let skipped = 0
        let recWriteErrors = 0

        for (let i = 0; i < maxCount; i++) {
          const instanceStart = addDays(baseStart, i * daysStep)
          if (endDate && instanceStart > endDate) break
          const instanceEnd = new Date(instanceStart.getTime() + durationMs)

          const known = [...currentEvents, ...createdEvents]
          // Dedupe: identical title at this exact start already exists (e.g. the series
          // was created once already in a retry) — don't pile on duplicates.
          const isDup = known.some(e =>
            e.title.toLowerCase().trim() === recTitleLower &&
            new Date(e.start_time).getTime() === instanceStart.getTime()
          )
          if (isDup) { skipped++; continue }
          // Never drop a recurring (usually flexible) instance on top of a FIXED
          // commitment (exam/lecture/flight). Skip that instance instead of stomping it.
          const clashesFixed = known.some(e => {
            const mob = e.mobility_type ?? classifyMobility(e.title, e.created_by, true)
            if (mob !== 'fixed') return false
            return instanceStart < new Date(e.end_time) && instanceEnd > new Date(e.start_time)
          })
          if (clashesFixed) { skipped++; continue }

          const instance: CalendarEvent = {
            id: crypto.randomUUID(),
            user_id: userId,
            title: str(input.title),
            start_time: format(instanceStart, "yyyy-MM-dd'T'HH:mm:ss"),
            end_time: format(instanceEnd, "yyyy-MM-dd'T'HH:mm:ss"),
            description: str(input.description),
            color: str(input.color) || '#3B7EF7',
            source: 'zman',
            created_by: 'ai',
            status: 'confirmed',
            is_all_day: false,
            created_at: new Date().toISOString(),
            series_id: seriesId,
            recurrence_rule: freq,
            // Per instance, because a series is N rows and there is nothing else
            // to hang it on — and because it is the right model anyway: a shift
            // can move branch for one week without the rest of the series
            // following it.
            ...(resolvedPlaceId ? { place_id: resolvedPlaceId } : {}),
          }

          try {
            userStore.addEvent(instance, userId)
          } catch (err) {
            recWriteErrors++
            console.warn('[chat] recurring instance write failed:', (err as Error)?.message)
            continue  // don't count an instance that didn't save
          }

          createdEvents.push(instance)
          created++
        }
        return {
          success: recWriteErrors === 0,
          series_id: seriesId,
          instances_created: created,
          skipped,
          ...(recWriteErrors > 0 ? { error: 'write_failed', message: `${recWriteErrors} instance(s) failed to save — do NOT claim those were created.` } : {}),
        }
      }

      const allKnownEvents = [...currentEvents, ...createdEvents]

      // 1. Duplicate check — same title AND same start time.
      // (Same title at a different hour is a legitimate second session, not a dup.)
      const newTitle = str(input.title).toLowerCase().trim()
      const newStartTs = new Date(str(input.start_time)).getTime()
      const duplicate = allKnownEvents.find(e =>
        new Date(e.start_time).getTime() === newStartTs &&
        e.title.toLowerCase().trim() === newTitle
      )
      if (duplicate) {
        return { error: 'duplicate', existingId: duplicate.id, existingTitle: duplicate.title, existingTime: duplicate.start_time }
      }

      // 2. Overlap check — detect real time conflicts and suggest alternatives
      const newStart = new Date(str(input.start_time))
      const newEnd = new Date(str(input.end_time))
      const overlapping = allKnownEvents.find(e => {
        const eStart = new Date(e.start_time)
        const eEnd = new Date(e.end_time)
        return newStart < eEnd && newEnd > eStart
      })
      if (overlapping) {
        const duration = (newEnd.getTime() - newStart.getTime()) / 60000
        const rangeStart = new Date(newStart)
        rangeStart.setHours(0, 0, 0, 0)
        const rangeEnd = addDays(rangeStart, 3)
        const alternatives = getFreeSlots(
          allKnownEvents, rangeStart.toISOString(), rangeEnd.toISOString(), duration, profile, false, now
        ).slice(0, 3)
        return {
          error: 'conflict',
          conflictingEvent: { id: overlapping.id, title: overlapping.title, start: overlapping.start_time, end: overlapping.end_time },
          alternatives,
        }
      }

      // 3. Buffer check — warn if this event will be back-to-back with another
      const bufferWarnings: string[] = []
      for (const ev of allKnownEvents) {
        const evStart = new Date(ev.start_time)
        const evEnd = new Date(ev.end_time)
        const gapAfter = (newStart.getTime() - evEnd.getTime()) / 60000
        if (gapAfter >= 0 && gapAfter < BUFFER_MIN) {
          bufferWarnings.push(`"${ev.title}" ends only ${Math.round(gapAfter)} min before this event`)
        }
        const gapBefore = (evStart.getTime() - newEnd.getTime()) / 60000
        if (gapBefore >= 0 && gapBefore < BUFFER_MIN) {
          bufferWarnings.push(`"${ev.title}" starts only ${Math.round(gapBefore)} min after this event`)
        }
      }

      const status = str(input.status)
      const event: CalendarEvent = {
        id: crypto.randomUUID(),
        user_id: userId,
        title: str(input.title),
        start_time: str(input.start_time),
        end_time: str(input.end_time),
        description: str(input.description),
        color: str(input.color) || '#3B7EF7',
        source: 'zman',
        created_by: 'ai',
        status: (status === 'confirmed' || status === 'proposed') ? status : 'confirmed',
        is_all_day: bool(input.is_all_day),
        created_at: new Date().toISOString(),
        // Auto-classify mobility if AI didn't specify
        mobility_type: (input.mobility_type === 'fixed' || input.mobility_type === 'flexible' || input.mobility_type === 'ask_first')
          ? input.mobility_type
          : classifyMobility(str(input.title), 'ai', true),
      }

      if (resolvedPlaceId) event.place_id = resolvedPlaceId

      try {
        userStore.addEvent(event, userId)
      } catch (err) {
        return { error: 'write_failed', message: `Could not save the event: ${(err as Error)?.message}. Do NOT tell the user it was created.` }
      }

      createdEvents.push(event)
      return { success: true, event, buffer_warnings: bufferWarnings.length > 0 ? bufferWarnings : undefined }
    }

    case 'update_event': {
      const { event_id, title, color, mobility_type, apply_to_series } = input as {
        event_id: string; title?: string; color?: string; mobility_type?: string; apply_to_series?: boolean
      }
      const existing = currentEvents.find(e => e.id === event_id)
      if (!existing) return { error: 'Event not found' }

      const changes: Record<string, string> = {}
      if (title)         changes.title         = title
      if (color)         changes.color         = color
      if (mobility_type) changes.mobility_type = mobility_type

      if (Object.keys(changes).length === 0) return { error: 'No changes provided' }

      // Apply to entire recurring series
      if (apply_to_series && existing.series_id) {
        const seriesEvents = currentEvents.filter(e => e.series_id === existing.series_id)
        for (const e of seriesEvents) userStore.updateEvent(e.id, changes as Partial<CalendarEvent>, userId)
        const updatedSeries = seriesEvents.map(e => ({ ...e, ...changes } as CalendarEvent))
        updatedEvents.push(...updatedSeries)
        return { success: true, updated_count: seriesEvents.length, series_id: existing.series_id }
      }

      // Single event update
      userStore.updateEvent(event_id, changes as Partial<CalendarEvent>, userId)

      const updated = { ...existing, ...changes }
      updatedEvents.push(updated as CalendarEvent)
      return {
        success: true,
        event: updated,
        // Signal the mismatch when the model asked for a series update but there's no series
        ...(apply_to_series && !existing.series_id ? { warning: 'This event has no series_id — updated the single instance only.' } : {}),
      }
    }

    case 'move_event': {
      const { event_id, new_start_time, new_end_time } = input as { event_id: string; new_start_time: string; new_end_time: string }

      // ── SCHEDULER_V2: no time given means "you find one" ──────────────────
      // A move is a single, visible, reversible change, so unlike schedule_item
      // it applies immediately — but the slot is the engine's answer, not the
      // model's guess, and it comes back with the reasons that chose it.
      if (sched?.enabled && !str(new_start_time)) {
        return applyEngineMove(
          str(event_id), userId, currentEvents, createdEvents, updatedEvents, profile, sched, now,
        )
      }

      if (!str(new_start_time) || !str(new_end_time) ||
          isNaN(Date.parse(str(new_start_time))) || isNaN(Date.parse(str(new_end_time)))) {
        return { error: 'invalid_date', message: 'new_start_time and new_end_time must be valid dates' }
      }
      if (Date.parse(str(new_end_time)) <= Date.parse(str(new_start_time))) {
        return { error: 'invalid_range', message: 'new_end_time must be after new_start_time' }
      }
      const existing = currentEvents.find(e => e.id === event_id)
      if (!existing) return { error: 'Event not found' }
      // Enforce mobility_type — fixed events cannot be moved
      if (existing.mobility_type === 'fixed') {
        return { error: 'fixed_event', message: `"${existing.title}" is marked as Fixed (🔒) and cannot be moved.` }
      }

      // Overlap check — don't let a move stack this event on top of another
      const moveStart = new Date(str(new_start_time))
      const moveEnd = new Date(str(new_end_time))
      const moveConflict = [...currentEvents, ...createdEvents].find(e => {
        if (e.id === event_id) return false  // ignore the event being moved
        return moveStart < new Date(e.end_time) && moveEnd > new Date(e.start_time)
      })
      if (moveConflict) {
        const duration = (moveEnd.getTime() - moveStart.getTime()) / 60000
        const rangeStart = new Date(moveStart); rangeStart.setHours(0, 0, 0, 0)
        const alternatives = getFreeSlots(
          currentEvents.filter(e => e.id !== event_id),
          rangeStart.toISOString(), addDays(rangeStart, 3).toISOString(), duration, profile, false, now
        ).slice(0, 3)
        return {
          error: 'conflict',
          conflictingEvent: { id: moveConflict.id, title: moveConflict.title, start: moveConflict.start_time, end: moveConflict.end_time },
          alternatives,
        }
      }

      const updated = { ...existing, start_time: new_start_time, end_time: new_end_time }

      // Learning signal: moving an AI-created event = its proposed time wasn't right.
      if (existing.created_by === 'ai') {
        const oldStart = new Date(existing.start_time)
        recordFeedback(userId, {
          type: 'moved', title: existing.title,
          fromHour: oldStart.getHours(), toHour: new Date(str(new_start_time)).getHours(),
          day: format(oldStart, 'EEE'), at: new Date().toISOString(),
        })
      }

      userStore.updateEvent(event_id, { start_time: new_start_time, end_time: new_end_time }, userId)

      updatedEvents.push(updated)
      return { success: true, event: updated }
    }

    case 'delete_event': {
      const { event_id, delete_series } = input as { event_id: string; delete_series?: boolean }

      // ── Delete entire recurring series ──────────────────────────────────
      if (delete_series) {
        const allKnownEvents = [...currentEvents, ...createdEvents]
        const target = allKnownEvents.find(e => e.id === event_id)
        const sid = target?.series_id

        if (sid) {
          const seriesIds = currentEvents.filter(e => e.series_id === sid).map(e => e.id)
          for (const id of seriesIds) userStore.deleteEvent(id, userId)
          deletedEventIds.push(...seriesIds)
          return { success: true, deleted_series_id: sid, instances_deleted: seriesIds.length }
        }
        // No series_id — fall through to single delete
      }

      userStore.deleteEvent(event_id, userId)

      deletedEventIds.push(event_id)
      return { success: true }
    }

    // Still declared and still working with the flag off. With the flag on it is
    // simply not in the tool list the model is given, so this case is unreachable
    // — the arithmetic is the engine's job, and an unoffered tool cannot be called.
    case 'get_free_slots': {
      const { from_date, to_date, min_duration_minutes = 60, prefer_peak = false } = input as { from_date: string; to_date: string; min_duration_minutes?: number; prefer_peak?: boolean }
      return { free_slots: getFreeSlots(currentEvents, from_date, to_date, min_duration_minutes as number, profile, prefer_peak as boolean, now) }
    }

    // ── SCHEDULER_V2 tools ────────────────────────────────────────────────
    // Guarded above by V2_ONLY_TOOLS, so with the flag off neither is reachable.

    case 'schedule_item': {
      if (!sched?.enabled) return { error: 'unknown_tool', message: 'Unknown tool: schedule_item' }
      const spec = buildScheduleItemSpec(input, profile, sched)
      if (!spec) return { error: 'missing_required_fields', message: 'title is required' }
      // Events created earlier in this same turn are part of the world the
      // engine must plan around, or two tool calls in one turn book the same hour.
      return proposePlan(userId, [...currentEvents, ...createdEvents], profile, sched, now, spec).toolResult
    }

    case 'apply_plan': {
      if (!sched?.enabled) return { error: 'unknown_tool', message: 'Unknown tool: apply_plan' }
      const planId = str(input.plan_id)
      if (!planId) return { error: 'missing_required_fields', message: 'plan_id is required' }

      // Consumed, not just read: the blocks are written verbatim, so applying the
      // same proposal twice would duplicate every event on the calendar.
      const plan = consumePlan(userId, planId)
      if (!plan) {
        return {
          error: 'plan_expired',
          message: 'That plan is no longer available (applied already, or older than ~10 minutes). Call schedule_item again — do NOT invent times from the earlier message.',
        }
      }

      const written: CalendarEvent[] = []
      const failed: string[] = []
      // A project plan changes what the board shows, so the client must refetch.
      if (plan.blocks.some(b => b.project_id)) state.projectsUpdated = true
      for (const block of plan.blocks) {
        const event: CalendarEvent = {
          id: crypto.randomUUID(),
          user_id: userId,
          title: block.title,
          start_time: block.start,
          end_time: block.end,
          // The engine's own justification, kept on the event so the calendar
          // can still answer "why is this here" long after the chat scrolled away.
          description: block.why.join(' · '),
          color: block.color,
          source: 'zman',
          created_by: 'ai',
          status: 'confirmed',
          is_all_day: false,
          created_at: new Date().toISOString(),
          mobility_type: block.mobility,
          // Set only for project plans. Without these the written events are not
          // linked to anything, and both invested-time and next-step silently
          // return nothing — the feature would look like it worked and quietly not.
          ...(block.project_id ? { project_id: block.project_id } : {}),
          ...(block.ref ? { ref: block.ref } : {}),
          // Same rule: nothing today puts place_id on a stored block (it is a
          // create_event-only parameter), but if that ever changes this guard is
          // what stops it from being silently dropped at apply time.
          ...(block.place_id ? { place_id: block.place_id } : {}),
        }
        try {
          await persistEvent(event, userId)
          createdEvents.push(event)
          written.push(event)
        } catch (err) {
          failed.push(`${block.title} @ ${block.start}: ${(err as Error)?.message}`)
        }
      }

      return {
        success: failed.length === 0,
        events_created: written.length,
        events: written.map(e => ({ id: e.id, title: e.title, start: e.start_time, end: e.end_time })),
        ...(failed.length > 0 ? {
          error: 'write_failed',
          failed,
          message: `${failed.length} block(s) failed to save. Do NOT tell the user those were scheduled.`,
        } : {}),
      }
    }

    case 'break_down_task': {
      const { task_title, deadline, total_hours, session_length_hours, color = '#6366F1' } = input as {
        task_title: string; deadline: string; total_hours: number; session_length_hours?: number; color?: string
      }

      // ── SCHEDULER_V2: the same request, answered by the engine ─────────────
      // Session length still comes from the method (that is a promise the UI
      // makes), but WHERE the sessions land is the engine's answer, and nothing
      // is written until the user agrees.
      if (sched?.enabled) {
        const spec = buildBreakdownSpec(input, profile, sched)
        if (!spec) return { error: 'missing_required_fields', message: 'task_title and a positive total_hours are required' }
        return proposePlan(userId, [...currentEvents, ...createdEvents], profile, sched, now, spec).toolResult
      }

      const userMethod = profile?.scheduling_method as string | undefined
      // The method's own rules are the single source for session length — the same
      // table the engine reads on the v2 path above. This used to consult a second
      // table (METHOD_SESSION_HOURS) that disagreed with METHOD_RULES on ten of
      // eighteen methods, so which code path ran silently changed the block the
      // user got. Deleted; both paths now answer from METHOD_RULES.
      // resolveMethod sanitizes a garbage stored value instead of letting it reach
      // getMethodRules, which is the same guard the engine path relies on.
      const effectiveSessionLength = session_length_hours
        ?? getMethodRules(resolveMethod(profile).primary).sessionMinutes / 60

      const formatTitle = methodTitleFormatter(userMethod)
      const defaultMobility = methodMobility(userMethod)

      // Gather candidate slots chronologically (with is_peak flags) across the whole
      // window, then SPREAD the sessions across non-consecutive days instead of
      // stacking them — pickSpreadSlots prefers the peak slot within each chosen day.
      const sessionsNeeded = Math.ceil(total_hours / effectiveSessionLength)
      const candidateSlots = getFreeSlots(
        currentEvents, now.toISOString(), deadline, effectiveSessionLength * 60, profile, false, now,
        Math.max(40, sessionsNeeded * 6)
      )
      const slots = pickSpreadSlots(candidateSlots, sessionsNeeded)
      let created = 0
      let writeErrors = 0

      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i]
        const event: CalendarEvent = {
          id: crypto.randomUUID(),
          user_id: userId,
          title: formatTitle(task_title, i),
          start_time: slot.start,
          end_time: format(addMinutes(parseISO(slot.start), effectiveSessionLength * 60), "yyyy-MM-dd'T'HH:mm:ss"),
          color: color as string,
          source: 'zman',
          created_by: 'ai',
          status: 'confirmed',
          is_all_day: false,
          created_at: new Date().toISOString(),
          mobility_type: defaultMobility,
        }

        try {
          userStore.addEvent(event, userId)
        } catch (err) {
          writeErrors++
          console.warn('[chat] break_down_task write failed:', (err as Error)?.message)
          continue  // don't count or surface a session that didn't actually save
        }

        createdEvents.push(event)
        created++
      }

      // Distinguish "couldn't fit before the deadline" (normal) from "write failed" (error)
      // so the AI reports honestly instead of claiming sessions that don't exist.
      const noRoom = Math.max(0, sessionsNeeded - slots.length)
      return {
        success: writeErrors === 0,
        sessions_created: created,
        sessions_needed: sessionsNeeded,
        sessions_unscheduled: sessionsNeeded - created,
        ...(noRoom > 0 ? { warning: `Only ${slots.length} of ${sessionsNeeded} sessions fit before the deadline — ${noRoom} could not be placed. Tell the user and suggest extending the deadline or freeing time.` } : {}),
        ...(writeErrors > 0 ? { error: 'write_failed', message: `${writeErrors} session(s) failed to save. Do NOT claim those were scheduled.` } : {}),
      }
    }

    case 'list_events': {
      const { from_date, to_date } = input as { from_date: string; to_date: string }
      const filtered = currentEvents.filter(e => {
        const start = new Date(e.start_time)
        return start >= new Date(from_date) && start <= new Date(to_date)
      })

      // Group recurring events by series_id so AI understands them as series, not individual instances
      const seriesMap: Record<string, { title: string; instances: string[]; mobility_type: string | undefined }> = {}
      const standalone: typeof filtered = []

      for (const e of filtered) {
        if (e.series_id) {
          if (!seriesMap[e.series_id]) {
            seriesMap[e.series_id] = { title: e.title, instances: [], mobility_type: e.mobility_type }
          }
          seriesMap[e.series_id].instances.push(e.id)
        } else {
          standalone.push(e)
        }
      }

      // Helper: strip lab/tutorial prefixes to find the base course name
      const baseCourse = (title: string) =>
        title.replace(/^(מעבדה ל|תרגול ל|תרגיל ל|lab for |tutorial for |lab |recitation )/i, '').trim()

      // Group series by base course name so AI understands lecture+lab+tutorial = one course
      const courseGroups: Record<string, string[]> = {}
      for (const [sid, s] of Object.entries(seriesMap)) {
        const base = baseCourse(s.title)
        if (!courseGroups[base]) courseGroups[base] = []
        courseGroups[base].push(sid)
      }

      const recurring_series = Object.entries(seriesMap).map(([series_id, s]) => ({
        series_id,
        title: s.title,
        base_course: baseCourse(s.title),
        instance_count: s.instances.length,
        instance_ids: s.instances,
        mobility_type: s.mobility_type ?? 'ask_first',
        note: 'Recurring series — use apply_to_series:true in update_event to update all instances at once',
      }))

      // Logical course list (lecture + lab + tutorial grouped under one course name)
      const logical_courses = Object.entries(courseGroups).map(([base, seriesIds]) => ({
        course_name: base,
        components: seriesIds.map(sid => ({ series_id: sid, title: seriesMap[sid].title, instance_count: seriesMap[sid].instances.length })),
        total_instances: seriesIds.reduce((n, sid) => n + seriesMap[sid].instances.length, 0),
        note: seriesIds.length > 1 ? `This course has ${seriesIds.length} components (e.g. lecture + lab). Hebrew number words in the title (אחד/שתיים/שלוש) are part of the course name, not arithmetic.` : undefined,
      }))

      return {
        events: standalone.map(e => ({ id: e.id, title: e.title, start: e.start_time, end: e.end_time, mobility_type: e.mobility_type ?? 'ask_first', series_id: e.series_id })),
        recurring_series,
        logical_courses,
        summary: `${standalone.length} standalone events, ${logical_courses.length} distinct courses (${recurring_series.length} series total, ${filtered.length - standalone.length} recurring instances)`,
      }
    }

    case 'analyze_schedule': {
      const { from_date, to_date } = input as { from_date: string; to_date: string }

      const rangeEvents = currentEvents
        .filter(e => {
          const start = new Date(e.start_time)
          return start >= new Date(from_date) && start <= new Date(to_date)
        })
        .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())

      // Group events by day
      const byDay: Record<string, CalendarEvent[]> = {}
      for (const ev of rangeEvents) {
        const day = format(new Date(ev.start_time), 'yyyy-MM-dd')
        if (!byDay[day]) byDay[day] = []
        byDay[day].push(ev)
      }

      const issues: string[] = []

      // Peak productivity hours from profile
      const peak = profile?.productivity_peak ?? 'morning'
      const peakStart = peak === 'morning' ? 6 : peak === 'afternoon' ? 12 : 18
      const peakEnd   = peak === 'morning' ? 12 : peak === 'afternoon' ? 18 : 23
      const sleepHour = parseHour(profile?.sleep_time, 23)
      // Active-day bounds (same source as getFreeSlots) — used to avoid midday-lunch
      // false positives for shift/night workers whose day doesn't span noon.
      // wake/sleep only — see the note on UserProfile.preferred_hours.
      const dayStartHour = parseHour(profile?.wake_time, 9)
      const dayEndHour = parseHour(profile?.sleep_time, 22)
      const hasMiddayWindow = dayStartHour <= 12 && dayEndHour >= 14
      const mob = (e: CalendarEvent) => e.mobility_type ?? classifyMobility(e.title, e.created_by, true)

      const dayStats: Array<{
        date: string
        dayOfWeek: string
        eventCount: number
        totalHours: number
        events: { id: string; title: string; start: string; end: string; color?: string }[]
      }> = []

      for (const [day, dayEvs] of Object.entries(byDay).sort()) {
        const totalMinutes = dayEvs.reduce((sum, e) =>
          sum + (new Date(e.end_time).getTime() - new Date(e.start_time).getTime()) / 60000, 0)
        const totalHours = Math.round(totalMinutes / 6) / 10

        dayStats.push({
          date: day,
          dayOfWeek: format(new Date(day), 'EEEE'),
          eventCount: dayEvs.length,
          totalHours,
          events: dayEvs.map(e => ({ id: e.id, title: e.title, start: e.start_time, end: e.end_time, color: e.color, mobility_type: e.mobility_type ?? 'ask_first' })),
        })

        // 1. Back-to-back events (< 15 min gap) — only worth flagging if at least one
        //    is movable. Two fixed events (lecture+lab) can't be spaced, so don't nag.
        for (let i = 0; i < dayEvs.length - 1; i++) {
          const gapMin = (new Date(dayEvs[i + 1].start_time).getTime() - new Date(dayEvs[i].end_time).getTime()) / 60000
          const movable = mob(dayEvs[i]) !== 'fixed' || mob(dayEvs[i + 1]) !== 'fixed'
          if (gapMin >= 0 && gapMin < 15 && movable) {
            issues.push(`BACK_TO_BACK: "${dayEvs[i].title}" and "${dayEvs[i + 1].title}" on ${day} — only ${Math.round(gapMin)} min gap, no buffer time`)
          }
        }

        // 2. No lunch break on a busy day (3+ events, nothing free 12:00–13:30).
        //    Skip entirely for shift/night schedules whose active window misses midday.
        if (dayEvs.length >= 3 && hasMiddayWindow) {
          const lunchStart = new Date(`${day}T12:00:00`)
          const lunchEnd   = new Date(`${day}T13:30:00`)
          const blocksLunch = dayEvs.some(e =>
            new Date(e.start_time) < lunchEnd && new Date(e.end_time) > lunchStart
          )
          if (blocksLunch) {
            issues.push(`NO_LUNCH: Busy day on ${day} (${dayEvs.length} events) with no free time between 12:00–13:30`)
          }
        }

        // 3. Overloaded day (> 6 hours scheduled)
        if (totalHours > 6) {
          issues.push(`OVERLOADED: ${day} (${format(new Date(day), 'EEEE')}) has ${totalHours}h of scheduled events`)
        }

        // 4. Late-night study or work (after sleepHour - 1)
        for (const ev of dayEvs) {
          const startHour = new Date(ev.start_time).getHours()
          const isStudyOrWork = ev.color === '#6366F1' ||
            /study|exam|homework|work|project|לימוד|מבחן|עבודה|שיעורי|תרגיל/i.test(ev.title)
          if (startHour >= sleepHour - 1 && isStudyOrWork) {
            issues.push(`LATE_NIGHT: "${ev.title}" on ${day} starts at ${format(new Date(ev.start_time), 'HH:mm')} — very close to sleep time (${profile?.sleep_time ?? '23:00'})`)
          }
        }

        // 5. Important event (exam/presentation) with no prep in the 3 days leading up.
        //    Checking only the day-before caused false "no prep" alerts when the user
        //    studied 2–3 days earlier.
        for (const ev of dayEvs) {
          const isImportant = /exam|test|presentation|מבחן|מצגת|הגשה|deadline/i.test(ev.title)
          if (isImportant) {
            const prepRe = /study|prep|review|practice|לימוד|חזרה|תרגול|הכנה/i
            const hasPrep = [1, 2, 3].some(d => {
              const prepDay = format(addDays(new Date(day), -d), 'yyyy-MM-dd')
              return byDay[prepDay]?.some(pe => prepRe.test(pe.title))
            })
            if (!hasPrep) {
              issues.push(`NO_PREP: "${ev.title}" on ${day} — no study/prep session found in the 3 days before`)
            }
          }
        }

        // 6. Important tasks scheduled outside peak productivity hours
        for (const ev of dayEvs) {
          const startHour = new Date(ev.start_time).getHours()
          const isImportantTask = ev.color === '#6366F1' ||
            /study|exam|project|work meeting|לימוד|מבחן|פרויקט/i.test(ev.title)
          if (isImportantTask && (startHour < peakStart || startHour >= peakEnd)) {
            issues.push(`OFF_PEAK: "${ev.title}" on ${day} starts at ${format(new Date(ev.start_time), 'HH:mm')} — outside your peak productivity (${peak}: ${peakStart}:00–${peakEnd}:00)`)
          }
        }
      }

      // 7. Overloaded day next to an empty day
      const sortedDays = dayStats.sort((a, b) => a.date.localeCompare(b.date))
      for (let i = 0; i < sortedDays.length - 1; i++) {
        const curr = sortedDays[i]
        const next = sortedDays[i + 1]
        const diff = (new Date(next.date).getTime() - new Date(curr.date).getTime()) / 86400000
        if (diff === 1 && curr.totalHours > 5 && next.totalHours < 1) {
          issues.push(`IMBALANCE: ${curr.date} (${curr.dayOfWeek}) is packed (${curr.totalHours}h) but ${next.date} (${next.dayOfWeek}) is nearly empty — could redistribute`)
        }
      }

      return {
        from: from_date,
        to: to_date,
        total_events: rangeEvents.length,
        days: dayStats,
        issues,
        mobility_summary: (() => {
          const fixedCount = rangeEvents.filter(e => (e.mobility_type ?? 'ask_first') === 'fixed').length
          const flexibleCount = rangeEvents.filter(e => e.mobility_type === 'flexible').length
          const askFirstCount = rangeEvents.length - fixedCount - flexibleCount
          return {
            fixed: fixedCount,
            flexible: flexibleCount,
            ask_first: askFirstCount,
            note: flexibleCount === 0
              ? 'ALL events are fixed or ask_first — nothing can be moved freely'
              : `${flexibleCount} events can be moved freely`,
          }
        })(),
        summary: issues.length === 0
          ? 'Schedule looks well-balanced — no major issues detected'
          : `Found ${issues.length} potential issue(s) to address`,
      }
    }

    case 'save_memory': {
      const { entries } = input as { entries: Array<{ key: string; value: string }> }
      if (!Array.isArray(entries) || entries.length === 0) {
        return { error: 'invalid_entries', message: 'entries must be a non-empty array' }
      }
      // Guard against runaway/oversized writes bloating memory.json
      for (const entry of entries) {
        if (!entry || typeof entry.key !== 'string' || typeof entry.value !== 'string') {
          return { error: 'invalid_entry', message: 'each entry needs string key and value' }
        }
        if (entry.key.length === 0 || entry.key.length > MEM_KEY_MAX) {
          return { error: 'key_length', message: `key must be 1–${MEM_KEY_MAX} chars` }
        }
        if (entry.value.length > MEM_VALUE_MAX) {
          return { error: 'value_too_large', message: `value must be ≤ ${MEM_VALUE_MAX} chars` }
        }
      }
      // Scope each fact to the current phase at WRITE time, so a fact learned now
      // is filed correctly even if the phase is never explicitly closed. The
      // category table decides by default; an explicit `scope` on the entry wins,
      // for the cases the table cannot know ("I only do this while I'm enlisted").
      // Unmatched keys stay timeless — losing a true fact is worse than keeping a
      // stale one. See lib/phases/scope.ts.
      const activePhaseId = phasesEnabled()
        ? (userStore.getActivePhase(userId)?.id ?? undefined)
        : undefined
      const scopeOverride = str((input as Record<string, unknown>).scope)

      const memHelper = (existing: AIMemory[]) => {
        for (const entry of entries) {
          const idx = existing.findIndex(m => m.key === entry.key)
          const scoped = scopeOverride === 'phase' ? true
            : scopeOverride === 'always' ? false
              : defaultScopeFor(entry.key) === 'phase'
          const item: AIMemory = {
            id: idx >= 0 ? existing[idx].id : crypto.randomUUID(),
            user_id: userId,
            key: entry.key,
            value: entry.value,
            learned_from: 'behavior',   // save_memory is only used in normal chat (onboarding uses complete_onboarding)
            // created_at is FIRST seen and is preserved on overwrite everywhere.
            created_at: idx >= 0 ? existing[idx].created_at : new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...(activePhaseId && scoped ? { phase_id: activePhaseId } : {}),
          }
          if (idx >= 0) existing[idx] = item
          else existing.push(item)
        }
        return existing
      }
      const memFile = memoryFile(userId)
      const updated = memHelper(readJsonFile<AIMemory[]>(memFile, []))
      writeJsonFileAtomic(memFile, updated)
      state.memoryUpdated = true
      return { success: true, saved: entries.length }
    }

    case 'delete_memory': {
      const { keys } = input as { keys: string[] }
      const memFile = memoryFile(userId)
      const filtered = readJsonFile<AIMemory[]>(memFile, []).filter(m => !keys.includes(m.key))
      writeJsonFileAtomic(memFile, filtered)
      return { success: true, deleted: keys.length }
    }

    case 'create_task': {
      const task: Task = {
        id: crypto.randomUUID(),
        user_id: userId,
        title: str(input.title),
        description: input.description ? str(input.description) : undefined,
        deadline: input.deadline ? str(input.deadline) : undefined,
        estimated_hours: input.estimated_hours ? num(input.estimated_hours) : undefined,
        priority: (['low', 'medium', 'high'].includes(str(input.priority)) ? str(input.priority) : 'medium') as Task['priority'],
        status: 'pending',
        topic: input.topic ? str(input.topic) : undefined,
        parent_task_id: input.parent_task_id ? str(input.parent_task_id) : undefined,
        created_at: new Date().toISOString(),
      }
      // project_id / depends_on exist as parameters only when PROJECTS is on
      // (PROJECTS_PARAMETER_EXTRAS in lib/ai/tools.ts). With the flag off, this
      // block never runs and create_task behaves byte-identically to before.
      if (projectsOn) {
        const projectId = str(input.project_id)
        if (projectId) {
          const project = userStore.getProjects(userId).find(p => p.id === projectId)
          // A project_id that does not resolve must not be dropped silently: that
          // is the exact bug this fixes, {success:true} with the task landing
          // outside the project, invisible on the board and uncounted in progress.
          if (!project) return { error: 'not_found', message: `No project with id ${projectId}` }
          task.project_id = project.id
        }
        if (Array.isArray(input.depends_on)) {
          // A task can never depend on itself (same rule depOrder.ts applies to
          // the engine's own input), so drop that id rather than deadlocking the
          // graph. task.id is freshly generated here, so this only matters if the
          // model somehow echoes it back, but it keeps the guard symmetric with
          // update_task below.
          const deps = (input.depends_on as unknown[]).filter((d): d is string => typeof d === 'string' && d !== task.id)
          if (deps.length) task.depends_on = deps
        }
      }
      userStore.addTask(task, userId)
      state.tasksUpdated = true
      return { success: true, task }
    }

    case 'update_task': {
      const taskId = str(input.task_id)
      const updates: Partial<Task> = {}
      if (input.title) updates.title = str(input.title)
      if (input.status) updates.status = str(input.status) as Task['status']
      if (input.priority) updates.priority = str(input.priority) as Task['priority']
      if (input.topic) updates.topic = str(input.topic)
      if (input.deadline) updates.deadline = str(input.deadline)
      if (input.estimated_hours) updates.estimated_hours = num(input.estimated_hours)

      // Same gate as create_task: project_id / depends_on are parameters only
      // when PROJECTS is on. Off, this is dead code and update_task is unchanged.
      if (projectsOn) {
        const projectId = str(input.project_id)
        if (projectId) {
          const project = userStore.getProjects(userId).find(p => p.id === projectId)
          if (!project) return { error: 'not_found', message: `No project with id ${projectId}` }
          updates.project_id = project.id
        }
        if (Array.isArray(input.depends_on)) {
          // Drop a self-reference rather than refusing the whole call: the same
          // treatment depOrder.ts gives the engine's own dependsOn input, since a
          // task depending on itself is always a data bug, never a real ordering.
          updates.depends_on = (input.depends_on as unknown[])
            .filter((d): d is string => typeof d === 'string' && d !== taskId)
        }
      }

      userStore.updateTask(taskId, updates, userId)
      state.tasksUpdated = true
      return { success: true }
    }

    case 'delete_task': {
      const taskId = str(input.task_id)
      userStore.deleteTask(taskId, userId)
      state.tasksUpdated = true
      return { success: true }
    }

    case 'list_tasks': {
      const { status, topic } = input as { status?: string; topic?: string }
      let tasks = userStore.getTasks(userId)
      if (status) tasks = tasks.filter(t => t.status === status)
      if (topic) tasks = tasks.filter(t => t.topic === topic)
      return { tasks }
    }

    case 'complete_onboarding': {
      const { profile_updates, memory_entries } = input as {
        profile_updates?: Partial<UserProfile>
        memory_entries?: Array<{ key: string; value: string }>
      }

      // Compute scheduling methods from persona+challenge+day_structure if provided
      const pu = profile_updates ?? {}
      if (pu.persona && pu.challenge && pu.day_structure) {
        const methodResult = mapToMethod(pu.persona, pu.challenge, pu.day_structure)
        pu.scheduling_method = methodResult.primary
        pu.secondary_methods = methodResult.secondary
        // Append method info to memory_entries so it survives cross-device
        const extraEntries: Array<{ key: string; value: string }> = [
          { key: 'persona_type', value: pu.persona },
          { key: 'main_challenge', value: pu.challenge },
          { key: 'day_structure', value: pu.day_structure },
          { key: 'scheduling_method', value: methodResult.primary },
          { key: 'secondary_methods', value: methodResult.secondary.join(', ') },
        ];
        if (memory_entries) {
          memory_entries.push(...extraEntries)
        } else {
          (input as Record<string, unknown>).memory_entries = extraEntries
        }
      }
      // No `else` that stamps a default. This branch used to write
      // `scheduling_method = 'time_blocking'` whenever the three inputs were
      // missing, which made a guess indistinguishable from a choice — and since
      // nothing else in the app ever collects persona/challenge/day_structure,
      // that guess was what essentially every user ended up scheduled by.
      // Leaving it unset is what lets MethodOnboardingModal fire and actually ask.
      // The "nagged forever" risk that justified the default is handled where it
      // belongs: skipping the modal now records `method_prompt_dismissed`.

      const safeId = assertSafeUserId(userId)
      // Save memory entries
      if (memory_entries?.length) {
        const memFile = path.join(DATA_DIR, 'users',safeId, 'memory.json')
        const existing = readJsonFile<AIMemory[]>(memFile, [])
        for (const entry of memory_entries) {
          const idx = existing.findIndex(m => m.key === entry.key)
          const item: AIMemory = {
            id: idx >= 0 ? existing[idx].id : crypto.randomUUID(),
            user_id: userId, key: entry.key, value: entry.value,
            learned_from: 'onboarding',
            created_at: idx >= 0 ? existing[idx].created_at : new Date().toISOString(),
          }
          if (idx >= 0) existing[idx] = item
          else existing.push(item)
        }
        writeJsonFileAtomic(memFile, existing)
      }
      // Update profile
      const profFile = path.join(DATA_DIR, 'users',safeId, 'profile.json')
      const existing = readJsonFile<UserProfile>(profFile,
        { user_id: userId, autonomy_mode: 'hybrid', theme: 'dark', language: 'en', onboarding_completed: false, productivity_peak: 'morning' })
      const updated: UserProfile = { ...existing, ...(profile_updates ?? {}), onboarding_completed: true, user_id: userId }
      writeJsonFileAtomic(profFile, updated)
      state.completedProfile = updated

      if (memory_entries?.length) state.memoryUpdated = true
      return { success: true }
    }

    case 'send_notification': {
      const { title, body } = input as { title: string; body: string }
      const payload = { title, body, url: '/app', tag: 'zman-message' }

      // Same channel order as the cron job (see api/cron/notifications). ntfy
      // leads because it is the only one that reaches a phone on this deployment.
      const topic = profile?.ntfy_topic || defaultTopicFor(userId)
      if (topic && isNtfyConfigured()) {
        // Unlike the two below, this one reports whether it landed — so the model
        // is told the truth instead of being handed success unconditionally.
        const delivered = await sendNtfy(topic, payload)
        return delivered
          ? { success: true, channel: 'ntfy' }
          : { success: false, reason: 'delivery_failed', message: 'The notification service rejected the message. Tell the user it did not go through.' }
      }

      if (fcmToken) {
        await sendFcmPush(fcmToken, payload)
        return { success: true, channel: 'fcm' }
      }
      if (pushSubscription) {
        await sendPush(pushSubscription, payload)
        return { success: true, channel: 'web-push' }
      }

      return { success: false, reason: 'no_delivery_channel', message: 'No notification channel is configured for this user, so nothing was sent. Say so plainly — do not claim a reminder was set.' }
    }

    case 'delete_all_events': {
      const allIds = currentEvents.map(e => e.id)
      for (const id of allIds) userStore.deleteEvent(id, userId)
      deletedEventIds.push(...allIds)
      return { success: true, deleted_count: allIds.length }
    }

    // ── Projects ────────────────────────────────────────────────────────────
    //
    // Decisions live in lib/ai/projectTools.ts and lib/projects/*; these arms are
    // storage glue only, the same split the engine tools already follow.

    case 'create_project': {
      const title = str(input.title).trim()
      if (!title) return { error: 'missing_required_fields', message: 'title is required' }
      const kind = (['course', 'deliverable', 'build'].includes(str(input.kind))
        ? str(input.kind) : 'build') as Project['kind']

      const project: Project = {
        id: crypto.randomUUID(),
        user_id: userId,
        title,
        kind,
        status: 'active',
        description: str(input.description) || undefined,
        deadline: str(input.deadline) || undefined,
        color: str(input.color) || undefined,
        topic: title,
        created_at: new Date().toISOString(),
      }
      userStore.addProject(project, userId)

      // `key` is caller-local: resolve it to real ids here so the model never has
      // to make N round trips just to express "step 3 needs step 2".
      const raw = Array.isArray(input.tasks) ? input.tasks as Record<string, unknown>[] : []
      const idByKey = new Map<string, string>()
      const created: Task[] = []
      for (const t of raw) {
        const tTitle = str(t.title).trim()
        if (!tTitle) continue
        const id = crypto.randomUUID()
        if (str(t.key)) idByKey.set(str(t.key), id)
        created.push({
          id,
          user_id: userId,
          title: tTitle,
          priority: (['low', 'medium', 'high'].includes(str(t.priority)) ? str(t.priority) : 'medium') as Task['priority'],
          status: 'pending',
          estimated_hours: typeof t.estimated_hours === 'number' && t.estimated_hours > 0 ? t.estimated_hours : undefined,
          deadline: str(t.deadline) || project.deadline,
          topic: project.topic,
          project_id: project.id,
          created_at: new Date().toISOString(),
        })
      }
      // Second pass, so a step may depend on one declared after it.
      created.forEach((task, i) => {
        const deps = Array.isArray(raw[i]?.depends_on) ? raw[i].depends_on as string[] : []
        const resolved = deps.map(k => idByKey.get(k)).filter((v): v is string => !!v)
        if (resolved.length) task.depends_on = resolved
        userStore.addTask(task, userId)
      })

      state.projectsUpdated = true
      if (created.length) state.tasksUpdated = true
      return {
        success: true,
        project: { id: project.id, title: project.title, kind: project.kind, deadline: project.deadline },
        tasks_created: created.length,
        tasks: created.map(t => ({ id: t.id, title: t.title, estimated_hours: t.estimated_hours })),
        next_step: sched?.isHe
          ? 'אם למשימות אין הערכת שעות — שאל את המשתמש, כי בלי זה אי אפשר לחשב סיכון עמידה ביעד.'
          : 'If tasks have no estimated_hours, ask the user — deadline risk cannot be computed without them.',
      }
    }

    case 'list_projects': {
      const wanted = str(input.status)
      const all = userStore.getProjects(userId)
      const filtered = wanted ? all.filter(p => p.status === wanted) : all.filter(p => p.status === 'active')
      const allTasks = userStore.getTasks(userId)
      const nowLocal = resolveNow(now, sched?.timezone || profile?.timezone)

      // Health is computed here rather than left to the model: the risk number is
      // the engine's answer, and the model's job is to paraphrase it.
      const probeInputs = []
      const factsById = new Map<string, ReturnType<typeof computeFacts>>()
      for (const p of filtered) {
        const f = computeFacts(p, allTasks, currentEvents, nowLocal)
        factsById.set(p.id, f)
        const pi = probeInputFor(p, f)
        if (pi) probeInputs.push(pi)
      }

      let probe = new Map<string, ProjectProbeResult>()
      if (probeInputs.length) {
        try {
          const horizon = probeInputs.reduce((m, i) => Math.max(m, horizonDaysFor(nowLocal, i.deadline)), 14)
          const ctx = buildSchedulingContext(
            profile, currentEvents, sched?.memory, sched?.feedback, sched?.timezone, now, horizon,
            sched?.closedPhaseIds,
          )
          probe = probeCapacity(ctx, probeInputs, !!sched?.isHe)
        } catch (err) {
          console.error('[chat] project capacity probe failed:', err)
        }
      }

      const method = resolveMethod(profile).primary
      return {
        projects: filtered.map(p => ({
          id: p.id,
          title: p.title,
          kind: p.kind,
          status: p.status,
          deadline: p.deadline,
          tasks_open: factsById.get(p.id)?.openLeafTasks.length ?? 0,
          tasks_total: factsById.get(p.id)?.totalLeafCount ?? 0,
          signals: resolveSignals(p, allTasks, currentEvents, probe.get(p.id), method, nowLocal)
            .map(s => ({ signal: s.signal, state: s.state, text: sched?.isHe ? s.text.he : s.text.en, code: s.code })),
        })),
        next_step: sched?.isHe
          ? 'הסתמך על signals כפי שהם. אל תחשב בעצמך אם משהו נכנס בזמן — זו התשובה של מנוע התזמון.'
          : 'Use `signals` as given. Do not work out for yourself whether something fits — that is the engine\'s answer.',
      }
    }

    case 'update_project': {
      const id = str(input.project_id)
      if (!id) return { error: 'missing_required_fields', message: 'project_id is required' }
      const updates: Partial<Project> = {}
      if (str(input.title)) updates.title = str(input.title)
      if (str(input.description)) updates.description = str(input.description)
      if (str(input.color)) updates.color = str(input.color)
      if (str(input.deadline)) updates.deadline = str(input.deadline)
      if (['active', 'paused', 'done', 'archived'].includes(str(input.status))) {
        updates.status = str(input.status) as Project['status']
        if (updates.status === 'done') updates.completed_at = new Date().toISOString()
        if (updates.status === 'archived') updates.archived_at = new Date().toISOString()
      }
      const updated = userStore.updateProject(id, updates, userId)
      if (!updated) return { error: 'not_found', message: `No project with id ${id}` }
      state.projectsUpdated = true
      return { success: true, project: { id: updated.id, title: updated.title, status: updated.status } }
    }

    case 'delete_project': {
      const id = str(input.project_id)
      if (!id) return { error: 'missing_required_fields', message: 'project_id is required' }
      const project = userStore.getProjects(userId).find(p => p.id === id)
      if (!project) return { error: 'not_found', message: `No project with id ${id}` }

      const mode = bool(input.delete_tasks) ? 'cascade' : 'detach'
      const plan = planProjectDeletion(project, userStore.getTasks(userId), currentEvents, mode)
      for (const taskId of plan.deleteTaskIds) userStore.deleteTask(taskId, userId)
      for (const taskId of plan.detachTaskIds) userStore.updateTask(taskId, { project_id: undefined }, userId)
      userStore.deleteProject(id, userId)

      state.projectsUpdated = true
      state.tasksUpdated = true
      return {
        success: true,
        deleted_tasks: plan.deleteTaskIds.length,
        detached_tasks: plan.detachTaskIds.length,
        calendar_blocks_kept: plan.untouchedEvents,
        message: plan.untouchedEvents > 0
          ? `${plan.untouchedEvents} calendar block(s) were left in place — deleting a project never clears the calendar. Tell the user, and offer to remove them separately if that is what they wanted.`
          : undefined,
      }
    }

    case 'plan_project': {
      // Needs BOTH flags: the proposal it returns can only be committed by
      // apply_plan, which is V2-only.
      if (!sched?.enabled) {
        return { error: 'unknown_tool', message: 'Unknown tool: plan_project' }
      }
      const id = str(input.project_id)
      if (!id) return { error: 'missing_required_fields', message: 'project_id is required' }
      const project = userStore.getProjects(userId).find(p => p.id === id)
      if (!project) return { error: 'not_found', message: `No project with id ${id}` }

      const onlyIds = Array.isArray(input.only_task_ids)
        ? (input.only_task_ids as unknown[]).filter((v): v is string => typeof v === 'string')
        : undefined

      const build = buildProjectPlanSpec(project, userStore.getTasks(userId), profile, sched, onlyIds)

      if (build.cycle) {
        return {
          error: 'circular_dependency',
          message: sched.isHe
            ? `יש תלות מעגלית בין "${build.cycle.a}" ל-"${build.cycle.b}" — תקן אותה ואז נתכנן.`
            : `"${build.cycle.a}" and "${build.cycle.b}" depend on each other — fix that first, then we can plan.`,
        }
      }
      if (!build.spec) {
        return { error: 'nothing_to_plan', message: build.error, skipped: build.skipped }
      }

      const result = proposePlan(userId, [...currentEvents, ...createdEvents], profile, sched, now, build.spec)
      return {
        ...result.toolResult,
        ...(build.skipped.length ? { skipped: build.skipped } : {}),
      }
    }

    // ── Phases ──────────────────────────────────────────────────────────────

    case 'list_phases': {
      const all = userStore.getPhases(userId)
      const wanted = bool(input.include_closed) ? all : all.filter(p => p.status === 'active')
      return {
        phases: wanted.map(p => ({
          id: p.id, label: p.label, slug: p.slug, status: p.status,
          started_at: p.started_at, ended_at: p.ended_at, summary: p.summary,
        })),
        next_step: sched?.isHe
          ? 'אם המשתמש חוזר לתקופה מסוג שכבר היה — השתמש ב-slug הקיים ב-start_phase, אחרת ההגדרות והעובדות הישנות לא יחזרו.'
          : 'If the user is returning to a kind of period they had before, pass that existing slug to start_phase — otherwise their old settings and facts will not come back.',
      }
    }

    case 'start_phase': {
      const label = str(input.label).trim()
      if (!label) return { error: 'missing_required_fields', message: 'label is required' }

      const all = userStore.getPhases(userId)
      const previous = all.find(p => p.status === 'active') ?? null
      const today = localDayKey(now)
      const slug = (str(input.slug).trim() || slugify(label))
      const resumed = all.find(p => p.status === 'closed' && p.slug === slug) ?? null

      // Close the previous phase FIRST, atomically with the open. There is no
      // separate close_phase tool on purpose: two tools would let the model open a
      // phase without closing the old one, and two active phases makes the memory
      // phase-filter meaningless.
      const retiredSeries: NonNullable<Phase['retired_series']> = []
      if (previous) {
        // Stamp the outgoing phase onto its unstamped, phase-scoped facts.
        const memFile = path.join(DATA_DIR, 'users', assertSafeUserId(userId), 'memory.json')
        const rows = readJsonFile<AIMemory[]>(memFile, [])
        let stamped = 0
        for (const m of rows) {
          if (!m.phase_id && defaultScopeFor(m.key) === 'phase') { m.phase_id = previous.id; stamped++ }
        }
        if (stamped > 0) writeJsonFileAtomic(memFile, rows)

        // Retire only the series the user actually named. No heuristic, no backfill.
        const ids = Array.isArray(input.retire_series_ids)
          ? (input.retire_series_ids as unknown[]).filter((v): v is string => typeof v === 'string')
          : []
        for (const eventId of ids) {
          const target = currentEvents.find(e => e.id === eventId || e.series_id === eventId)
          const sid = target?.series_id
          if (!sid) continue
          const plan = planSeriesRetirement(currentEvents, sid, today)
          for (const id of plan.deleteIds) { userStore.deleteEvent(id, userId); deletedEventIds.push(id) }
          retiredSeries.push({
            series_id: sid, title: target.title,
            weekday: '', hour: 0, last_kept: plan.lastKept ?? '',
          })
        }

        userStore.updatePhase(previous.id, {
          status: 'closed',
          ended_at: today,
          profile_snapshot: {
            wake_time: profile?.wake_time, sleep_time: profile?.sleep_time,
            productivity_peak: profile?.productivity_peak,
            schedule_weekend: profile?.schedule_weekend,
            occupation: profile?.occupation, day_structure: profile?.day_structure,
          },
          ...(retiredSeries.length ? { retired_series: retiredSeries } : {}),
        }, userId)
      }

      const phase: Phase = {
        id: crypto.randomUUID(),
        user_id: userId,
        label, slug,
        started_at: today,
        status: 'active',
        expected_end: str(input.expected_end) || undefined,
        summary: {
          priorities: str(input.priorities) || undefined,
          commitments: str(input.commitments) || undefined,
          hours: str(input.hours) || undefined,
        },
        created_at: new Date().toISOString(),
      }
      userStore.addPhase(phase, userId)

      // Restoring is a FILTER, not an insert: the old rows were never deleted, so
      // re-pointing them at the new phase makes them visible again.
      let restoredFacts = 0
      if (resumed) {
        const memFile = path.join(DATA_DIR, 'users', assertSafeUserId(userId), 'memory.json')
        const rows = readJsonFile<AIMemory[]>(memFile, [])
        for (const m of rows) {
          // Goals were in flight and are over. Resurrecting a four-month-old
          // "ongoing_task" is this feature's worst failure — it would make Zman
          // less trustworthy than the flat snapshot it replaces.
          if (m.phase_id === resumed.id && !isRestoreDenied(m.key)) { m.phase_id = phase.id; restoredFacts++ }
        }
        if (restoredFacts > 0) writeJsonFileAtomic(memFile, rows)
        if (resumed.profile_snapshot) {
          const snap = Object.fromEntries(
            Object.entries(resumed.profile_snapshot).filter(([, v]) => v !== undefined),
          )
          if (Object.keys(snap).length) applyProfilePatch(userId, snap as Partial<UserProfile>)
        }
      }

      state.memoryUpdated = true
      return {
        success: true,
        phase: { id: phase.id, label: phase.label, slug: phase.slug, started_at: phase.started_at },
        closed_phase: previous ? { label: previous.label, ended_at: today } : null,
        resumed_from: resumed ? { label: resumed.label, restored_facts: restoredFacts } : null,
        retired_series: retiredSeries.length,
        interview: resumed
          ? (sched?.isHe
              ? ['החזרתי את ההגדרות והעובדות מהתקופה הקודמת מאותו סוג. שאל רק: מה השתנה הפעם?']
              : ['Settings and facts from the previous period of this kind are restored. Ask only: what changed this time?'])
          : (sched?.isHe
              ? [
                  'מתי אתה זמין עכשיו? (שעות/משמרות) — ואם זה השתנה, קרא ל-update_profile',
                  'מה הכי חשוב לך בתקופה הזאת?',
                  'מה חוזר לך כל שבוע? (משמרות, הרצאות, בסיס)',
                ]
              : [
                  'What are your hours now? If they changed, call update_profile',
                  'What matters most in this period?',
                  'What recurs weekly?',
                ]),
        next_step: sched?.isHe
          ? 'שאל לכל היותר את השאלות שלמעלה, ואז עדכן עם save_memory / update_profile. אל תמציא עובדות על התקופה החדשה.'
          : 'Ask at most the questions above, then record answers with save_memory / update_profile. Do not invent facts about the new phase.',
      }
    }

    case 'update_profile': {
      // Deny-list by construction: only these keys are readable off `input`.
      // autonomy_mode is the user's consent setting and must never be writable by
      // the model; scheduling_method has a Settings control and drives the projects
      // board, so a silent rewrite would fight visible UI.
      const patch: Partial<UserProfile> = {}
      if (str(input.wake_time)) patch.wake_time = str(input.wake_time)
      if (str(input.sleep_time)) patch.sleep_time = str(input.sleep_time)
      if (['morning', 'afternoon', 'evening'].includes(str(input.productivity_peak))) {
        patch.productivity_peak = str(input.productivity_peak) as UserProfile['productivity_peak']
      }
      if (['none', 'friday', 'both'].includes(str(input.schedule_weekend))) {
        patch.schedule_weekend = str(input.schedule_weekend) as UserProfile['schedule_weekend']
      }
      if (str(input.occupation)) patch.occupation = str(input.occupation)
      if (['fixed', 'variable', 'mixed', 'independent'].includes(str(input.day_structure))) {
        patch.day_structure = str(input.day_structure) as UserProfile['day_structure']
      }
      if (Object.keys(patch).length === 0) {
        return { error: 'nothing_to_update', message: 'No writable field was provided.' }
      }
      const updated = applyProfilePatch(userId, patch)
      state.memoryUpdated = true
      return {
        success: true,
        updated: Object.keys(patch),
        profile: { wake_time: updated.wake_time, sleep_time: updated.sleep_time, occupation: updated.occupation },
      }
    }

    case 'end_series': {
      const eventId = str(input.event_id)
      if (!eventId) return { error: 'missing_required_fields', message: 'event_id is required' }
      const target = currentEvents.find(e => e.id === eventId)
      if (!target) return { error: 'not_found', message: `No event with id ${eventId}` }
      if (!target.series_id) {
        return { error: 'not_a_series', message: 'That event is not part of a recurring series — use delete_event for a single event.' }
      }
      const from = str(input.from_date) || localDayKey(now)
      const plan = planSeriesRetirement(currentEvents, target.series_id, from)
      for (const id of plan.deleteIds) { userStore.deleteEvent(id, userId); deletedEventIds.push(id) }
      return {
        success: true,
        series_id: target.series_id,
        ended_from: from,
        removed_future: plan.deleteIds.length,
        kept_past: plan.keptPast,
        last_kept: plan.lastKept,
        message: sched?.isHe
          ? `הפסקתי את הסדרה מ-${from}. ${plan.keptPast} מופעים מהעבר נשמרו — ההיסטוריה לא נמחקה.`
          : `Series ended as of ${from}. ${plan.keptPast} past instances kept — the history is intact.`,
      }
    }

    // ── Places ──────────────────────────────────────────────────────────────
    //
    // Storage lives on userStore.{getPlaces,addPlace,updatePlace,deletePlace} —
    // this is glue only, the same split every other domain here follows.

    case 'save_place': {
      const placeId = str(input.place_id)
      const name = str(input.name).trim()
      const places = userStore.getPlaces(userId)
      const wantsHome = input.is_home === true

      if (placeId) {
        // ── Update: partial by design ─────────────────────────────────────
        const existing = places.find(p => p.id === placeId)
        if (!existing) return { error: 'not_found', message: `No place with id ${placeId}` }

        const updates: Partial<Place> = {}
        if (name) updates.name = name
        if (typeof input.prep_minutes === 'number') updates.prep_minutes = num(input.prep_minutes)
        if (typeof input.margin_minutes === 'number') updates.margin_minutes = num(input.margin_minutes)
        // MERGE, never replace — a partial update must not wipe travel pairs the
        // user declared in an earlier turn just because this turn only mentioned one.
        if (input.travel_from && typeof input.travel_from === 'object' && !Array.isArray(input.travel_from)) {
          updates.travel_from = { ...existing.travel_from, ...(input.travel_from as Record<string, number>) }
        }
        if (input.is_home === false) updates.is_home = false
        if (wantsHome) {
          updates.is_home = true
          // At most one place may be home — the previous one stops being home.
          const prevHome = places.find(p => p.is_home && p.id !== placeId)
          if (prevHome) userStore.updatePlace(prevHome.id, { is_home: false }, userId)
        }

        const updated = userStore.updatePlace(placeId, updates, userId)
        return { success: true, place: updated }
      }

      // ── Create ───────────────────────────────────────────────────────────
      if (!name) return { error: 'missing_required_fields', message: 'name is required to create a place' }
      const place: Place = {
        id: crypto.randomUUID(),
        user_id: userId,
        name,
        prep_minutes: typeof input.prep_minutes === 'number' ? num(input.prep_minutes) : 0,
        travel_from: (input.travel_from && typeof input.travel_from === 'object' && !Array.isArray(input.travel_from))
          ? { ...(input.travel_from as Record<string, number>) }
          : {},
        created_at: new Date().toISOString(),
        ...(typeof input.margin_minutes === 'number' ? { margin_minutes: num(input.margin_minutes) } : {}),
      }
      if (wantsHome) {
        place.is_home = true
        const prevHome = places.find(p => p.is_home)
        if (prevHome) userStore.updatePlace(prevHome.id, { is_home: false }, userId)
      }
      userStore.addPlace(place, userId)
      return { success: true, place }
    }

    case 'list_places': {
      const places = userStore.getPlaces(userId)
      return {
        places: places.map(p => ({
          id: p.id, name: p.name, is_home: !!p.is_home,
          prep_minutes: p.prep_minutes, travel_from: p.travel_from, margin_minutes: p.margin_minutes,
        })),
        next_step: sched?.isHe
          ? 'לפני שיוצרים מקום חדש עם save_place — בדוק כאן שהוא לא כבר קיים.'
          : 'Before creating a new place with save_place, check here that it does not already exist.',
      }
    }

    case 'delete_place': {
      const placeId = str(input.place_id)
      if (!placeId) return { error: 'missing_required_fields', message: 'place_id is required' }
      const removed = userStore.deletePlace(placeId, userId)
      if (!removed) return { error: 'not_found', message: `No place with id ${placeId}` }
      return { success: true }
    }

    default:
      return { error: `Unknown tool: ${toolName}` }
  }
}

/** 'YYYY-MM-DD' for a Date, in the user's local wall clock. */
function localDayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** snake_case identity for a phase label, so recurrences can match on it. */
function slugify(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^\w֐-׿]/g, '').slice(0, 40) || 'phase'
}

/**
 * Writes a whitelisted profile patch and mirrors it to memory, so the two cannot
 * drift — the same single-writer rule POST /api/profile follows.
 */
function applyProfilePatch(userId: string, patch: Partial<UserProfile>): UserProfile {
  const file = path.join(DATA_DIR, 'users', assertSafeUserId(userId), 'profile.json')
  const previous = readJsonFile<UserProfile>(file, { user_id: userId } as UserProfile)
  const merged: UserProfile = { ...previous, ...patch, user_id: userId }
  writeJsonFileAtomic(file, merged)
  mirrorProfileToMemory(userId, merged, Object.keys(patch) as (keyof UserProfile)[])
  return merged
}

// ─── SCHEDULER_V2 storage glue ────────────────────────────────────────────────
//
// The decisions live in lib/ai/schedulerTools.ts, which is pure and tested. What
// stays here is the part that touches storage: writing events, updating one, and
// recording the learning signal. Only reachable from a `sched?.enabled` branch.

/** One write path for engine-created events. */
async function persistEvent(event: CalendarEvent, userId: string): Promise<void> {
  userStore.addEvent(event, userId)
}

/** Applies the slot `planMove` chose, and records that the AI's original time was wrong. */
async function applyEngineMove(
  eventId: string,
  userId: string,
  currentEvents: CalendarEvent[],
  createdEvents: CalendarEvent[],
  updatedEvents: CalendarEvent[],
  profile: UserProfile | null,
  sched: SchedulerCtx,
  now: Date,
): Promise<unknown> {
  // Events created earlier in this same turn are part of the world too, or two
  // tool calls in one turn will book the same hour.
  const known = [...currentEvents, ...createdEvents]
  const decision = planMove(eventId, known, profile, sched, now)
  if (!decision.ok) return decision.toolResult

  const existing = known.find(e => e.id === eventId)!

  userStore.updateEvent(eventId, { start_time: decision.start, end_time: decision.end }, userId)

  if (existing.created_by === 'ai') {
    try {
      const oldStart = new Date(existing.start_time)
      recordFeedback(userId, {
        type: 'moved', title: existing.title,
        fromHour: oldStart.getHours(), toHour: Number(decision.start.slice(11, 13)),
        day: format(oldStart, 'EEE'), at: new Date().toISOString(),
      })
    } catch { /* a lost learning signal must not fail the move */ }
  }

  const updated = { ...existing, start_time: decision.start, end_time: decision.end }
  updatedEvents.push(updated)
  return { success: true, event: updated, moved_to: decision.view.blocks[0], why: decision.why }
}

/** Writes the instances `planRecurring` cleared, and reports every one it didn't. */
async function applyRecurringPlan(
  input: Record<string, unknown>,
  userId: string,
  currentEvents: CalendarEvent[],
  createdEvents: CalendarEvent[],
  profile: UserProfile | null,
  sched: SchedulerCtx,
  recurrence: { frequency?: string; count?: number; end_date?: string },
): Promise<unknown> {
  const known = [...currentEvents, ...createdEvents]
  const plan = planRecurring(input, known, profile, sched, recurrence)
  if (plan.error) return plan.error

  const seriesId = crypto.randomUUID()
  const writeErrors: string[] = []
  let created = 0

  for (const slot of plan.instances) {
    const instance: CalendarEvent = {
      id: crypto.randomUUID(),
      user_id: userId,
      title: String(input.title ?? ''),
      start_time: slot.start,
      end_time: slot.end,
      description: String(input.description ?? ''),
      color: String(input.color ?? '') || '#3B7EF7',
      source: 'zman',
      created_by: 'ai',
      status: 'confirmed',
      is_all_day: false,
      created_at: new Date().toISOString(),
      series_id: seriesId,
      recurrence_rule: recurrence.frequency,
      mobility_type: slot.mobility,
    }
    try {
      await persistEvent(instance, userId)
    } catch (err) {
      writeErrors.push(`${slot.start}: ${(err as Error)?.message}`)
      continue
    }
    createdEvents.push(instance)
    created++
  }

  return recurringToolResult(seriesId, created, plan, writeErrors)
}

// ─── Free slot calculator ─────────────────────────────────────────────────────

type FreeSlot = { start: string; end: string; duration_minutes: number; is_peak?: boolean }

/**
 * Pick `n` slots for a multi-session task, SPREAD across days instead of clustered.
 * - One session per day first; prefer the peak slot within each day.
 * - When there are more days than sessions, stride across them so sessions land on
 *   non-consecutive days (rest gaps), e.g. 3 sessions over 2 weeks → Mon/Wed/Fri-ish.
 * - Only stacks 2+ sessions on the same day when there aren't enough distinct days.
 * Always returns the chosen slots in chronological order.
 */
function pickSpreadSlots(slots: FreeSlot[], n: number): FreeSlot[] {
  if (n <= 0 || slots.length === 0) return []
  const byDay = new Map<string, FreeSlot[]>()
  for (const s of slots) {
    const day = s.start.slice(0, 10)
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day)!.push(s)
  }
  // Within a day: best slot first (peak before non-peak, then earliest).
  for (const arr of byDay.values()) {
    arr.sort((a, b) => (Number(b.is_peak) - Number(a.is_peak)) || (a.start < b.start ? -1 : 1))
  }
  const days = [...byDay.keys()].sort()
  const chosen: FreeSlot[] = []

  if (n <= days.length) {
    // Enough distinct days → one per day, strided for rest gaps.
    const stride = Math.max(1, Math.floor(days.length / n))
    const picked = new Set<number>()
    for (let i = 0, d = 0; i < n && d < days.length; i++, d += stride) picked.add(d)
    for (let d = 0; picked.size < n && d < days.length; d++) picked.add(d) // fill if rounding left gaps
    for (const d of [...picked].sort((a, b) => a - b).slice(0, n)) chosen.push(byDay.get(days[d])![0])
  } else {
    // More sessions than days → one per day, then a 2nd/3rd pass on earliest days.
    let r = 0
    while (chosen.length < n) {
      let added = false
      for (const day of days) {
        const slot = byDay.get(day)![r]
        if (slot) { chosen.push(slot); added = true; if (chosen.length >= n) break }
      }
      if (!added) break
      r++
    }
  }
  return chosen.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
}

function getFreeSlots(
  events: CalendarEvent[],
  fromDate: string,
  toDate: string,
  minMinutes: number,
  profile?: UserProfile | null,
  preferPeak = false,
  now: Date = new Date(),  // user-local now, so "today" / past-slot floor match the user's timezone
  limit = 20               // max candidate slots to return (break_down_task asks for more, to spread)
) {
  const slots: FreeSlot[] = []
  let cursor = parseISO(fromDate)
  const to = parseISO(toDate)

  // Determine day bounds from profile
  // wake/sleep only — see the note on UserProfile.preferred_hours.
  const dayStartHour = parseHour(profile?.wake_time, 9)
  const dayEndHour = parseHour(profile?.sleep_time, 22)

  // Peak productivity window
  const peak = profile?.productivity_peak ?? 'morning'
  const peakStart = peak === 'morning' ? 6 : peak === 'afternoon' ? 12 : 18
  const peakEnd   = peak === 'morning' ? 12 : peak === 'afternoon' ? 18 : 23

  cursor.setHours(dayStartHour, 0, 0, 0)

  while (cursor < to) {
    const dayEnd = new Date(cursor)
    dayEnd.setHours(dayEndHour, 0, 0, 0)

    const dayEvents = events
      .filter(e => {
        const s = new Date(e.start_time)
        return s >= startOfDay(cursor) && s <= endOfDay(cursor)
      })
      .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())

    // On the current day, never start a slot in the past — use now as the floor
    const nowTs = now
    let slotStart = (cursor.toDateString() === nowTs.toDateString() && nowTs > cursor)
      ? new Date(nowTs)
      : new Date(cursor)
    for (const ev of dayEvents) {
      const evStart = new Date(ev.start_time)
      const evEnd = new Date(ev.end_time)
      if (evStart > slotStart) {
        const dMin = (evStart.getTime() - slotStart.getTime()) / 60000
        if (dMin >= minMinutes) {
          const h = slotStart.getHours()
          slots.push({
            start: format(slotStart, "yyyy-MM-dd'T'HH:mm:ss"),
            end: format(evStart, "yyyy-MM-dd'T'HH:mm:ss"),
            duration_minutes: Math.floor(dMin),
            is_peak: h >= peakStart && h < peakEnd,
          })
        }
      }
      if (evEnd > slotStart) slotStart = evEnd
    }

    if (slotStart < dayEnd) {
      const dMin = (dayEnd.getTime() - slotStart.getTime()) / 60000
      if (dMin >= minMinutes) {
        const h = slotStart.getHours()
        slots.push({
          start: format(slotStart, "yyyy-MM-dd'T'HH:mm:ss"),
          end: format(dayEnd, "yyyy-MM-dd'T'HH:mm:ss"),
          duration_minutes: Math.floor(dMin),
          is_peak: h >= peakStart && h < peakEnd,
        })
      }
    }

    cursor = addHours(startOfDay(cursor), 24)
    cursor.setHours(dayStartHour, 0, 0, 0)
  }

  const result = slots.slice(0, limit)

  // If preferPeak, surface peak slots first — but keep each group in chronological
  // order so callers that take the first N don't get times out of sequence.
  if (preferPeak) {
    return [
      ...result.filter(s => s.is_peak),
      ...result.filter(s => !s.is_peak),
    ]
  }

  return result
}
