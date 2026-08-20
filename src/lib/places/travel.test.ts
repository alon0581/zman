import { describe, it, expect } from 'vitest'
import type { CalendarEvent, Place } from '@/types'
import { computeTravelWindows, HOME_RESET_GAP_MINUTES, TRAVEL_MARGIN_MINUTES } from './travel'

// ── Fixture factories ────────────────────────────────────────────────────────
//
// Every test below builds its own places/events rather than sharing module-level
// fixtures, so a number changed for one test can never silently shift another.

function place(overrides: Partial<Place> & { id: string }): Place {
  return {
    id: overrides.id,
    user_id: 'u1',
    name: overrides.name ?? overrides.id,
    is_home: overrides.is_home,
    prep_minutes: overrides.prep_minutes ?? 0,
    travel_from: overrides.travel_from ?? {},
    margin_minutes: overrides.margin_minutes,
    created_at: '2026-01-01T00:00:00',
  }
}

function event(overrides: Partial<CalendarEvent> & { id: string; start_time: string; end_time: string }): CalendarEvent {
  return {
    id: overrides.id,
    user_id: 'u1',
    title: overrides.title ?? overrides.id,
    start_time: overrides.start_time,
    end_time: overrides.end_time,
    is_all_day: overrides.is_all_day ?? false,
    source: 'zman',
    created_by: 'user',
    status: 'confirmed',
    created_at: '2026-01-01T00:00:00',
    place_id: overrides.place_id,
  }
}

