import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildSchedulingContext, planOutcomeToToolResult, toEngineBusy } from './adapter'
import { placeOne, emptyState } from './place'
import { planSchedule } from './plan'
import { METHOD_RULES } from './methodRules'
import { SchedulingMethod } from './methodMapper'
import { busyMinutesIn, inflate, inflateSides } from './timeline'
import { buildDayWindows } from './windows'
import { buildStudentWeekContext } from './__fixtures__/student-week'
import { BusyBlock, PlacementRequest, PlanOutcome, SchedulingContext } from './types'
import { CalendarEvent, Place, UserProfile } from '@/types'

/**
 * travel.test.ts — the engine honours a travel window it was handed.
 *
 * `computeTravelWindows` (src/lib/places/travel.ts, tested next to itself) works
 * out how long it takes to GET to an event. Nothing read those two numbers: the
 * engine would happily end a study block at 09:00 and start a lecture across
 * town at 09:00, because a calendar records when you are somewhere and never
 * how you got there. Now `BusyBlock.leadMinutes` / `trailMinutes` are held open
 * around the commitment they belong to.
 *
 * The risky half of that is everything it must NOT change, so the identity
 * digests come first. The engine never computes a travel number — it only
 * honours one — so an event with no place cannot possibly move a plan, and the
 * digests are how that stops being an opinion.
 */

// ── The fixture week, with a journey attached to one lecture ────────────────
//
// Sunday's day window opens at 08:00 and "הרצאה במבני נתונים" runs 09:00–11:00
// with a 15-minute buffer, so 08:00–08:45 and 11:15–12:00 are both legal today.
// Those two spans are the whole experiment: each test attaches a journey to that
// lecture and asks whether the span survives.
const SUNDAY = '2026-08-16'
const LECTURE_ID = 'busy-ds-lec-sun'
const BEFORE_LECTURE = `${SUNDAY}T08:00:00`
const AFTER_LECTURE = `${SUNDAY}T11:15:00`
const SESSION_MINUTES = 45

/**
 * time_blocking, not the fixture's own pomodoro: pomodoro pins minBlock and
 * maxBlock at exactly 25, so a 45-minute session is refused on length before any
 * of this is reached. time_blocking allows 30–120 and promises no break, which
 * also keeps `spacingAround` out of the arithmetic — every number below is
 * buffer plus travel and nothing else.
 */
function contextWith(travel: Partial<Pick<BusyBlock, 'leadMinutes' | 'trailMinutes'>>): SchedulingContext {
  const base = buildStudentWeekContext()
  return {
    ...base,
    method: { primary: 'time_blocking', secondary: [] },
    rules: METHOD_RULES.time_blocking,
    busy: base.busy.map(b => (b.id === LECTURE_ID ? { ...b, ...travel } : b)),
  }
}

const STUDY: PlacementRequest = {
  ref: { kind: 'task', id: 'study' },
  title: 'לימוד',
  category: 'study',
  energy: 'high',
}

/**
 * Offers the engine exactly ONE candidate, so a refusal is attributable to it.
 *
 * Nothing may be probed before 08:00: that is when the fixture's day window
 * opens, and a candidate outside it is refused for having no window rather than
 * for anything to do with travel.
 */
function tryAt(
  ctx: SchedulingContext,
  start: string,
  opts: { bufferMinutes?: number; minutes?: number } = {},
) {
  const windows = buildDayWindows(ctx.profile, ctx.horizon)
  return placeOne(ctx, STUDY, 0, opts.minutes ?? SESSION_MINUTES, windows, emptyState(ctx), {
    bufferMinutes: opts.bufferMinutes,
    restrictToDay: SUNDAY,
    pinnedStart: start,
  })
}

// ── 1. Identity: no place, no change ────────────────────────────────────────

/**
 * Recorded on the fixture week immediately BEFORE travel windows were wired in,
 * for all eighteen methods. The sixteen without a break match `UNCHANGED_PLANS`
 * in breaks.test.ts digest for digest, which is a second, independent statement
 * that neither change has leaked into the other.
 *
 * A digest that moves means travel reached a calendar that declared no places.
 * Do not update a number here to make the suite green: find out what leaked.
 */
