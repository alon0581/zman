/**
 * travel.ts — how much time to hold open around an event the user has to
 * physically get to.
 *
 * The scheduling engine already knows WHEN the user is free (windows.ts,
 * timeline.ts); it has never known WHERE the user is, so it would happily end
 * a study block at 09:00 and start a lecture across town at 09:00. This module
 * closes that, but only as a pre-pass: it hands the engine two numbers per
 * event (`lead`, `trail`) and does not itself touch a block, a score or a
 * BusyBlock. Wiring those numbers into timeline.ts/place.ts is a separate
 * change, deliberately not made here.
 *
 * PURE, same contract as the scheduling engine (see CLAUDE.md): no fs, no
 * fetch, no `process.env`, no `new Date()`. Every place number here is
 * user-declared (see Place's own doc comment in src/types/index.ts) — this
 * file only ever combines declared numbers, never measures or guesses one.
 */

import type { CalendarEvent, Place } from '@/types'
import { localDateKey, minutesBetween } from '@/lib/scheduling/clock'

/**
 * Default safety margin added on top of prep + travel, when a place doesn't
 * declare its own. Matches what Place.margin_minutes documents on the type
 * ("Defaults to TRAVEL_MARGIN_MINUTES") — that comment and this constant have
 * to agree by hand, since nothing enforces it structurally.
 */
export const TRAVEL_MARGIN_MINUTES = 10

/**
 * How large a gap between two events on the same day has to be before the
 * ORIGIN resets to home instead of staying at the previous event's place.
 *
 * Chosen, not measured — like every number in this module, this has no
 * check-in or location signal to fit a value from, so it has to be a stated
 * policy. 180 minutes (3 hours): below it, going home and coming back rarely
 * pays for itself once the round-trip commute is subtracted from the gap — a
 * student with 90 minutes between two lectures is far more likely to stay on
 * campus (library, coffee) than to make two commutes to save an hour and a
 * half at home. Above it, home is the more plausible place to have gone than
 * lingering wherever the previous event was.
 */
export const HOME_RESET_GAP_MINUTES = 180

export interface TravelWindow {
  /** Minutes to hold open BEFORE the event: prep + travel-in + margin. */
  lead: number
  /** Minutes to hold open AFTER the event: travel-out only, no prep, no margin. */
  trail: number
}

/**
 * Computes a travel-aware lead/trail window for every event that has a
 * resolvable place, keyed by event id.
 *
 * An event is absent from the returned Map — not present with zeros — when
 * NEITHER side could be computed at all (no place_id, an unresolved
 * place_id, or an unknown pair with no from-home fallback either). That is
 * the literal "the day must behave exactly as it did before places existed"
 * rule: before this module existed there was no entry for any event, so
 * "no evidence" has to render as "no entry", not as a confident-looking zero.
 * When only one side is computable, the entry is still present with the
 * other side at 0 — a genuinely known "no travel needed" (e.g. two
 * back-to-back events at the same place) is a real zero, not an absence.
 */
