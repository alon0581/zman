/**
 * retire.test.ts
 *
 * This is the destructive path behind "the semester ended, clear my
 * lectures" — on a live volume with no staging and no undo — so it is a pure
 * function specifically so it can be pinned by tests rather than discovered
 * in production, the same way cascade.test.ts pins project deletion.
 *
 * The load-bearing assertion is the one that appears in every block below:
 * NO INSTANCE BEFORE THE CUTOFF DATE IS EVER NAMED FOR DELETION. Ending a
 * series must not be able to take the record that it ever happened with it.
 */

import { describe, expect, it } from 'vitest'
import { CalendarEvent } from '@/types'
import { planSeriesRetirement } from './retire'

const SERIES_ID = 'series-mivne-netunim'
const OTHER_SERIES_ID = 'series-tichnut-monchat-atzamim'

function event(id: string, over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id, user_id: 'u1', title: id, start_time: '2026-08-10T09:00:00', end_time: '2026-08-10T10:00:00',
    is_all_day: false, source: 'zman', created_by: 'ai', status: 'confirmed',
    created_at: '2026-08-01T00:00:00.000Z', series_id: SERIES_ID, ...over,
  } as CalendarEvent
}

describe('past instances survive — the headline regression', () => {
  it('never lists an event that started before the cutoff date', () => {
    const events = [
      event('past1', { title: 'הרצאה במבנה נתונים ואלגוריתמים, פרופ\' כהן, בניין 4 חדר 201', start_time: '2026-08-03T09:00:00' }),
      event('past2', { title: 'תרגול בקורס מבנה נתונים — שאלה 3 בשיעורי הבית לא הוגשה', start_time: '2026-08-10T09:00:00' }),
      event('cutoff', { start_time: '2026-08-15T09:00:00' }),
      event('future', { start_time: '2026-08-22T09:00:00' }),
    ]
    const plan = planSeriesRetirement(events, SERIES_ID, '2026-08-15')

    expect(plan.deleteIds).not.toContain('past1')
    expect(plan.deleteIds).not.toContain('past2')
    expect(plan.keptPast).toBe(2)
  })
})

describe('the boundary', () => {
  it('deletes the instance that starts ON the cutoff date — it did not happen', () => {
    const events = [
      event('past', { start_time: '2026-08-10T09:00:00' }),
      event('cutoff', { title: 'הרצאה של היום עצמו — הסמסטר נגמר בדיוק עכשיו', start_time: '2026-08-15T08:00:00' }),
    ]
    const plan = planSeriesRetirement(events, SERIES_ID, '2026-08-15')
    expect(plan.deleteIds).toContain('cutoff')
  })
})

describe('a series entirely in the past', () => {
  it('yields deleteIds: [] and does not throw', () => {
    const events = [
      event('a', { start_time: '2026-01-05T09:00:00' }),
      event('b', { start_time: '2026-02-10T09:00:00' }),
    ]
    expect(() => planSeriesRetirement(events, SERIES_ID, '2026-12-31')).not.toThrow()
    const plan = planSeriesRetirement(events, SERIES_ID, '2026-12-31')
    expect(plan.deleteIds).toEqual([])
  })
})

describe('a series entirely in the future', () => {
  it('deletes all of it, keptPast: 0', () => {
    const events = [
      event('a', { start_time: '2026-09-01T09:00:00' }),
      event('b', { start_time: '2026-09-08T09:00:00' }),
    ]
    const plan = planSeriesRetirement(events, SERIES_ID, '2026-01-01')
    expect(plan.deleteIds.sort()).toEqual(['a', 'b'])
    expect(plan.keptPast).toBe(0)
  })
})

describe('an unknown series_id', () => {
  it('returns an empty plan rather than throwing', () => {
    const events = [event('a'), event('b')]
    const plan = planSeriesRetirement(events, 'no-such-series', '2026-08-15')
    expect(plan).toEqual({ deleteIds: [], keptPast: 0 })
  })
})

describe('other series are never touched', () => {
  it('never names an event belonging to a different series_id', () => {
    const events = [
      event('mine-past', { start_time: '2026-08-01T09:00:00' }),
      event('mine-future', { start_time: '2026-08-22T09:00:00' }),
      event('theirs-past', { series_id: OTHER_SERIES_ID, title: 'תרגול בתכנות מונחה עצמים — קבוצה ב׳, יום שלישי בערב', start_time: '2026-08-01T09:00:00' }),
      event('theirs-future', { series_id: OTHER_SERIES_ID, start_time: '2026-08-22T09:00:00' }),
    ]
    const plan = planSeriesRetirement(events, SERIES_ID, '2026-08-15')
    expect(plan.deleteIds).not.toContain('theirs-past')
    expect(plan.deleteIds).not.toContain('theirs-future')
  })

  it('every deleted id genuinely belongs to the requested series (impossible by construction, pinned anyway)', () => {
    const events = [
      event('mine-future', { start_time: '2026-08-22T09:00:00' }),
      event('theirs-future', { series_id: OTHER_SERIES_ID, start_time: '2026-08-22T09:00:00' }),
    ]
    const plan = planSeriesRetirement(events, SERIES_ID, '2026-08-15')
    for (const id of plan.deleteIds) {
      const source = events.find(e => e.id === id)
      expect(source?.series_id).toBe(SERIES_ID)
    }
  })
})

describe('lastKept', () => {
  it('names the real last surviving instance, not just any past one', () => {
    const events = [
      event('early', { start_time: '2026-08-01T09:00:00' }),
      event('latest-kept', { start_time: '2026-08-10T14:00:00' }),
      event('deleted', { start_time: '2026-08-22T09:00:00' }),
    ]
    const plan = planSeriesRetirement(events, SERIES_ID, '2026-08-15')
    expect(plan.lastKept).toBe('2026-08-10T14:00:00')
  })
})

describe('unreadable dates are kept, not deleted', () => {
  it('an event with an unparseable start_time is never added to deleteIds', () => {
    const events = [
      event('broken', { title: 'שיעור עם תאריך שבור בגלל באג ישן בייבוא מ-Google Calendar', start_time: 'לא תאריך תקין' }),
      event('future', { start_time: '2026-08-22T09:00:00' }),
    ]
    const plan = planSeriesRetirement(events, SERIES_ID, '2026-08-15')
    expect(plan.deleteIds).not.toContain('broken')
    expect(plan.deleteIds).toContain('future')
  })
})

describe('legacy Z-suffixed rows', () => {
  it('normalises before comparing, with enough margin to be host-timezone-proof', () => {
    // Wide margin from the cutoff on purpose: normalizeToLocalISO falls back to
    // host-local time for a bare Z-suffixed instant (no timezone is threaded
    // through this function), so the exact converted clock time is
    // environment-dependent. A week of slack on each side means no real
    // timezone offset can flip which side of the cutoff these land on.
    const events = [
      event('legacy-past', { start_time: '2026-08-01T09:00:00.000Z' }),
      event('legacy-future', { start_time: '2026-08-25T09:00:00.000Z' }),
    ]
    const plan = planSeriesRetirement(events, SERIES_ID, '2026-08-15')
    expect(plan.deleteIds).not.toContain('legacy-past')
    expect(plan.deleteIds).toContain('legacy-future')
  })
})
