/**
 * explain.ts — turns a placement's ScoredReason[] into sentences a person reads.
 *
 * This is the one place allowed to turn a ReasonCode into words. The AI is told
 * to paraphrase what comes out of here, never to invent its own justification —
 * so every sentence has to already sound like something a person would say, with
 * no embellishment needed on top ("שמתי ב-9:00 כי זה שיא הריכוז שלך", not
 * "PEAK_MATCH: score 0.8").
 *
 * A reason's `detail` is intentionally loose (Record<string, string | number>,
 * see types.ts) because it is produced by score.ts, which this file does not
 * import or depend on. So every renderer below reads its expected field(s) by
 * name but degrades to a still-natural, generic sentence if the field is
 * missing — it never interpolates `undefined` into a sentence.
 *
 * Sign of `weight` carries meaning: positive is a reason the slot is good,
 * negative is a trade-off that was accepted anyway. Both get an honest
 * sentence; a negative reason is never phrased as if it were a positive.
 */

import { ReasonCode, ScoredReason, Category } from './types'

// ── Small formatting helpers ────────────────────────────────────────────────

/** "9" / 9 -> "09:00". Returns undefined (never the string "undefined") if unusable. */
function hourLabel(value: string | number | undefined): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return undefined
  const h = Math.max(0, Math.min(23, Math.trunc(n)))
  return `${String(h).padStart(2, '0')}:00`
}