const UNCHANGED_PLANS: Record<SchedulingMethod, string> = {
  pomodoro: 'c175ab88273f72db',
  deep_work: 'bcea66833d436f7b',
  eisenhower: 'e7a07ebfce6d61af',
  gtd: 'e7a07ebfce6d61af',
  time_blocking: '8e7731d2035b15db',
  ivy_lee: '77b5883f9a1c776e',
  eat_the_frog: 'dbf18a0874638ea4',
  theme_days: '5437c850cc4b6513',
  the_one_thing: '56f076bf71ee95fb',
  weekly_review: 'c11629f52b6a68d7',
  okr: 'e7a07ebfce6d61af',
  kanban: '52a29a63cbf77bc9',
  time_boxing: '02da64646f5fb8b4',
  moscow: 'e7a07ebfce6d61af',
  rule_5217: '6296658fc3746a78',
  scrum: '8e7731d2035b15db',
  energy_management: '52a29a63cbf77bc9',
  twelve_week_year: '136c2b9668061699',
}

/** The same realistic ask the acceptance-gate fixture makes. */
const IDENTITY_REQUESTS: PlacementRequest[] = [
  {
    ref: { kind: 'task', id: 'r0' },
    title: 'לימוד לבחינה באלגברה ליניארית',
    category: 'study',
    energy: 'high',
    totalMinutes: 12 * 60,
    sessionCount: 6,
    deadline: '2026-08-27T09:00:00',
  },
  {
    ref: { kind: 'task', id: 'r1' },
    title: 'תרגיל בית במבני נתונים',
    category: 'study',
    energy: 'medium',
    totalMinutes: 3 * 60,
    sessionCount: 2,
    deadline: '2026-08-20T23:59:00',
  },
]

const digestOf = (outcome: PlanOutcome): string =>
  createHash('sha256').update(JSON.stringify(outcome)).digest('hex').slice(0, 16)

describe('a calendar with no places plans exactly as it did before', () => {
  for (const method of Object.keys(METHOD_RULES) as SchedulingMethod[]) {
    it(`${method}: plans the fixture week byte for byte as before`, () => {
      const base = buildStudentWeekContext()
      const ctx = { ...base, method: { primary: method, secondary: [] }, rules: METHOD_RULES[method] }
      expect(digestOf(planSchedule(ctx, IDENTITY_REQUESTS))).toBe(UNCHANGED_PLANS[method])
    })
  }
})

// ── The adapter boundary — the only place travel enters the engine ──────────

const PROFILE: UserProfile = {
  user_id: 'u1',
  autonomy_mode: 'hybrid',
  theme: 'dark',
  language: 'he',
  onboarding_completed: true,
  wake_time: '08:00',
  sleep_time: '23:00',
}

function event(over: Partial<CalendarEvent> & Pick<CalendarEvent, 'id' | 'start_time' | 'end_time'>): CalendarEvent {
  return {
    user_id: 'u1',
    title: 'אירוע',
    is_all_day: false,
    source: 'zman',
    created_by: 'user',
    status: 'confirmed',
    created_at: '2026-08-01T00:00:00.000Z',
    ...over,
  } as CalendarEvent
}

const place = (over: Partial<Place> & Pick<Place, 'id' | 'name'>): Place => ({
  user_id: 'u1',
  prep_minutes: 0,
  travel_from: {},
  created_at: '2026-08-01T00:00:00.000Z',
  ...over,
})

const HOME = place({ id: 'p-home', name: 'בית', is_home: true, travel_from: { 'p-uni': 25 } })
const UNIVERSITY = place({
  id: 'p-uni',
  name: 'אוניברסיטה',
  prep_minutes: 10,
  travel_from: { 'p-home': 30 },
  margin_minutes: 5,
})

