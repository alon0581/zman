/**
 * Maps onboarding answers (persona + challenge + day structure)
 * to a primary scheduling method and secondary methods.
 */

export type SchedulingMethod =
  | 'pomodoro'
  | 'deep_work'
  | 'eisenhower'
  | 'gtd'
  | 'time_blocking'
  | 'ivy_lee'

export interface MethodResult {
  primary: SchedulingMethod
  secondary: SchedulingMethod[]
}

/** Human-readable labels (Hebrew + English) */
export const METHOD_LABELS: Record<SchedulingMethod, { en: string; he: string; emoji: string; description_en: string; description_he: string }> = {
  pomodoro: {
    en: 'Pomodoro',
    he: 'פומודורו',
    emoji: '🍅',
    description_en: '25-min focused sessions with 5-min breaks',
    description_he: 'ישיבות מרוכזות של 25 דק\' עם הפסקות של 5 דק\'',
  },
  deep_work: {
    en: 'Deep Work',
    he: 'עבודה עמוקה',
    emoji: '🧠',
    description_en: '2-3 hour uninterrupted focus blocks',
    description_he: 'בלוקים של 2-3 שעות ריכוז ללא הפרעות',
  },
  eisenhower: {
    en: 'Eisenhower Matrix',
    he: 'מטריצת אייזנהאואר',
    emoji: '📊',
    description_en: 'Prioritize by urgency and importance',
    description_he: 'תעדוף לפי דחיפות וחשיבות',
  },
  gtd: {
    en: 'Getting Things Done',
    he: 'GTD — לגמור דברים',
    emoji: '📥',
    description_en: 'Capture, clarify, organize, review, engage',
    description_he: 'לכוד, הבהר, ארגן, סקור, בצע',
  },
  time_blocking: {
    en: 'Time Blocking',
    he: 'חסימת זמן',
    emoji: '📅',
    description_en: 'Dedicate specific blocks for specific tasks',
    description_he: 'הקצאת בלוקים ספציפיים למשימות ספציפיות',
  },
  ivy_lee: {
    en: 'Ivy Lee Method',
    he: 'שיטת אייבי לי',
    emoji: '📝',
    description_en: '6 most important tasks each day, in order',
    description_he: '6 המשימות הכי חשובות כל יום, לפי סדר',
  },
}

/**
 * Core mapping logic.
 * Uses persona + challenge + day_structure to pick the best method.
 */
export function mapToMethod(
  persona: string,
  challenge: string,
  dayStructure: string
): MethodResult {
  // Student paths
  if (persona === 'student') {
    if (challenge === 'procrastination') {
      return { primary: 'pomodoro', secondary: ['time_blocking', 'ivy_lee'] }
    }
    if (challenge === 'overwhelmed') {
      return { primary: 'eisenhower', secondary: ['pomodoro', 'ivy_lee'] }
    }
    if (challenge === 'focus') {
      return { primary: 'pomodoro', secondary: ['deep_work'] }
    }
    if (challenge === 'scattered') {
      return { primary: 'time_blocking', secondary: ['pomodoro', 'ivy_lee'] }
    }
    if (challenge === 'goals') {
      return { primary: 'ivy_lee', secondary: ['time_blocking', 'pomodoro'] }
    }
  }

  // Manager / employee paths
  if (persona === 'manager') {
    if (challenge === 'overwhelmed') {
      return { primary: 'eisenhower', secondary: ['gtd'] }
    }
    if (challenge === 'scattered') {
      return { primary: 'gtd', secondary: ['eisenhower', 'time_blocking'] }
    }
    if (challenge === 'focus') {
      return { primary: 'time_blocking', secondary: ['deep_work'] }
    }
    return { primary: 'eisenhower', secondary: ['gtd', 'time_blocking'] }
  }

  // Entrepreneur / freelancer paths
  if (persona === 'entrepreneur') {
    if (challenge === 'scattered' || challenge === 'focus') {
      return { primary: 'deep_work', secondary: ['time_blocking'] }
    }
    if (challenge === 'goals') {
      return { primary: 'ivy_lee', secondary: ['deep_work', 'time_blocking'] }
    }
    if (dayStructure === 'independent') {
      return { primary: 'deep_work', secondary: ['time_blocking'] }
    }
    return { primary: 'time_blocking', secondary: ['deep_work', 'ivy_lee'] }
  }

  // Developer / technical paths
  if (persona === 'developer') {
    if (challenge === 'focus') {
      return { primary: 'pomodoro', secondary: ['deep_work'] }
    }
    if (challenge === 'scattered') {
      return { primary: 'time_blocking', secondary: ['pomodoro', 'deep_work'] }
    }
    if (dayStructure === 'independent') {
      return { primary: 'deep_work', secondary: ['pomodoro'] }
    }
    return { primary: 'pomodoro', secondary: ['deep_work', 'time_blocking'] }
  }

  // Fallback for 'other' or unmatched
  if (dayStructure === 'fixed') {
    return { primary: 'time_blocking', secondary: ['pomodoro', 'ivy_lee'] }
  }
  if (dayStructure === 'independent') {
    return { primary: 'deep_work', secondary: ['time_blocking'] }
  }
  return { primary: 'time_blocking', secondary: ['pomodoro', 'ivy_lee'] }
}
