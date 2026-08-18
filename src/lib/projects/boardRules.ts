/**
 * boardRules.ts — the board takes the shape of whoever is looking at it.
 *
 * Keyed on `scheduling_method`, not on `persona`, and that is the whole design
 * decision. The two are not siblings: method is DOWNSTREAM of persona —
 *
 *     scheduling_method = the user's own choice ?? mapToMethod(persona, challenge, day_structure)
 *
 * so reading the method is reading the person through the function that already
 * exists, plus their correction to it. Three practical consequences:
 *
 *   1. `persona` has exactly one writer (the complete_onboarding tool) and no UI
 *      anywhere to view or fix it. `scheduling_method` has three writers, one of
 *      which is a backfill that runs on every app load, and a Settings picker the
 *      user can change whenever it stops fitting.
 *   2. A wrong method is a LEGIBLE mismatch against a labelled control the user
 *      can see and change in one tap. A wrong persona is a silent default. Always
 *      key on the axis whose wrongness is visible.
 *   3. The method already self-corrects: the assistant is told to notice when the
 *      user fights it and save `method_feedback`. The board inherits that for free.
 *
 * Shape of the solution: STRUCTURE is 5-valued (five presets), COPY is 18-valued
 * (strings), and the RENDERER is 1-valued. So this is 18 rows of config, not
 * eighteen implementations.
 *
 * The number rule, inherited from methodRules.ts: anything that already exists
 * elsewhere is DERIVED, never re-typed here. That rule is written in blood —
 * `METHOD_SESSION_HOURS` was a second session-length table that disagreed with
 * `METHOD_RULES[m].sessionMinutes` on 10 of 18 methods, and it was deleted rather
 * than synced, because a second table can drift again and a deleted one cannot.
 * So there is no session length and no default task size below, and `wipLimit`
 * for kanban is read from METHOD_RULES rather than restated (see FLOW).
 */

import { SchedulingMethod } from '@/lib/scheduling/methodMapper'
import { METHOD_RULES } from '@/lib/scheduling/methodRules'
import { BoardColumn, BoardRules, CardSignal } from './types'

// ── Column constructors ─────────────────────────────────────────────────────

const col = (
  id: string,
  source: BoardColumn['source'],
  he: string,
  en: string,
  over: Partial<BoardColumn> = {},
): BoardColumn => ({
  id,
  source,
  label: { he, en },
  droppable: source.startsWith('status:'),
  hideWhenEmpty: source.startsWith('derived:'),
  ...over,
})

const PENDING = (he = 'ממתין', en = 'Backlog') => col('pending', 'status:pending', he, en)
const DOING = (he = 'בתהליך', en = 'In Progress') => col('doing', 'status:in_progress', he, en)
const DONE = (he = 'בוצע', en = 'Done') => col('done', 'status:done', he, en)
const BLOCKED = (he = 'תקוע', en = 'Blocked') => col('blocked', 'derived:blocked', he, en)
const URGENT = (he = 'עכשיו', en = 'Now') => col('urgent', 'derived:urgent', he, en)

// ── The five structural presets ─────────────────────────────────────────────

type Structure = Pick<BoardRules, 'columns' | 'wipLimit' | 'signalOrder' | 'nextStep' | 'investedUnit'>

/**
 * Work pulled through stages, with a cap on how much is in flight.
 *
 * The cap is READ from `METHOD_RULES.kanban.maxSessionsPerDay`, not typed here.
 * "Limit work-in-progress" is one commitment the user made, and it had grown
 * three different values: the rules said 4, this preset said 3, and the system
 * prompt said "max 3" twice more. The rules table wins because it is the one the
 * calendar obeys — a board that caps you at 3 while the engine happily schedules
 * a 4th block that day is the same class of lie as a promised break that never
 * gets scheduled. FLOW is Kanban's own preset; scrum reuses its columns and
 * overrides the number, so this is not a hidden default for anyone else.
 */
const FLOW: Structure = {
  columns: [PENDING(), DOING(), BLOCKED(), DONE()],
  wipLimit: METHOD_RULES.kanban.maxSessionsPerDay,
  signalOrder: ['progress', 'next', 'invested', 'deadline'],
  nextStep: 'oldest_in_progress',
  investedUnit: 'hours',
}

/** Capture first, clarify second. The inbox itself is a status. */
const INTAKE: Structure = {
  columns: [PENDING('נכנס', 'Inbox'), col('ready', 'status:in_progress', 'הפעולה הבאה', 'Next Actions'), BLOCKED(), DONE()],
  wipLimit: null,
  signalOrder: ['next', 'progress', 'deadline', 'invested'],
  nextStep: 'next_action',
  investedUnit: 'hours',
}

/** Measured against an outcome, not a date. */
const OUTCOME: Structure = {
  columns: [PENDING('לא התחיל', 'Not started'), DOING(), DONE('הושג', 'Achieved')],
  wipLimit: null,
  signalOrder: ['progress', 'deadline', 'next', 'invested'],
  nextStep: 'top_ranked',
  investedUnit: 'hours',
}