describe('computeTravelWindows', () => {
  // The trail used to be asserted as 0 here, because the fixture's home declares
  // no return-from-work time — which is exactly what a real user declares, since
  // nobody says the return leg out loud. That made this test a description of the
  // gap rather than of the behaviour: the trip home was unprotected. The pair is
  // now read backwards when the forward direction is missing, so the journey home
  // is guarded by the same 20 minutes.
  it('1. a single event away from home is guarded on BOTH sides', () => {
    const home = place({ id: 'home', is_home: true })
    const work = place({ id: 'work', prep_minutes: 15, travel_from: { home: 20 } })
    const events = [event({ id: 'e1', place_id: 'work', start_time: '2026-08-19T09:00:00', end_time: '2026-08-19T10:00:00' })]

    const windows = computeTravelWindows(events, [home, work])

    expect(windows.get('e1')).toEqual({ lead: 15 + 20 + TRAVEL_MARGIN_MINUTES, trail: 20 })
  })

  // This test used to assert `prep + margin` on the second shift, on the reading
  // that only the TRAVEL component is zero when you are already somewhere. That
  // is wrong, and wrong in the one case the feature was asked for: the half hour
  // between two shifts is the only break in a ten-hour day, prep is "how long it
  // takes to get ready to leave FOR here" and was already spent before the first
  // shift, and the window is never drawn on the calendar — so charging it again
  // would silently swallow the only gap the user has.
  it('2. two consecutive events at the same place need nothing held open at all', () => {
    const home = place({ id: 'home', is_home: true })
    const work = place({ id: 'work', prep_minutes: 15, travel_from: { home: 20 } })
    const events = [
      event({ id: 'shift1', place_id: 'work', start_time: '2026-08-19T09:00:00', end_time: '2026-08-19T12:00:00' }),
      // 30 minutes between shifts, same place — no commute should be invented.
      event({ id: 'shift2', place_id: 'work', start_time: '2026-08-19T12:30:00', end_time: '2026-08-19T15:00:00' }),
    ]

    const windows = computeTravelWindows(events, [home, work])

    // trail of the first shift: zero travel to the second shift, same place.
    expect(windows.get('shift1')!.trail).toBe(0)
    // lead of the second shift: nothing — no travel, and no prep either.
    expect(windows.get('shift2')!.lead).toBe(0)
    // The first shift is still travelled to normally, so this is not a blanket
    // "same place means no windows anywhere" regression.
    expect(windows.get('shift1')!.lead).toBe(15 + 20 + TRAVEL_MARGIN_MINUTES)
  })

  it('3. two consecutive events at different places: origin is the FIRST event\'s place, not home', () => {
    const home = place({ id: 'home', is_home: true })
    const work = place({ id: 'work', prep_minutes: 0, travel_from: { home: 20 } })
    // Deliberately different travel times from work (25) vs from home (10), so a
    // wrong origin produces a visibly wrong number.
    const gym = place({ id: 'gym', prep_minutes: 5, margin_minutes: 5, travel_from: { home: 10, work: 25 } })
    const events = [
      event({ id: 'work1', place_id: 'work', start_time: '2026-08-19T09:00:00', end_time: '2026-08-19T12:00:00' }),
      // 30 minutes later, well under HOME_RESET_GAP_MINUTES.
      event({ id: 'gym1', place_id: 'gym', start_time: '2026-08-19T12:30:00', end_time: '2026-08-19T13:30:00' }),
    ]

    const windows = computeTravelWindows(events, [home, work, gym])

    expect(windows.get('gym1')!.lead).toBe(5 + 25 + 5) // travel FROM WORK (25), not from home (10)
  })

  it('4. a large gap between two events resets the origin to home — threshold pinned', () => {
    const home = place({ id: 'home', is_home: true })
    const work = place({ id: 'work', prep_minutes: 0, travel_from: { home: 20 } })
    const gym = place({ id: 'gym', prep_minutes: 5, margin_minutes: 5, travel_from: { home: 10, work: 25 } })

    const gapMinutes = (mins: number) => {
      const startHour = 12
      const totalMinutes = startHour * 60 + mins
      const hh = String(Math.floor(totalMinutes / 60)).padStart(2, '0')
      const mm = String(totalMinutes % 60).padStart(2, '0')
      return `2026-08-19T${hh}:${mm}:00`
    }

    const justUnder = computeTravelWindows(
      [
        event({ id: 'work1', place_id: 'work', start_time: '2026-08-19T09:00:00', end_time: '2026-08-19T12:00:00' }),
        event({
          id: 'gym1', place_id: 'gym',
          start_time: gapMinutes(HOME_RESET_GAP_MINUTES - 1),
          end_time: gapMinutes(HOME_RESET_GAP_MINUTES - 1 + 30),
        }),
      ],
      [home, work, gym],
    )
    expect(justUnder.get('gym1')!.lead).toBe(5 + 25 + 5) // still from work

    const atThreshold = computeTravelWindows(
      [
        event({ id: 'work1', place_id: 'work', start_time: '2026-08-19T09:00:00', end_time: '2026-08-19T12:00:00' }),
        event({
          id: 'gym1', place_id: 'gym',
          start_time: gapMinutes(HOME_RESET_GAP_MINUTES),
          end_time: gapMinutes(HOME_RESET_GAP_MINUTES + 30),
        }),
      ],
      [home, work, gym],
    )
    expect(atThreshold.get('gym1')!.lead).toBe(5 + 10 + 5) // reset to home
  })

  it('5. an unknown pair falls back to the from-home travel time', () => {
    const home = place({ id: 'home', is_home: true })
    const work = place({ id: 'work', prep_minutes: 0, travel_from: { home: 20 } })
    // library declares a from-home time but nothing for 'work'.
    const library = place({ id: 'library', prep_minutes: 0, travel_from: { home: 12 } })
    const events = [
      event({ id: 'work1', place_id: 'work', start_time: '2026-08-19T09:00:00', end_time: '2026-08-19T12:00:00' }),
      event({ id: 'lib1', place_id: 'library', start_time: '2026-08-19T12:30:00', end_time: '2026-08-19T13:00:00' }),
    ]

    const windows = computeTravelWindows(events, [home, work, library])

    expect(windows.get('lib1')!.lead).toBe(0 + 12 + TRAVEL_MARGIN_MINUTES)
  })

  it('6. a pair that is unknown AND has no from-home time yields no window at all', () => {
    const home = place({ id: 'home', is_home: true, travel_from: {} })
    // clinic declares nothing — no entry for home, no entry for anything else.
    const clinic = place({ id: 'clinic', prep_minutes: 20, travel_from: {} })
    const events = [event({ id: 'e1', place_id: 'clinic', start_time: '2026-08-19T09:00:00', end_time: '2026-08-19T10:00:00' })]

    const windows = computeTravelWindows(events, [home, clinic])

    expect(windows.has('e1')).toBe(false)
  })

  it('7. an event with no place_id yields no window', () => {
    const home = place({ id: 'home', is_home: true })
    const events = [event({ id: 'e1', start_time: '2026-08-19T09:00:00', end_time: '2026-08-19T10:00:00' })]

    const windows = computeTravelWindows(events, [home])

    expect(windows.has('e1')).toBe(false)
  })

  it('8. trail carries no prep, even when the origin place declares a large one', () => {
    const home = place({ id: 'home', is_home: true })
    // Huge prep_minutes on the FIRST place — if trail ever picked it up by
    // mistake, this assertion would catch it.
    const office = place({ id: 'office', prep_minutes: 999, travel_from: { home: 20 } })
    const cafe = place({ id: 'cafe', prep_minutes: 0, travel_from: { home: 5, office: 7 } })
    const events = [
      event({ id: 'office1', place_id: 'office', start_time: '2026-08-19T09:00:00', end_time: '2026-08-19T12:00:00' }),
      event({ id: 'cafe1', place_id: 'cafe', start_time: '2026-08-19T12:15:00', end_time: '2026-08-19T13:00:00' }),
    ]

    const windows = computeTravelWindows(events, [home, office, cafe])

    expect(windows.get('office1')!.trail).toBe(7) // travel only, no 999-minute prep
  })

  it('9. determinism: shuffling the input events array produces an identical result', () => {
    const home = place({ id: 'home', is_home: true })
    const work = place({ id: 'work', prep_minutes: 15, travel_from: { home: 20 } })
    const gym = place({ id: 'gym', prep_minutes: 5, travel_from: { home: 10, work: 25 } })
    const library = place({ id: 'library', prep_minutes: 0, travel_from: { home: 12 } })

    const events = [
      event({ id: 'a', place_id: 'work', start_time: '2026-08-19T09:00:00', end_time: '2026-08-19T12:00:00' }),
      event({ id: 'b', place_id: 'gym', start_time: '2026-08-19T12:30:00', end_time: '2026-08-19T13:30:00' }),
      event({ id: 'c', place_id: 'library', start_time: '2026-08-20T09:00:00', end_time: '2026-08-20T11:00:00' }),
      event({ id: 'd', place_id: 'work', start_time: '2026-08-20T15:00:00', end_time: '2026-08-20T17:00:00' }),
    ]
    const shuffled = [events[2], events[0], events[3], events[1]]
    const places = [home, work, gym, library]

    const original = computeTravelWindows(events, places)
    const fromShuffled = computeTravelWindows(shuffled, places)

    expect(fromShuffled).toEqual(original)
  })

  it('10. all-day events get no window, and are ignored as a neighbour for other events', () => {
    const home = place({ id: 'home', is_home: true })
    const work = place({ id: 'work', prep_minutes: 0, travel_from: { home: 20 } })
    const events = [
      event({
        id: 'trip', place_id: 'work', is_all_day: true,
        start_time: '2026-08-19T00:00:00', end_time: '2026-08-19T23:59:59',
      }),
      event({ id: 'e1', place_id: 'work', start_time: '2026-08-19T09:00:00', end_time: '2026-08-19T10:00:00' }),
    ]

    const windows = computeTravelWindows(events, [home, work])

    // The all-day event itself never gets a window — "physically travelling
    // to" an all-day block (a trip, an out-of-office day) doesn't map onto a
    // single clock-time boundary the way a timed event's does.
    expect(windows.has('trip')).toBe(false)
    // And it must not silently satisfy e1's "same place, no previous event"
    // shortcut either: e1 has no TIMED predecessor that day, so its origin is
    // still home, not a same-place discount from the all-day event at 'work'.
    expect(windows.get('e1')!.lead).toBe(0 + 20 + TRAVEL_MARGIN_MINUTES)
  })
})

