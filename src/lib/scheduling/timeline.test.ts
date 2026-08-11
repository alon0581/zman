import { describe, it, expect } from 'vitest'
import { CalendarEvent } from '@/types'
import {
  blockersFor, busyMinutesIn, freeGaps, inflate, mergeSpans, overlapMinutes, overlaps, toBusyBlocks,
} from './timeline'
import { BusyBlock, DayWindow } from './types'

function eventOf(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'e1',
    user_id: 'u',
    title: 'בלוק לימוד',
    start_time: '2026-08-10T09:00:00',
    end_time: '2026-08-10T10:00:00',
    is_all_day: false,
    source: 'zman',
    created_by: 'user',
    status: 'confirmed',
    created_at: '2026-08-01T00:00:00',
    ...over,
  }
}

function busyOf(over: Partial<BusyBlock> = {}): BusyBlock {
  return {
    id: 'b1',
    title: 'block',
    start: '2026-08-10T09:00:00',
    end: '2026-08-10T10:00:00',
    mobility: 'flexible',
    createdBy: 'ai',
    isAllDay: false,
    ...over,
  }
}

const window: DayWindow = { day: '2026-08-10', start: '2026-08-10T09:00:00', end: '2026-08-10T17:00:00' }

describe('all-day events actually block', () => {
  it('occupies the entire day, not the stored times', () => {
    const [block] = toBusyBlocks([eventOf({
      is_all_day: true,
      start_time: '2026-08-11T00:00:00',
      end_time: '2026-08-11T23:59:59',
      title: 'מילואים',
    })])
    expect(block.start).toBe('2026-08-11T00:00:00')
    expect(block.end).toBe('2026-08-12T00:00:00')
  })

  it('leaves no free gap anywhere in the day it covers', () => {
    const busy = toBusyBlocks([eventOf({ is_all_day: true, start_time: '2026-08-10T08:00:00', end_time: '2026-08-10T09:00:00' })])
    expect(freeGaps(window, busy, 0)).toEqual([])
  })

  it('blocks EVERY day a multi-day event spans, not just the first', () => {
    const busy = toBusyBlocks([eventOf({
      is_all_day: true,
      start_time: '2026-08-10T00:00:00',
      end_time: '2026-08-12T23:59:59',
      title: 'טיול',
    })])
    for (const day of ['2026-08-10', '2026-08-11', '2026-08-12']) {
      expect(freeGaps({ day, start: `${day}T09:00:00`, end: `${day}T17:00:00` }, busy, 0)).toEqual([])
    }
    // …and stops the day after.
    expect(freeGaps({ day: '2026-08-13', start: '2026-08-13T09:00:00', end: '2026-08-13T17:00:00' }, busy, 0))
      .toHaveLength(1)
  })

  it('treats an exclusive midnight end as "through yesterday"', () => {
    const [block] = toBusyBlocks([eventOf({
      is_all_day: true,
      start_time: '2026-08-10T00:00:00',
      end_time: '2026-08-12T00:00:00',
    })])
    expect(block.end).toBe('2026-08-12T00:00:00') // covers the 10th and 11th, not the 12th
  })
})

describe('a timed multi-day event is visible from every day it touches', () => {
  it('is found by overlap, never by "does it start today"', () => {
    const busy = toBusyBlocks([eventOf({
      start_time: '2026-08-10T22:00:00',
      end_time: '2026-08-12T06:00:00',
      title: 'טיסה',
    })])
    const day11: DayWindow = { day: '2026-08-11', start: '2026-08-11T09:00:00', end: '2026-08-11T17:00:00' }
    expect(freeGaps(day11, busy, 0)).toEqual([])
    expect(blockersFor({ start: '2026-08-11T10:00:00', end: '2026-08-11T11:00:00' }, busy, 0)).toHaveLength(1)
  })
})

describe('mobility comes from the event, then from the classifier', () => {
  it('prefers a stored mobility_type — it may be a manual override', () => {
    const [block] = toBusyBlocks([eventOf({ title: 'בחינה', mobility_type: 'flexible' })])
    expect(block.mobility).toBe('flexible')
  })

  it('falls back to classifyMobility for events written before mobility existed', () => {
    expect(toBusyBlocks([eventOf({ title: 'בחינה בחשבון אינפיניטסימלי' })])[0].mobility).toBe('fixed')
    expect(toBusyBlocks([eventOf({ title: 'קפה', created_by: 'ai' })])[0].mobility).toBe('flexible')
    expect(toBusyBlocks([eventOf({ title: 'קפה', created_by: 'user' })])[0].mobility).toBe('ask_first')
  })
})