/**
 * Ranked reading. The urgent column is a LENS, not a stage — you cannot drag a
 * task into "urgent", you become urgent — so it is not droppable, and saying so
 * beats shipping a drop target that silently does nothing.
 */
const PRIORITY: Structure = {
  columns: [URGENT(), PENDING('ממתין', 'Queued'), DOING(), DONE()],
  wipLimit: null,
  signalOrder: ['next', 'deadline', 'progress', 'invested'],
  nextStep: 'top_ranked',
  investedUnit: 'hours',
}

/**
 * The honest answer for methods with no natural board: a list with a counter.
 * Pomodoro does not have stages, it has sessions — but the status circle in the
 * board UI still writes pending -> in_progress on the very first tap, regardless
 * of method. Every status the UI can set needs a column to land in, or the task
 * disappears from the board with no way back. So this preset keeps its own
 * in_progress column too, even though the method's own vocabulary does not
 * otherwise distinguish "doing" from "to do".
 */
const SESSION: Structure = {
  columns: [PENDING('לעשות', 'To do'), DOING(), DONE()],
  wipLimit: null,
  signalOrder: ['next', 'invested', 'progress', 'deadline'],
  nextStep: 'next_scheduled_block',
  investedUnit: 'sessions',
}

// ── Copy ────────────────────────────────────────────────────────────────────

interface Copy {
  boardTitle: { he: string; en: string }
  itemNoun: { he: string; en: string }
  addLabel: { he: string; en: string }
  emptyState: { he: string; en: string }
}

const copy = (
  titleHe: string, titleEn: string,
  nounHe: string, nounEn: string,
  addHe: string, addEn: string,
  emptyHe: string, emptyEn: string,
): Copy => ({
  boardTitle: { he: titleHe, en: titleEn },
  itemNoun: { he: nounHe, en: nounEn },
  addLabel: { he: addHe, en: addEn },
  emptyState: { he: emptyHe, en: emptyEn },
})

const TASK_COPY = copy(
  'לוח', 'Board', 'משימה', 'task', 'הוסף משימה', 'Add task',
  'עוד לא התחלת. הוסף משימה אחת ואמצא לה זמן.',
  'Nothing here yet. Add one task and I will find it a slot.',
)

const make = (s: Structure, c: Copy, cycleDays: number | null = null, over: Partial<BoardRules> = {}): BoardRules => ({
  ...s, ...c, cycleDays, ...over,
})

// ── The table ───────────────────────────────────────────────────────────────

/**
 * Exhaustive over SchedulingMethod: a 19th method is a compile error until it has
 * been given a board. Same forcing function as METHOD_RULES.
 */