/** Reads the first present key out of a detail bag, as a raw string|number. */
function pick(detail: Record<string, string | number> | undefined, ...keys: string[]): string | number | undefined {
  if (!detail) return undefined
  for (const k of keys) {
    const v = detail[k]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

const DAY_HE: Record<string, string> = {
  Sun: 'ראשון', Sunday: 'ראשון', Mon: 'שני', Monday: 'שני', Tue: 'שלישי', Tuesday: 'שלישי',
  Wed: 'רביעי', Wednesday: 'רביעי', Thu: 'חמישי', Thursday: 'חמישי', Fri: 'שישי', Friday: 'שישי',
  Sat: 'שבת', Saturday: 'שבת',
}

const CATEGORY_HE: Record<Category, string> = {
  study: 'לימודים', work: 'עבודה', fitness: 'ספורט', personal: 'אישי', social: 'חברתי', admin: 'סידורים',
}

function dayLabel(value: string | number | undefined, isHe: boolean): string | undefined {
  if (value === undefined) return undefined
  const s = String(value)
  return isHe ? (DAY_HE[s] ?? s) : s
}

function categoryLabel(value: string | number | undefined, isHe: boolean): string | undefined {
  if (value === undefined) return undefined
  const s = String(value)
  return isHe ? (CATEGORY_HE[s as Category] ?? s) : s
}

// ── Per-code renderers ───────────────────────────────────────────────────────
//
// Each entry returns { he, en } for a *positive* weight and a *negative*
// (trade-off) weight. renderReason() below picks the branch by sign.

type Branch = (detail: Record<string, string | number> | undefined) => { he: string; en: string }

const RENDERERS: Record<ReasonCode, { positive: Branch; negative: Branch }> = {
  PEAK_MATCH: {
    positive: (d) => {
      const hour = hourLabel(pick(d, 'hour', 'startHour'))
      return hour
        ? { he: `שמתי ב-${hour} כי זה שיא הריכוז שלך`, en: `Placed at ${hour} because that's your focus peak` }
        : { he: 'זו שעת שיא הריכוז שלך', en: 'This falls in your focus peak' }
    },
    negative: () => ({
      he: 'זה לא בשעות השיא שלך, אבל זה מה שהתפנה',
      en: "This isn't in your peak hours, but it's what was free",
    }),
  },

  METHOD_FIT: {
    positive: (d) => {
      const minutes = pick(d, 'minutes', 'sessionMinutes', 'length')
      return minutes !== undefined
        ? { he: `האורך (${minutes} דק') מתאים בול לשיטה שבחרת`, en: `The length (${minutes} min) fits your method exactly` }
        : { he: 'האורך מתאים לשיטה שבחרת', en: 'The length matches your method' }
    },
    negative: () => ({
      he: 'האורך לא תואם לגמרי לשיטה שבחרת, אבל זה הכי קרוב שהיה אפשר',
      en: "The length doesn't perfectly match your method, but it's the closest fit available",
    }),
  },

  SPREAD: {
    positive: (d) => {
      const hours = pick(d, 'hours', 'gapHours')
      const days = pick(d, 'days', 'gapDays')
      if (hours !== undefined) return { he: `יש מרווח של ${hours} שעות מהמפגש הקודם של המשימה`, en: `There's a ${hours}-hour gap from the item's previous session` }
      if (days !== undefined) return { he: `יש מרווח של ${days} ימים מהמפגש הקודם של המשימה`, en: `There's a ${days}-day gap from the item's previous session` }
      return { he: 'זה מרוחק מהמפגשים האחרים של אותה משימה', en: "This is spread apart from the item's other sessions" }
    },
    negative: () => ({
      he: 'זה קרוב יותר למפגש הקודם ממה שהייתי רוצה, אבל לא נשאר מקום אחר',
      en: "This sits closer to the previous session than ideal, but there was no other room",
    }),
  },

  DEADLINE_MARGIN: {
    positive: (d) => {
      const daysLeft = pick(d, 'daysLeft', 'days')
      return daysLeft !== undefined
        ? { he: `יש ${daysLeft} ימים מרווח לפני המועד האחרון`, en: `There are ${daysLeft} days of margin before the deadline` }
        : { he: 'יש מרווח נוח לפני המועד האחרון', en: 'There is comfortable margin before the deadline' }
    },
    negative: () => ({
      he: 'זה קרוב למועד האחרון, אבל זה החלון הכי מוקדם שהתפנה',
      en: "This is cutting it close to the deadline, but it's the earliest slot that was free",
    }),
  },

  PRIOR_HOUR: {
    positive: (d) => {
      const hour = hourLabel(pick(d, 'hour'))
      return hour
        ? { he: `בשעה ${hour} אתה בדרך כלל עומד בתוכניות שלך`, en: `At ${hour} you tend to actually keep your plans` }
        : { he: 'זו שעה שבה בדרך כלל עמדת בתוכניות שלך', en: 'This is an hour you tend to actually keep your plans' }
    },
    negative: () => ({
      he: 'בעבר זזת מהשעה הזו, אבל זה מה שהיה פנוי הפעם',
      en: "You've moved things away from this hour before, but it's what was open this time",
    }),
  },

  THEME_DAY: {
    positive: (d) => {
      const day = dayLabel(pick(d, 'day', 'weekday'), true)
      const dayEn = dayLabel(pick(d, 'day', 'weekday'), false)
      const category = categoryLabel(pick(d, 'category', 'theme'), true)
      const categoryEn = categoryLabel(pick(d, 'category', 'theme'), false)
      if (day && category) return { he: `יום ${day} מוקדש ל${category} אצלך, אז זה נכנס בול`, en: `${dayEn} is your ${categoryEn} day, so this fits right in` }
      if (category) return { he: `זה יום שמוקדש ל${category} אצלך`, en: `This is your ${categoryEn} day` }
      return { he: 'זה תואם לנושא של היום', en: "This matches today's theme" }
    },
    negative: () => ({
      he: 'זה לא תואם לנושא של היום, אבל זה מה שהיה פנוי',
      en: "This doesn't match today's theme, but it's what was free",
    }),
  },

  ENERGY_MATCH: {
    positive: (d) => {
      const hour = hourLabel(pick(d, 'hour'))
      return hour
        ? { he: `זו משימה שדורשת אנרגיה גבוהה, ושמתי אותה ב-${hour} — חלון אנרגיה גבוהה`, en: `This needs high energy, so it's placed at ${hour} — a high-energy window` }
        : { he: 'זו משימה שדורשת אנרגיה גבוהה, ושמתי אותה בחלון אנרגיה גבוהה', en: "This needs high energy, so it's placed in a high-energy window" }
    },
    negative: () => ({
      he: 'רמת האנרגיה בשעה הזו לא אידיאלית למשימה, אבל זה מה שהתפנה',
      en: "The energy level at this hour isn't ideal for the task, but it's what was available",
    }),
  },

  FROG_FIRST: {
    positive: () => ({
      he: 'זו המשימה הכי קשה, אז שמתי אותה ראשונה — לפני שהיא נדחית',
      en: "This is the hardest task, so it's placed first — before it gets put off",
    }),
    negative: () => ({
      he: 'זו לא הייתה אמורה להיות ראשונה, אבל זה המקום שהתפנה',
      en: "This wasn't meant to go first, but it's the slot that opened up",
    }),
  },

  BUFFER_RESPECTED: {
    positive: (d) => {
      const minutes = pick(d, 'minutes', 'bufferMinutes')
      return minutes !== undefined
        ? { he: `השארתי ${minutes} דק' מרווח נשימה מהאירועים הסמוכים`, en: `Left ${minutes} min of breathing room around the neighbouring events` }
        : { he: 'השארתי מרווח נשימה מהאירועים הסמוכים', en: 'Left breathing room around the neighbouring events' }
    },
    negative: () => ({
      he: 'הצמדתי את זה קצת יותר לאירוע הסמוך ממה שהייתי רוצה, כדי שזה בכלל ייכנס',
      en: "This sits a bit tighter against the next event than ideal, so it could fit at all",
    }),
  },

  EARLIEST_AVAILABLE: {
    positive: () => ({
      he: 'זה פשוט החלון הכי מוקדם שהתפנה',
      en: 'This is simply the earliest slot available',
    }),
    negative: () => ({
      he: 'לא היה חלון טוב יותר, אז זה החלון הכי מוקדם שנמצא',
      en: 'No better window was available, so this is just the earliest one that fit',
    }),
  },
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Renders one ScoredReason to a single sentence, in the requested language. */
export function renderReason(reason: ScoredReason, isHe: boolean): string {
  const set = RENDERERS[reason.code]
  const branch = reason.weight < 0 ? set.negative : set.positive
  const { he, en } = branch(reason.detail)
  return isHe ? he : en
}

/**
 * Sorts reasons best-first (weight descending) and renders the top `limit`
 * (default 3) to sentences. This is the only function callers should need —
 * it is what the AI is told to paraphrase, verbatim reason by reason.
 */
export function explainReasons(reasons: ScoredReason[], isHe: boolean, limit = 3): string[] {
  return [...reasons]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit)
    .map((r) => renderReason(r, isHe))
}
