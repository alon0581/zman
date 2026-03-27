/**
 * Maps onboarding answers (persona + challenge + day structure)
 * to a primary scheduling method and secondary methods.
 *
 * Mapping follows the spec exactly:
 * - student  + procrastination + fixed       → Pomodoro + Eat the Frog
 * - entrepreneur + scattered + independent   → Deep Work + Theme Days
 * - manager  + overwhelmed + mixed           → Eisenhower + GTD
 * - developer + focus + mixed                → Pomodoro + Kanban
 * - default                                  → Time Blocking + Ivy Lee
 */

export type SchedulingMethod =
  | 'pomodoro'
  | 'deep_work'
  | 'eisenhower'
  | 'gtd'
  | 'time_blocking'
  | 'ivy_lee'
  | 'eat_the_frog'
  | 'theme_days'
  | 'the_one_thing'
  | 'weekly_review'
  | 'okr'
  | 'kanban'
  | 'time_boxing'
  | 'moscow'
  | 'rule_5217'
  | 'scrum'
  | 'energy_management'
  | 'twelve_week_year'

export interface MethodResult {
  primary: SchedulingMethod
  secondary: SchedulingMethod[]
}

/** Human-readable labels (Hebrew + English) */
export const METHOD_LABELS: Record<SchedulingMethod, {
  en: string; he: string; emoji: string
  description_en: string; description_he: string
}> = {
  pomodoro: {
    en: 'Pomodoro', he: 'פומודורו', emoji: '🍅',
    description_en: '25-min focused sessions with 5-min breaks',
    description_he: 'ישיבות מרוכזות של 25 דק\' עם הפסקות של 5 דק\'',
  },
  deep_work: {
    en: 'Deep Work', he: 'עבודה עמוקה', emoji: '🧠',
    description_en: '2-3 hour uninterrupted focus blocks',
    description_he: 'בלוקים של 2-3 שעות ריכוז ללא הפרעות',
  },
  eisenhower: {
    en: 'Eisenhower Matrix', he: 'מטריצת אייזנהאואר', emoji: '📊',
    description_en: 'Prioritize by urgency and importance',
    description_he: 'תעדוף לפי דחיפות וחשיבות',
  },
  gtd: {
    en: 'Getting Things Done', he: 'GTD — לגמור דברים', emoji: '📥',
    description_en: 'Capture, clarify, organize, review, engage',
    description_he: 'לכוד, הבהר, ארגן, סקור, בצע',
  },
  time_blocking: {
    en: 'Time Blocking', he: 'חסימת זמן', emoji: '📅',
    description_en: 'Dedicate specific blocks for specific tasks',
    description_he: 'הקצאת בלוקים ספציפיים למשימות ספציפיות',
  },
  ivy_lee: {
    en: 'Ivy Lee Method', he: 'שיטת אייבי לי', emoji: '📝',
    description_en: '6 most important tasks each day, in order',
    description_he: '6 המשימות הכי חשובות כל יום, לפי סדר',
  },
  eat_the_frog: {
    en: 'Eat the Frog', he: 'אכול את הצפרדע', emoji: '🐸',
    description_en: 'Do your hardest task first thing every morning',
    description_he: 'התחל כל יום מהמשימה הכי קשה/מפחידה',
  },
  theme_days: {
    en: 'Theme Days', he: 'ימים עם נושא', emoji: '🗓️',
    description_en: 'Dedicate each weekday to one theme/type of work',
    description_he: 'כל יום שבוע מוקדש לנושא אחד (עמוק, פגישות...)',
  },
  the_one_thing: {
    en: 'The One Thing', he: 'הדבר האחד', emoji: '🎯',
    description_en: 'Identify the one task that makes everything else easier',
    description_he: 'מה הדבר האחד שאם תעשה אותו — שאר הדברים יהיו קלים?',
  },
  weekly_review: {
    en: 'Weekly Review', he: 'סקירה שבועית', emoji: '🔄',
    description_en: 'Weekly: review, clear inboxes, plan next week',
    description_he: 'סקור הישגים, נקה inboxes, תכנן שבוע הבא',
  },
  okr: {
    en: 'OKR', he: 'OKR — מטרות ותוצאות', emoji: '🏆',
    description_en: 'Set 3-5 quarterly objectives with key results',
    description_he: '3-5 מטרות רבעוניות עם 2-3 תוצאות מדידות כל אחת',
  },
  kanban: {
    en: 'Kanban', he: 'קנבן', emoji: '🗂️',
    description_en: 'To Do → In Progress → Done. Limit work-in-progress.',
    description_he: 'לעשות → בתהליך → בוצע. הגבל עבודה במקביל.',
  },
  time_boxing: {
    en: 'Time Boxing', he: 'תיבוב זמן', emoji: '⏱️',
    description_en: 'Hard timeboxes — when time is up, move on',
    description_he: 'תיבות זמן קשוחות — כשהזמן נגמר, עוברים הלאה',
  },
  moscow: {
    en: 'MoSCoW Method', he: 'שיטת MoSCoW', emoji: '🎯',
    description_en: 'Must / Should / Could / Won\'t — rank tasks by necessity',
    description_he: 'חייב / כדאי / אפשרי / לא עכשיו — מיון לפי הכרח',
  },
  rule_5217: {
    en: '52/17 Rule', he: 'כלל 52/17', emoji: '⏲️',
    description_en: '52 min focused work + 17 min real break (research-based)',
    description_he: '52 דקות עבודה + 17 דקות הפסקה אמיתית (מבוסס מחקר)',
  },
  scrum: {
    en: 'Scrum / Sprints', he: 'סקראם / ספרינטים', emoji: '🏃',
    description_en: '1–2 week sprints with clear goals and retrospectives',
    description_he: 'ספרינטים של 1–2 שבועות עם יעדים ברורים וריטרוספקטיבה',
  },
  energy_management: {
    en: 'Energy Management', he: 'ניהול אנרגיה', emoji: '⚡',
    description_en: 'Match task difficulty to your energy level, not just time',
    description_he: 'התאם קושי משימה לרמת האנרגיה שלך — לא רק לזמן פנוי',
  },
  twelve_week_year: {
    en: '12 Week Year', he: '12 שבועות כשנה', emoji: '📆',
    description_en: 'Treat 12 weeks as a full year — create urgency and focus',
    description_he: 'תייחס ל-12 שבועות כאל שנה שלמה — צור דחיפות ומיקוד',
  },
}