export const BOARD_RULES: Record<SchedulingMethod, BoardRules> = {
  kanban: make(FLOW, copy(
    'לוח קנבן', 'Kanban board', 'כרטיס', 'card', 'הוסף כרטיס', 'Add card',
    // Interpolated for the same reason FLOW.wipLimit is: a number spelled out in
    // copy is still a copy of the number, and this one was the fourth.
    `אין כאן כלום עדיין. משוך משימה אחת ל"בתהליך" — לא יותר מ-${FLOW.wipLimit} בו-זמנית.`,
    `Nothing here yet. Pull one task into In Progress — no more than ${FLOW.wipLimit} at a time.`,
  )),

  scrum: make({ ...FLOW, wipLimit: 5, signalOrder: ['deadline', 'progress', 'next', 'invested'] }, copy(
    'ספרינט', 'Sprint', 'פריט ספרינט', 'sprint item', 'הוסף פריט', 'Add item',
    'הספרינט ריק. מה נכנס לשבועיים הקרובים?',
    'The sprint is empty. What goes into the next two weeks?',
  ), 14),

  gtd: make(INTAKE, copy(
    'לוח GTD', 'GTD board', 'פעולה', 'action', 'לכוד', 'Capture',
    'התיבה ריקה. זרוק לכאן כל מה שבראש — נבהיר אחר כך.',
    'Inbox is empty. Dump whatever is on your mind — we will clarify later.',
  )),

  weekly_review: make(INTAKE, copy(
    'סקירה שבועית', 'Weekly review', 'פריט לסקירה', 'review item', 'הוסף פריט', 'Add item',
    'אין מה לסקור עדיין. הוסף את מה שנשאר מהשבוע.',
    'Nothing to review yet. Add what is left over from the week.',
  ), 7),

  okr: make(OUTCOME, copy(
    'מטרות ותוצאות', 'Objectives', 'תוצאת מפתח', 'key result', 'הוסף תוצאת מפתח', 'Add key result',
    'עדיין אין תוצאות מפתח. מה המטרה, ואיך נדע שהגעת אליה?',
    'No key results yet. What is the objective, and how will you know you hit it?',
  ), 90),

  twelve_week_year: make(OUTCOME, copy(
    '12 שבועות', '12 Week Year', 'טקטיקה', 'tactic', 'הוסף טקטיקה', 'Add tactic',
    'אין טקטיקות. מה צריך לקרות ב-12 השבועות האלה?',
    'No tactics yet. What has to happen in these 12 weeks?',
  ), 84),

  eisenhower: make(PRIORITY, copy(
    'מטריצת תעדוף', 'Priority matrix', 'משימה', 'task', 'הוסף משימה', 'Add task',
    'אין משימות לתעדף. הוסף כמה, ואסדר אותן לפי דחוף/חשוב.',
    'Nothing to prioritise. Add a few and I will sort them by urgent/important.',
  )),

  moscow: make({
    ...PRIORITY,
    columns: [URGENT('חייב', 'Must'), PENDING('כדאי', 'Should'), DOING(), DONE()],
  }, copy(
    'MoSCoW', 'MoSCoW', 'דרישה', 'requirement', 'הוסף דרישה', 'Add requirement',
    'אין דרישות. מה חייב לקרות, ומה רק כדאי?',
    'No requirements yet. What must happen, and what merely should?',
  )),

  ivy_lee: make({ ...PRIORITY, wipLimit: 6 }, copy(
    'שש המשימות', 'Top six', 'משימה', 'task', 'הוסף משימה', 'Add task',
    'עוד לא בחרת את השש של היום.',
    'You have not picked today\'s six yet.',
  )),

  eat_the_frog: make({
    ...PRIORITY,
    columns: [URGENT('הצפרדע', 'The Frog'), PENDING('ממתין', 'Queued'), DOING(), DONE()],
  }, copy(
    'הצפרדע', 'Eat the Frog', 'משימה', 'task', 'הוסף משימה', 'Add task',
    'אין צפרדע. מה הדבר שהכי בא לך לדחות?',
    'No frog yet. What are you most tempted to put off?',
  )),

  the_one_thing: make({
    ...PRIORITY,
    // maxSessionsPerDay is 1 for this method, so a backlog column would contradict
    // the promise the method's own label makes on screen.
    columns: [URGENT('הדבר האחד', 'The One Thing'), DOING(), DONE()],
    wipLimit: 1,
    signalOrder: ['next', 'invested', 'progress', 'deadline'],
  }, copy(
    'הדבר האחד', 'The One Thing', 'הדבר האחד', 'the one thing', 'קבע את הדבר האחד', 'Set the one thing',
    'מה הדבר האחד שאם תעשה אותו, השאר יהיה קל יותר?',
    'What is the one thing that would make everything else easier?',
  )),

  pomodoro: make(SESSION, copy(
    'משימות', 'Tasks', 'משימה', 'task', 'הוסף משימה', 'Add task',
    'עוד לא התחלת. הוסף משימה אחת ואקבע לך פומודורו ראשון.',
    'Nothing yet. Add one task and I will schedule your first pomodoro.',
  )),

  rule_5217: make(SESSION, copy(
    'משימות', 'Tasks', 'משימה', 'task', 'הוסף משימה', 'Add task',
    'עוד לא התחלת. הוסף משימה ואקבע לך מקטע של 52 דקות.',
    'Nothing yet. Add a task and I will schedule a 52-minute stretch.',
  )),

  deep_work: make({
    ...SESSION,
    columns: [PENDING('מוכן לבלוק', 'Ready'), DOING('הבלוק הנוכחי', 'Current block'), DONE('הושלם', 'Done')],
    // "Uninterrupted" is the premise, so two things in flight is a contradiction.
    wipLimit: 1,
    investedUnit: 'hours',
  }, TASK_COPY),

  time_blocking: make({ ...SESSION, investedUnit: 'hours' }, copy(
    'בלוקים', 'Blocks', 'בלוק', 'block', 'הוסף בלוק', 'Add block',
    'אין בלוקים. הוסף משימה ואשבץ לה זמן.',
    'No blocks yet. Add a task and I will find it time.',
  )),

  time_boxing: make(SESSION, copy(
    'תיבות זמן', 'Timeboxes', 'תיבה', 'timebox', 'הוסף תיבה', 'Add timebox',
    'אין תיבות זמן. הוסף משימה ואגדיר לה תיבה קשוחה.',
    'No timeboxes yet. Add a task and I will give it a hard box.',
  )),

  theme_days: make({ ...SESSION, investedUnit: 'hours' }, TASK_COPY),

  energy_management: make({ ...SESSION, investedUnit: 'hours' }, TASK_COPY),
}

/**
 * The board's ONLY legal way to get rules.
 *
 * Always goes through a validated method — never `profile.scheduling_method`
 * directly. The live volume can contain a value written by an older build, and an
 * unknown string must degrade to a working board rather than an undefined lookup.
 */
export function boardRulesFor(method: SchedulingMethod | string | undefined): BoardRules {
  // hasOwnProperty, not `in`: `in` walks the prototype chain, so 'constructor',
  // 'toString' and friends would all resolve — returning Object.prototype members
  // typed as BoardRules and blowing up at the first property access.
  if (method && Object.prototype.hasOwnProperty.call(BOARD_RULES, method)) {
    return BOARD_RULES[method as SchedulingMethod]
  }
  return BOARD_RULES.time_blocking
}

/** The four signals, in this method's order. Kept as a helper so the card never indexes the table. */
export function signalOrderFor(method: SchedulingMethod | string | undefined): CardSignal[] {
  return [...boardRulesFor(method).signalOrder]
}