export function computeTravelWindows(
  events: CalendarEvent[],
  places: Place[],
  opts?: { homeId?: string },
): Map<string, TravelWindow> {
  const result = new Map<string, TravelWindow>()

  const placesById = new Map(places.map(p => [p.id, p]))
  const homePlace = opts?.homeId !== undefined
    ? placesById.get(opts.homeId)
    : places.find(p => p.is_home)

  // Group by calendar day. All-day events are dropped here, not filtered
  // later — see the "all-day" note below for why they must not even act as
  // an anchor for a neighbouring timed event's gap calculation.
  const byDay = new Map<string, CalendarEvent[]>()
  for (const ev of events) {
    if (ev.is_all_day) continue
    const day = localDateKey(ev.start_time)
    const list = byDay.get(day)
    if (list) list.push(ev)
    else byDay.set(day, [ev])
  }

  // Days are visited in sorted key order, and each day's events are sorted
  // below by (start_time, id) rather than left in whatever order the caller's
  // array happened to have them. Nothing here should depend on input order —
  // the same calendar must produce the same windows regardless of how the
  // caller assembled `events`, which is also what the shuffle test pins.
  for (const day of Array.from(byDay.keys()).sort()) {
    const sorted = byDay.get(day)!.sort((a, b) => {
      if (a.start_time !== b.start_time) return a.start_time < b.start_time ? -1 : 1
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })

    for (let i = 0; i < sorted.length; i++) {
      const ev = sorted[i]
      if (!ev.place_id) continue
      const place = placesById.get(ev.place_id)
      if (!place) continue

      const origin = neighbourPlace(sorted, i, -1, homePlace, placesById)
      const next = neighbourPlace(sorted, i, +1, homePlace, placesById)

      const travelIn = travelBetween(origin, place, homePlace)
      const travelOut = travelBetween(place, next, homePlace)

      if (travelIn === undefined && travelOut === undefined) continue

      const margin = place.margin_minutes ?? TRAVEL_MARGIN_MINUTES

      // Already here ⇒ nothing to hold open at all, and that means prep and
      // margin go too, not just the travel.
      //
      // The case is two back-to-back shifts at the same place with half an hour
      // between them. That half hour is genuinely free — it is when the user
      // eats — and prep is "how long it takes to get READY to leave for here",
      // which was already spent before the first shift. Charging it again would
      // block the only gap in a ten-hour day, and would do it invisibly, since a
      // travel window is deliberately never drawn on the calendar.
      const alreadyThere = origin !== undefined && origin.id === place.id
      const lead = travelIn === undefined || alreadyThere
        ? 0
        : place.prep_minutes + travelIn + margin
      // No prep, no margin — you do not get ready to leave work. Trail is
      // travel only, so an unresolvable travelOut degrades to 0, same as an
      // unresolvable travelIn degrades lead to 0.
      const trail = travelOut === undefined ? 0 : travelOut

      result.set(ev.id, { lead, trail })
    }
  }

  return result
}

/**
 * The place the user is coming from (dir -1) or heading to next (dir +1),
 * relative to `sorted[i]`.
 *
 * Both directions share one rule, applied symmetrically: no neighbouring
 * event that day, an neighbour whose place can't be resolved, or a gap of
 * HOME_RESET_GAP_MINUTES or more all mean "assume home" — we have no
 * location signal beyond the calendar itself, and home is the only default
 * that doesn't require guessing which OTHER place the user might be at.
 * Only a near neighbour with a resolvable place overrides that default.
 */
function neighbourPlace(
  sorted: CalendarEvent[],
  i: number,
  dir: -1 | 1,
  homePlace: Place | undefined,
  placesById: Map<string, Place>,
): Place | undefined {
  const neighbour = sorted[i + dir]
  if (!neighbour) return homePlace
  const resolvedPlace = neighbour.place_id ? placesById.get(neighbour.place_id) : undefined
  if (!resolvedPlace) return homePlace

  const gap = dir === -1
    ? minutesBetween(neighbour.end_time, sorted[i].start_time)
    : minutesBetween(sorted[i].end_time, neighbour.start_time)
  if (gap >= HOME_RESET_GAP_MINUTES) return homePlace
  return resolvedPlace
}

/**
 * Minutes to travel from `origin` to `destination`, or undefined when that
 * cannot be determined at all.
 *
 * Two consecutive events at the same place are a real case (a user working
 * back-to-back shifts at one location) and get a real, known zero — checked
 * first, and deliberately not folded into the travel_from lookup below, so
 * it can never be shadowed by a stale or missing entry for a place's own id.
 * Otherwise: the declared origin->destination minutes if present, else the
 * declared home->destination minutes (Place.travel_from's own documented
 * fallback), else undefined — there is nothing left to guess with.
 */
function travelBetween(
  origin: Place | undefined,
  destination: Place | undefined,
  homePlace: Place | undefined,
): number | undefined {
  if (!origin || !destination) return undefined
  if (origin.id === destination.id) return 0

  const direct = destination.travel_from[origin.id]
  if (direct !== undefined) return direct

  if (homePlace) {
    const fromHome = destination.travel_from[homePlace.id]
    if (fromHome !== undefined) return fromHome
  }

  return undefined
}
