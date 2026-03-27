/**
 * Auto-classifies event mobility type based on title and creation context.
 *
 * 🔒 fixed     — never move (exams, flights, interviews, etc.)
 * 🟡 flexible  — AI can move freely (study blocks, AI-created sessions)
 * 🔵 ask_first — ask user before moving (default for user-created events)
 */

/** Keywords that indicate a fixed event (Hebrew + English) */
const FIXED_KEYWORDS = [
  // Hebrew
  'בחינה', 'מבחן', 'טיסה', 'ראיון', 'משמרת', 'ניתוח', 'דיון', 'הגנה',
  'הרצאה', 'סמינריון', 'מעבדה', 'קליניקה', 'בית משפט', 'חתונה', 'ברית',
  'בר מצווה', 'בת מצווה', 'לוויה', 'טקס',
  // English
  'exam', 'test', 'flight', 'interview', 'shift', 'surgery', 'hearing',
  'defense', 'lecture', 'seminar', 'lab', 'clinic', 'court', 'wedding',
  'ceremony', 'funeral',
]

/** Keywords that indicate AI-created flexible blocks */
const FLEXIBLE_KEYWORDS = [
  // Hebrew
  'ישיבה', 'פומודורו', 'בלוק עבודה', 'זמן לימוד', 'הכנה ל',
  // English
  'session', 'pomodoro', 'work block', 'study block', 'prep for', 'deep work',
]

export function classifyMobility(
  title: string,
  createdBy: 'user' | 'ai',
  _hasExactTime = true
): 'fixed' | 'flexible' | 'ask_first' {
  const lower = title.toLowerCase()

  // Check for fixed keywords first (highest priority)
  for (const kw of FIXED_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) return 'fixed'
  }

  // AI-created events default to flexible
  if (createdBy === 'ai') {
    return 'flexible'
  }

  // Check for flexible keywords (user might type "study block" etc.)
  for (const kw of FLEXIBLE_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) return 'flexible'
  }

  // User-created events default to ask_first
  return 'ask_first'
}

/** Mobility type display info */
export const MOBILITY_INFO = {
  fixed: { emoji: '🔒', en: 'Fixed', he: 'קבוע', color: '#EF4444' },
  flexible: { emoji: '🟡', en: 'Flexible', he: 'גמיש', color: '#FBBF24' },
  ask_first: { emoji: '🔵', en: 'Ask First', he: 'שאל לפני', color: '#3B82F6' },
} as const