describe('toEngineBusy is where travel enters, and the only place', () => {
  const lecture = event({
    id: 'ev-lecture',
    title: 'הרצאה',
    start_time: '2026-08-16T09:00:00',
    end_time: '2026-08-16T11:00:00',
  })

  it('stamps lead and trail on an event whose place resolves', () => {
    const { busy } = toEngineBusy([{ ...lecture, place_id: 'p-uni' }], 'Asia/Jerusalem', [HOME, UNIVERSITY])
    // Lead is prep 10 + travel-in 30 + margin 5; trail is the 25 minutes home and
    // nothing else. Different numbers on the two sides is the normal case, which
    // is exactly why the padding takes two.
    expect(busy[0].leadMinutes).toBe(45)
    expect(busy[0].trailMinutes).toBe(25)
  })

  it('changes nothing at all when the event declares no place', () => {
    const withPlaces = toEngineBusy([lecture], 'Asia/Jerusalem', [HOME, UNIVERSITY])
    const without = toEngineBusy([lecture], 'Asia/Jerusalem')
    expect(withPlaces.busy).toEqual(without.busy)
    expect(withPlaces.busy[0].leadMinutes).toBeUndefined()
    expect(withPlaces.busy[0].trailMinutes).toBeUndefined()
  })

  it('changes nothing when the places list is empty or absent', () => {
    const placed = { ...lecture, place_id: 'p-uni' }
    expect(toEngineBusy([placed], 'Asia/Jerusalem', []).busy).toEqual(toEngineBusy([placed], 'Asia/Jerusalem').busy)
    expect(toEngineBusy([placed], 'Asia/Jerusalem', null).busy).toEqual(toEngineBusy([placed], 'Asia/Jerusalem').busy)
  })

  it('buildSchedulingContext threads places through, and is inert without them', () => {
    const events = [{ ...lecture, place_id: 'p-uni' }]
    const now = '2026-08-16T07:30:00'
    const withPlaces = buildSchedulingContext(PROFILE, events, [], [], 'Asia/Jerusalem', now, 14, undefined, [HOME, UNIVERSITY])
    const without = buildSchedulingContext(PROFILE, events, [], [], 'Asia/Jerusalem', now)

    expect(withPlaces.busy[0].leadMinutes).toBe(45)
    expect(without.busy[0].leadMinutes).toBeUndefined()

    // And the engine acts on the difference: 08:00–08:45 is free on the context
    // built without places and refused on the one built with them. That is the
    // end-to-end statement — app state in, a travel-aware refusal out.
    const probe = (ctx: SchedulingContext) => placeOne(
      { ...ctx, rules: METHOD_RULES.time_blocking },
      STUDY, 0, SESSION_MINUTES,
      buildDayWindows(ctx.profile, ctx.horizon),
      emptyState(ctx),
      { restrictToDay: SUNDAY, pinnedStart: BEFORE_LECTURE },
    )
    expect(probe(without).ok).toBe(true)
    const blocked = probe(withPlaces)
    expect(blocked.ok).toBe(false)
    if (blocked.ok) return
    expect(blocked.code).toBe('blocked_by_travel')
  })
})

// ── 2. The window actually blocks ───────────────────────────────────────────

