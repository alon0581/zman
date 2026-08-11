import { describe, it } from 'vitest'
import { planSchedule } from '../plan'
import { explainReasons } from '../explain'
import { buildStudentWeekContext, STUDENT_WEEK_BUSY } from './student-week'
import { PlacementRequest, Weekday } from '../types'
import { localDateKey, parseLocal } from '../clock'

/**
 * The acceptance gate — not an assertion, a printout.
 *
 * The engine's correctness is covered by the unit tests next to each module.
 * What no unit test can tell us is whether the resulting week looks like a week
 * a person would actually want. So this renders a real plan for the fixture week
 * in Hebrew, exactly as the assistant would explain it, for a human to read and
 * say "yes, that's how I'd have done it" — or not.
 *
 * Run it on its own with:  npx vitest run preview --reporter=basic
 */

const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']

function dayName(iso: string): string {
  return HE_DAYS[parseLocal(iso).getDay()]
}

function hhmm(iso: string): string {
  return iso.slice(11, 16)
}

describe('שבוע לדוגמה — פלט לאישור', () => {
  // Generous timeout on purpose: this is a printout for a human, not an assertion,
  // and it must not be the thing that goes red while the engine is being tuned.
  // Engine speed is measured deliberately, not policed by this test's clock.
  it('מדפיס את התוכנית שהמנוע בנה', { timeout: 60_000 }, () => {
    const ctx = buildStudentWeekContext()

    // The realistic ask: an exam in ~11 days, 12 hours of studying to place, plus
    // a couple of gym sessions. Exactly the kind of request the product exists for.
    const requests: PlacementRequest[] = [
      {
        ref: { kind: 'task' },
        title: 'לימוד לבחינה באלגברה ליניארית',
        category: 'study',
        energy: 'high',
        totalMinutes: 12 * 60,
        sessionCount: 6,
        deadline: '2026-08-27T09:00:00',
      },
      {
        ref: { kind: 'task' },
        title: 'תרגיל בית במבני נתונים',
        category: 'study',
        energy: 'medium',
        totalMinutes: 3 * 60,
        sessionCount: 2,
        deadline: '2026-08-20T23:59:00',
      },
    ]

    const outcome = planSchedule(ctx, requests)

    const lines: string[] = []
    lines.push('')
    lines.push('════════════════════════════════════════════════════════')
    lines.push(`  מצב התוכנית: ${outcome.status}`)
    lines.push(`  קיים ביומן מראש: ${STUDENT_WEEK_BUSY.length} אירועים`)
    lines.push('════════════════════════════════════════════════════════')

    const blocks = 'blocks' in outcome ? outcome.blocks : []
    const byDay = new Map<string, typeof blocks>()
    for (const b of blocks) {
      const k = localDateKey(b.start)
      if (!byDay.has(k)) byDay.set(k, [])
      byDay.get(k)!.push(b)
    }

    for (const day of [...byDay.keys()].sort()) {
      lines.push('')
      lines.push(`── ${day}  (יום ${dayName(day + 'T00:00:00')}) ──`)
      for (const b of byDay.get(day)!.sort((x, y) => (x.start < y.start ? -1 : 1))) {
        lines.push(`   ${hhmm(b.start)}–${hhmm(b.end)}  ${b.title}   [ניקוד ${b.score.toFixed(1)}]`)
        for (const reason of explainReasons(b.reasons, true, 2)) {
          lines.push(`      · ${reason}`)
        }
      }
    }

    if ('displacements' in outcome && outcome.displacements.length) {
      lines.push('')
      lines.push('── אירועים שהוזזו כדי לפנות מקום ──')
      for (const d of outcome.displacements) {
        lines.push(`   ${d.title}: ${hhmm(d.from)} → ${hhmm(d.to)} (${localDateKey(d.to)})`)
      }
    }

    if ('unplaced' in outcome && outcome.unplaced.length) {
      lines.push('')
      lines.push('── לא נכנס ──')
      for (const u of outcome.unplaced) {
        lines.push(`   בקשה #${u.requestIndex}: ${u.code}${u.placedCount != null ? ` (שובצו ${u.placedCount})` : ''}`)
      }
    }

    if ('relaxations' in outcome && outcome.relaxations.length) {
      lines.push('')
      lines.push('── מה היה עוזר ──')
      for (const r of outcome.relaxations) {
        lines.push(`   ${r.code}: ${r.delta} → היה משבץ עוד ${r.wouldPlace}`)
      }
    }

    lines.push('')
    console.log(lines.join('\n'))
  })

  // The one open product question this fixture can actually answer with numbers
  // instead of opinion: an Israeli student typically studies on Friday and keeps
  // only Shabbat. Holding Friday back is a real cost, and this prints it.
  it('מראה מה שישי שווה', { timeout: 60_000 }, () => {
    const requests: PlacementRequest[] = [{
      ref: { kind: 'task' },
      title: 'לימוד לבחינה באלגברה ליניארית',
      category: 'study',
      energy: 'high',
      totalMinutes: 12 * 60,
      sessionCount: 6,
      deadline: '2026-08-27T09:00:00',
    }]

    const count = (weekendDays: Weekday[]) => {
      const base = buildStudentWeekContext()
      const outcome = planSchedule({ ...base, profile: { ...base.profile, weekendDays } }, requests)
      return 'blocks' in outcome ? outcome.blocks.length : 0
    }

    const withoutFriday = count([5, 6])
    const withFriday = count([6])
    const bothDays = count([])

    console.log([
      '',
      '════════════════════════════════════════════════════════',
      '  כמה מפגשים נכנסים, לפי הימים שנשמרים פנויים',
      '════════════════════════════════════════════════════════',
      `  שישי ושבת פנויים (ברירת המחדל):  ${withoutFriday} מפגשים`,
      `  לומד בשישי, שבת נשמרת:            ${withFriday} מפגשים  (+${withFriday - withoutFriday})`,
      `  לומד בשני הימים:                  ${bothDays} מפגשים  (+${bothDays - withoutFriday})`,
      '',
      '  ההגדרה: profile.schedule_weekend = none | friday | both',
      '',
    ].join('\n'))
  })
})