/**
 * Core mapping logic — 3-way match: persona + challenge + dayStructure.
 * Follows the spec table exactly.
 */
export function mapToMethod(
  persona: string,
  challenge: string,
  dayStructure: string
): MethodResult {

  // ── STUDENT ────────────────────────────────────────────────
  if (persona === 'student') {
    if (challenge === 'procrastination') {
      if (dayStructure === 'fixed')
        return { primary: 'pomodoro', secondary: ['eat_the_frog', 'time_blocking', 'ivy_lee'] }
      return { primary: 'pomodoro', secondary: ['time_blocking', 'ivy_lee'] }
    }
    if (challenge === 'overwhelmed')
      return { primary: 'eisenhower', secondary: ['pomodoro', 'ivy_lee'] }
    if (challenge === 'focus')
      return { primary: 'pomodoro', secondary: ['deep_work'] }
    if (challenge === 'scattered')
      return { primary: 'time_blocking', secondary: ['pomodoro', 'ivy_lee'] }
    if (challenge === 'goals')
      return { primary: 'ivy_lee', secondary: ['time_blocking', 'pomodoro'] }
    // student default
    return { primary: 'pomodoro', secondary: ['time_blocking', 'ivy_lee'] }
  }

  // ── MANAGER / EMPLOYEE ─────────────────────────────────────
  if (persona === 'manager') {
    if (challenge === 'overwhelmed') {
      if (dayStructure === 'mixed')
        return { primary: 'eisenhower', secondary: ['gtd', 'okr', 'weekly_review', 'moscow'] }
      return { primary: 'eisenhower', secondary: ['gtd', 'weekly_review', 'moscow'] }
    }
    if (challenge === 'scattered')
      return { primary: 'gtd', secondary: ['eisenhower', 'time_blocking'] }
    if (challenge === 'focus')
      return { primary: 'time_blocking', secondary: ['deep_work'] }
    if (challenge === 'goals')
      return { primary: 'okr', secondary: ['eisenhower', 'weekly_review'] }
    // manager default
    return { primary: 'eisenhower', secondary: ['gtd', 'time_blocking'] }
  }

  // ── ENTREPRENEUR / FREELANCER ──────────────────────────────
  if (persona === 'entrepreneur') {
    if (challenge === 'scattered') {
      if (dayStructure === 'independent')
        return { primary: 'deep_work', secondary: ['theme_days', 'the_one_thing', 'weekly_review'] }
      return { primary: 'deep_work', secondary: ['the_one_thing', 'weekly_review'] }
    }
    if (challenge === 'focus') {
      if (dayStructure === 'independent')
        return { primary: 'deep_work', secondary: ['theme_days'] }
      return { primary: 'deep_work', secondary: ['time_blocking'] }
    }
    if (challenge === 'goals')
      return { primary: 'ivy_lee', secondary: ['deep_work', 'time_blocking', 'twelve_week_year'] }
    if (challenge === 'overwhelmed')
      return { primary: 'gtd', secondary: ['time_blocking', 'weekly_review'] }
    // entrepreneur default
    return { primary: 'time_blocking', secondary: ['deep_work', 'ivy_lee'] }
  }

  // ── DEVELOPER / TECHNICAL ─────────────────────────────────
  if (persona === 'developer') {
    if (challenge === 'focus') {
      if (dayStructure === 'mixed')
        return { primary: 'pomodoro', secondary: ['kanban', 'deep_work', 'time_boxing', 'rule_5217'] }
      return { primary: 'pomodoro', secondary: ['deep_work', 'rule_5217'] }
    }
    if (challenge === 'scattered')
      return { primary: 'time_blocking', secondary: ['kanban', 'pomodoro', 'scrum'] }
    if (challenge === 'procrastination')
      return { primary: 'pomodoro', secondary: ['eat_the_frog', 'kanban'] }
    if (challenge === 'goals')
      return { primary: 'okr', secondary: ['scrum', 'twelve_week_year'] }
    if (dayStructure === 'independent')
      return { primary: 'deep_work', secondary: ['pomodoro', 'scrum'] }
    // developer default
    return { primary: 'pomodoro', secondary: ['deep_work', 'kanban', 'scrum'] }
  }

  // ── FALLBACK (other / unmatched) ───────────────────────────
  if (dayStructure === 'fixed')
    return { primary: 'time_blocking', secondary: ['pomodoro', 'ivy_lee'] }
  if (dayStructure === 'independent')
    return { primary: 'deep_work', secondary: ['time_blocking'] }
  return { primary: 'time_blocking', secondary: ['pomodoro', 'ivy_lee'] }
}