describe('a travel window refuses a slot the calendar says is free', () => {
  it('08:00–08:45 before a 09:00 lecture is legal while no journey is declared', () => {
    const result = tryAt(contextWith({}), BEFORE_LECTURE)
    expect(result.ok).toBe(true)
  })

  it('and is refused once the lecture takes half an hour to get to', () => {
    // 09:00 lecture, 15-minute buffer, 30 minutes of travel ⇒ nothing may start
    // after 08:15, so a 45-minute block at 08:00 runs into the journey.
    const result = tryAt(contextWith({ leadMinutes: 30 }), BEFORE_LECTURE)
    expect(result.ok).toBe(false)
  })

  // ── 3. …and says the right thing about it ────────────────────────────────

  it('reports blocked_by_travel, not blocked_by_fixed', () => {
    const result = tryAt(contextWith({ leadMinutes: 30 }), BEFORE_LECTURE)
    expect(result.ok).toBe(false)
    if (result.ok) return
    // "fixed events block every option" would be a false sentence here: the
    // lecture did not block 08:00, the journey to it did.
    expect(result.code).toBe('blocked_by_travel')
  })

  it('still reports blocked_by_fixed when the lecture itself is what was hit', () => {
    // The distinction has to cut both ways, or it is just a rename. 09:15 lands
    // inside the lecture's own two hours, travel or no travel.
    for (const travel of [{}, { leadMinutes: 30 }]) {
      const result = tryAt(contextWith(travel), `${SUNDAY}T09:15:00`)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe('blocked_by_fixed')
    }
  })

  it('renders the refusal as a sentence in both languages', () => {
    const outcome: PlanOutcome = {
      status: 'blocked',
      unplaced: [{ requestIndex: 0, code: 'blocked_by_travel' }],
      relaxations: [],
    }
    const he = planOutcomeToToolResult(outcome, true, [STUDY]).unplaced![0].reason
    const en = planOutcomeToToolResult(outcome, false, [STUDY]).unplaced![0].reason
    expect(he).toContain('נסיעה')
    expect(en).toContain('travel')
    expect(he).not.toBe(en)
  })
})

// ── 4. drop_buffer gives up breathing room, never the commute ───────────────