describe('the LocalISO invariant is enforced at the boundary', () => {
  it('rejects a UTC timestamp instead of shifting the whole schedule', () => {
    expect(() => toBusyBlocks([eventOf({ start_time: '2026-08-10T09:00:00Z' })]))
      .toThrow(/non-LocalISO start_time/)
  })
})

describe('buffers', () => {
  it('pads a timed block on both sides', () => {
    expect(inflate(busyOf(), 15)).toEqual({ start: '2026-08-10T08:45:00', end: '2026-08-10T10:15:00' })
  })

  it('never pads an all-day block into the neighbouring days, which are free', () => {
    const allDay = busyOf({ isAllDay: true, start: '2026-08-10T00:00:00', end: '2026-08-11T00:00:00' })
    expect(inflate(allDay, 30)).toEqual({ start: '2026-08-10T00:00:00', end: '2026-08-11T00:00:00' })
  })

  it('makes an adjacent slot a collision once inflated', () => {
    const busy = [busyOf()]
    expect(blockersFor({ start: '2026-08-10T10:00:00', end: '2026-08-10T11:00:00' }, busy, 0)).toHaveLength(0)
    expect(blockersFor({ start: '2026-08-10T10:00:00', end: '2026-08-10T11:00:00' }, busy, 15)).toHaveLength(1)
  })

  it('reports blockers in a stable order', () => {
    const busy = [
      busyOf({ id: 'z', start: '2026-08-10T11:00:00', end: '2026-08-10T12:00:00' }),
      busyOf({ id: 'a', start: '2026-08-10T09:00:00', end: '2026-08-10T10:00:00' }),
    ]
    const ids = blockersFor({ start: '2026-08-10T09:00:00', end: '2026-08-10T12:00:00' }, busy, 0).map(b => b.id)
    expect(ids).toEqual(['a', 'z'])
  })
})

describe('span arithmetic', () => {
  it('treats touching spans as not overlapping', () => {
    const a = { start: '2026-08-10T09:00:00', end: '2026-08-10T10:00:00' }
    const b = { start: '2026-08-10T10:00:00', end: '2026-08-10T11:00:00' }
    expect(overlaps(a, b)).toBe(false)
    expect(overlapMinutes(a, b)).toBe(0)
  })

  it('measures a partial overlap', () => {
    expect(overlapMinutes(
      { start: '2026-08-10T09:00:00', end: '2026-08-10T15:00:00' },
      { start: '2026-08-10T09:00:00', end: '2026-08-10T12:00:00' }
    )).toBe(180)
  })

  it('merges overlapping and touching spans', () => {
    expect(mergeSpans([
      { start: '2026-08-10T11:00:00', end: '2026-08-10T12:00:00' },
      { start: '2026-08-10T09:00:00', end: '2026-08-10T10:30:00' },
      { start: '2026-08-10T10:00:00', end: '2026-08-10T11:00:00' },
    ])).toEqual([{ start: '2026-08-10T09:00:00', end: '2026-08-10T12:00:00' }])
  })

  it('finds the gaps a window has left', () => {
    const busy = [
      busyOf({ id: 'a', start: '2026-08-10T10:00:00', end: '2026-08-10T11:00:00' }),
      busyOf({ id: 'b', start: '2026-08-10T14:00:00', end: '2026-08-10T15:00:00' }),
    ]
    expect(freeGaps(window, busy, 0)).toEqual([
      { start: '2026-08-10T09:00:00', end: '2026-08-10T10:00:00' },
      { start: '2026-08-10T11:00:00', end: '2026-08-10T14:00:00' },
      { start: '2026-08-10T15:00:00', end: '2026-08-10T17:00:00' },
    ])
  })

  it('counts committed minutes once, even when commitments overlap', () => {
    const busy = [
      busyOf({ id: 'a', start: '2026-08-10T10:00:00', end: '2026-08-10T12:00:00' }),
      busyOf({ id: 'b', start: '2026-08-10T11:00:00', end: '2026-08-10T13:00:00' }),
    ]
    expect(busyMinutesIn(window, busy)).toBe(180)
  })
})