// The scenario this whole feature was asked for, in the user's own shape: two
// shifts at the same branch, 16:30 and 17:00, with the half hour between them
// being the only break in a ten-hour day.
describe("the owner's two back-to-back shifts", () => {
  it('leaves the half hour between them completely free', () => {
    const landver: Place = {
      id: 'landver', user_id: 'u', name: 'לנדוור',
      prep_minutes: 30, travel_from: { home: 20 }, created_at: '2026-08-01T00:00:00.000Z',
    }
    const home: Place = {
      id: 'home', user_id: 'u', name: 'בית', is_home: true,
      prep_minutes: 0, travel_from: { landver: 20 }, created_at: '2026-08-01T00:00:00.000Z',
    }
    const shift = (id: string, start: string, end: string): CalendarEvent => ({
      id, user_id: 'u', title: 'לנדוור', start_time: start, end_time: end,
      is_all_day: false, source: 'zman', created_by: 'user', status: 'confirmed',
      created_at: '2026-08-01T00:00:00.000Z', place_id: 'landver',
    })

    const out = computeTravelWindows(
      [shift('morning', '2026-08-19T10:30:00', '2026-08-19T16:30:00'),
       shift('evening', '2026-08-19T17:00:00', '2026-08-19T23:00:00')],
      [home, landver],
    )

    // The morning shift is travelled to from home: 30 prep + 20 travel + 10 margin.
    expect(out.get('morning')!.lead).toBe(60)
    // It is NOT travelled away from, because the next thing is at the same place.
    expect(out.get('morning')!.trail).toBe(0)
    // And the evening shift needs nothing held open — he is already standing there.
    expect(out.get('evening')!.lead).toBe(0)
  })
})