describe('drop_buffer cannot zero a travel window', () => {
  it('really does drop the buffer', () => {
    // 08:15–09:00 touches the lecture's 15-minute buffer and nothing else, so it
    // is refused normally and allowed once the buffer is given up. Without this
    // the next assertion could pass for the wrong reason.
    const ctx = contextWith({})
    expect(tryAt(ctx, `${SUNDAY}T08:15:00`).ok).toBe(false)
    expect(tryAt(ctx, `${SUNDAY}T08:15:00`, { bufferMinutes: 0 }).ok).toBe(true)
  })

  it('leaves the journey standing when the buffer is dropped', () => {
    // Same slot, same relaxation, but the lecture now takes 30 minutes to reach.
    // "Skip your commute" is not advice the engine is allowed to offer.
    const ctx = contextWith({ leadMinutes: 30 })
    const result = tryAt(ctx, `${SUNDAY}T08:15:00`, { bufferMinutes: 0 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('blocked_by_travel')
  })

  it('drops exactly the buffer and keeps exactly the travel, not more of either', () => {
    // A 15-minute journey to a 09:00 lecture. Normally the wall is at 08:30
    // (buffer 15 + travel 15); with the buffer given up it moves to 08:45 — by
    // fifteen minutes, the size of the buffer, and not one minute further.
    const ctx = contextWith({ leadMinutes: 15 })
    expect(tryAt(ctx, BEFORE_LECTURE).ok).toBe(false)
    expect(tryAt(ctx, BEFORE_LECTURE, { bufferMinutes: 0 }).ok).toBe(true)
    // The wall is still there at 08:45, which is what "the travel survived" means.
    const past = tryAt(ctx, `${SUNDAY}T08:15:00`, { bufferMinutes: 0 })
    expect(past.ok).toBe(false)
    if (past.ok) return
    expect(past.code).toBe('blocked_by_travel')
  })
})

// ── 5. The trail blocks too ─────────────────────────────────────────────────

describe('the journey home blocks the time after an event', () => {
  it('11:15 right after an 11:00 lecture is legal while no journey is declared', () => {
    expect(tryAt(contextWith({}), AFTER_LECTURE).ok).toBe(true)
  })

  it('and is refused once there are 30 minutes to travel home', () => {
    const result = tryAt(contextWith({ trailMinutes: 30 }), AFTER_LECTURE)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('blocked_by_travel')
  })
})

// ── 6. Asymmetry: each number applies, on its own side only ────────────────

describe('lead and trail are independent, and land on the correct sides', () => {
  it('a lead alone blocks only the approach', () => {
    const ctx = contextWith({ leadMinutes: 60, trailMinutes: 0 })
    expect(tryAt(ctx, BEFORE_LECTURE).ok).toBe(false)
    expect(tryAt(ctx, AFTER_LECTURE).ok).toBe(true)
  })

  it('a trail alone blocks only the departure', () => {
    const ctx = contextWith({ leadMinutes: 0, trailMinutes: 60 })
    expect(tryAt(ctx, BEFORE_LECTURE).ok).toBe(true)
    expect(tryAt(ctx, AFTER_LECTURE).ok).toBe(false)
  })

  it('applies each side at its own size when both are set', () => {
    // Fifteen minutes to get there, an hour to get home — the shape of a real
    // day, where the trip out carries no preparation but may be the long one.
    // Lead wall:  09:00 − buffer 15 − travel 15 = 08:30.
    // Trail wall: 11:00 + buffer 15 + travel 60 = 12:15.
    // Probed with 30-minute blocks so both walls can be hit from either side
    // without running past the 08:00 opening of the day.
    const ctx = contextWith({ leadMinutes: 15, trailMinutes: 60 })
    expect(tryAt(ctx, `${SUNDAY}T08:00:00`, { minutes: 30 }).ok).toBe(true)   // ends 08:30
    expect(tryAt(ctx, `${SUNDAY}T08:15:00`, { minutes: 30 }).ok).toBe(false)  // crosses it
    expect(tryAt(ctx, `${SUNDAY}T12:00:00`, { minutes: 30 }).ok).toBe(false)  // still travelling
    expect(tryAt(ctx, `${SUNDAY}T12:15:00`, { minutes: 30 }).ok).toBe(true)   // home
  })
})

// ── The padding primitive, and the cap it stays out of ─────────────────────

describe('inflateSides', () => {
  const block: BusyBlock = {
    id: 'b', title: 'הרצאה',
    start: '2026-08-16T09:00:00', end: '2026-08-16T11:00:00',
    mobility: 'fixed', createdBy: 'user', isAllDay: false,
  }

  it('is what inflate does, when both sides are the same', () => {
    for (const n of [-5, 0, 15, 90]) {
      expect(inflate(block, n)).toEqual(inflateSides(block, { before: n, after: n }))
    }
  })

  it('pads each side by its own amount', () => {
    expect(inflateSides(block, { before: 45, after: 20 })).toEqual({
      start: '2026-08-16T08:15:00',
      end: '2026-08-16T11:20:00',
    })
  })

  it('clamps each side independently, so one edge cannot disturb the other', () => {
    expect(inflateSides(block, { before: 0, after: 20 })).toEqual({ start: block.start, end: '2026-08-16T11:20:00' })
    expect(inflateSides(block, { before: 45, after: 0 })).toEqual({ start: '2026-08-16T08:15:00', end: block.end })
  })

  it('never pads an all-day block, which already owns its whole day', () => {
    const allDay = { ...block, isAllDay: true, start: '2026-08-23T00:00:00', end: '2026-08-26T00:00:00' }
    expect(inflateSides(allDay, { before: 60, after: 60 })).toEqual({ start: allDay.start, end: allDay.end })
  })
})

describe('travel is not charged to the daily cap', () => {
  it('counts the commitment only, however long the journey is', () => {
    const window = { day: SUNDAY, start: `${SUNDAY}T08:00:00`, end: `${SUNDAY}T23:00:00` }
    const lecture: BusyBlock = {
      id: 'b', title: 'הרצאה',
      start: `${SUNDAY}T09:00:00`, end: `${SUNDAY}T11:00:00`,
      mobility: 'fixed', createdBy: 'user', isAllDay: false,
    }
    // Two hours of lecture is two hours of the cap. Charging the 90 minutes of
    // travel as well would shrink the working day twice — see the note on
    // busyMinutesIn for why that argument is the reverse of the buffer's.
    expect(busyMinutesIn(window, [lecture])).toBe(120)
    expect(busyMinutesIn(window, [{ ...lecture, leadMinutes: 60, trailMinutes: 30 }])).toBe(120)
  })
})