// Found by watching a real conversation, not by review: told "Landver is 20
// minutes from home", the model records one entry on the destination and stops.
// Nobody says the return leg out loud, so without a reverse lookup the trip home
// has no number, `trail` is 0, and the return half of the feature silently does
// not exist while appearing to.
describe('the return leg nobody declares', () => {
  const home: Place = {
    id: 'home', user_id: 'u', name: 'בית', is_home: true,
    prep_minutes: 0, travel_from: {}, created_at: '2026-08-01T00:00:00.000Z',
  }
  const work: Place = {
    id: 'work', user_id: 'u', name: 'לנדוור',
    prep_minutes: 30, travel_from: { home: 20 }, created_at: '2026-08-01T00:00:00.000Z',
  }
  const shift: CalendarEvent = {
    id: 'shift', user_id: 'u', title: 'משמרת', place_id: 'work',
    start_time: '2026-08-26T17:00:00', end_time: '2026-08-26T23:00:00',
    is_all_day: false, source: 'zman', created_by: 'user', status: 'confirmed',
    created_at: '2026-08-01T00:00:00.000Z',
  }

  it('reads the declared pair backwards so the trip home is still protected', () => {
    const out = computeTravelWindows([shift], [home, work])
    expect(out.get('shift')!.lead).toBe(30 + 20 + TRAVEL_MARGIN_MINUTES)
    // home.travel_from is empty; the 20 comes from work.travel_from.home reversed.
    expect(out.get('shift')!.trail).toBe(20)
  })

  it('prefers an explicitly declared reverse over the mirrored one', () => {
    // Rush hour is not symmetric, and when the user says so, they win.
    const homeWithReturn: Place = { ...home, travel_from: { work: 35 } }
    const out = computeTravelWindows([shift], [homeWithReturn, work])
    expect(out.get('shift')!.trail).toBe(35)
  })
})
