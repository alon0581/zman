/**
 * methodRules.ts — turns each SchedulingMethod into concrete block-shaping numbers.
 *
 * The contract (see types.ts, MethodRules): these numbers MUST agree with what
 * METHOD_LABELS already tells the user in methodMapper.ts. The UI is the promise;
 * this file is the thing that has to keep it. Every entry below is derived from
 * its description_en/description_he — read the label, then set the numbers.
 *
 * METHOD_RULES is an exhaustive Record over SchedulingMethod, so adding a 19th
 * method to that union is a compile error here until it gets configured.
 *
 * This is THE table. Every number below has exactly one home and is read, never
 * copied: `breakMinutes` / `breakAfterMinutes` by place.ts and plan.ts,
 * `kanban.maxSessionsPerDay` also by boardRules.ts as the board's WIP limit, and
 * the pomodoro / 52-17 / time_boxing / theme_days numbers by systemPrompt.ts,
 * which interpolates them rather than restating them. A second copy of any of
 * these has already gone wrong twice in this codebase (METHOD_SESSION_HOURS,
 * and three different values for Kanban's WIP limit), so if you need one of
 * these numbers somewhere new, import it.
 */

import { SchedulingMethod, METHOD_LABELS } from './methodMapper'
import { MethodRules, Weekday, Category } from './types'

// ── Neutral defaults for prioritisation frameworks ──────────────────────────
//
// eisenhower, gtd, moscow and okr are about WHAT to do and in what order, not
// about how long a block should be or whether it must be contiguous. Their
// METHOD_LABELS descriptions say nothing about session length ("prioritize by
// urgency and importance", "capture, clarify, organize, review, engage"), so
// there is no user-facing promise to keep here — we pick sensible general-
// purpose block numbers instead of inventing a shape the method never claimed.
// A 45-minute default session, capped between 25 and 90 minutes, mirrors a
// normal work-block length without implying pomodoro-style breaks or
// deep-work-style contiguity, since neither is part of these methods' pitch.
//
// 45, not 50, and that is a correction rather than a preference. plan.ts snaps
// every nominal length with `roundToQuarter` before `clampBlock`, because
// candidate starts live on a 15-minute grid (place.ts, GRANULARITY_MINUTES) and
// a schedule that reads 10:00–10:50, 11:05–11:55 is noise a person has to
// decode. roundToQuarter(50) is 45, so the configured 50 could never be
// delivered by any of these four methods — the number was decoration. Fixing the
// rounding instead would have been the wrong half to change: the grid is the
// engine's whole notion of a legible time, whereas "a normal work block" is
// happy at 45. The one number a method configures must be the one it schedules,
// which is also what makes METHOD_FIT (score.ts) able to score a full mark
// instead of permanently topping out at 0.9 of its weight.
const NEUTRAL_PRIORITIZATION_DEFAULTS: Omit<MethodRules, 'hardestFirst'> = {
  sessionMinutes: 45,
  minBlock: 25,
  maxBlock: 90,
  maxSessionsPerDay: 6,
  preferContiguous: false,
  dailyCapMinutes: 360, // 6 hours — a full but not overloaded workday of scheduled blocks
}

export const METHOD_RULES: Record<SchedulingMethod, MethodRules> = {
  // "25-min focused sessions with 5-min breaks" — METHOD_LABELS.pomodoro
  //
  // The break is real: consecutive sessions land exactly 5 minutes apart and
  // nothing may be booked into that gap. It costs neither a session slot nor a
  // minute of dailyCapMinutes, because it is empty time rather than a block —
  // which is what keeps maxSessionsPerDay honest at eight actual sessions.
  pomodoro: {
    sessionMinutes: 25,
    minBlock: 25,
    maxBlock: 25,
    breakAfterMinutes: 25,
    breakMinutes: 5,
    maxSessionsPerDay: 8, // 8 x (25+5) = 4h of pomodoro cycles, a solid focused day
    preferContiguous: false, // the whole point is short sessions separated by breaks
    hardestFirst: false,
    dailyCapMinutes: 240,
  },

  // "2-3 hour uninterrupted focus blocks" — METHOD_LABELS.deep_work
  deep_work: {
    sessionMinutes: 150, // midpoint of 2-3h
    minBlock: 120,
    maxBlock: 180,
    maxSessionsPerDay: 2, // two 2-3h blocks is already most of a productive day
    preferContiguous: true, // "uninterrupted" is the entire premise
    hardestFirst: false,
    dailyCapMinutes: 300,
  },

  // "Prioritize by urgency and importance" — no block-shape promise made.
  eisenhower: {
    ...NEUTRAL_PRIORITIZATION_DEFAULTS,
    hardestFirst: false, // Eisenhower sorts by urgency/importance quadrant, not difficulty
  },

  // "Capture, clarify, organize, review, engage" — a workflow, not a block shape.
  gtd: {
    ...NEUTRAL_PRIORITIZATION_DEFAULTS,
    hardestFirst: false,
  },

  // "Dedicate specific blocks for specific tasks" — METHOD_LABELS.time_blocking.
  // Classic time blocking uses full-length task-sized blocks, longer than a
  // pomodoro sprint but without deep work's strict contiguity requirement.
  time_blocking: {
    sessionMinutes: 60,
    minBlock: 30,
    maxBlock: 120,
    maxSessionsPerDay: 6,
    preferContiguous: false,
    hardestFirst: false,
    dailyCapMinutes: 360,
  },

  // "6 most important tasks each day, in order" — METHOD_LABELS.ivy_lee.
  // Six discrete tasks a day is the entire method, so maxSessionsPerDay is the
  // one number the description pins down exactly; block length is a normal
  // task-sized session.
  ivy_lee: {
    sessionMinutes: 60,
    minBlock: 30,
    maxBlock: 90,
    maxSessionsPerDay: 6,
    preferContiguous: false,
    hardestFirst: false, // ordered by importance, not necessarily hardest-first
    dailyCapMinutes: 360,
  },

  // "Do your hardest task first thing every morning" — METHOD_LABELS.eat_the_frog.
  eat_the_frog: {
    sessionMinutes: 90,
    minBlock: 45,
    maxBlock: 150,
    maxSessionsPerDay: 4,
    preferContiguous: true, // the frog itself should not be chopped into fragments
    hardestFirst: true,
    dailyCapMinutes: 300,
  },

  // "Dedicate each weekday to one theme/type of work" — METHOD_LABELS.theme_days.
  // Sun-Thu are workdays in Israel; theme days need a theme, so we spread the
  // most common categories across them. Fri/Sat are the weekend and stay
  // themeless (Shabbat) — see student-week.ts fixture, which leaves them free.
  theme_days: {
    sessionMinutes: 120,
    minBlock: 60,
    maxBlock: 180,
    maxSessionsPerDay: 3,
    preferContiguous: true, // a themed day works best as few big same-category blocks
    hardestFirst: false,
    dailyCapMinutes: 360,
    themeDays: {
      0: 'study',    // Sunday — start-of-week deep study
      1: 'work',     // Monday
      2: 'study',    // Tuesday
      3: 'work',     // Wednesday
      4: 'admin',    // Thursday — wrap-up / admin before the weekend
      // 5 (Friday), 6 (Saturday) intentionally omitted: weekend / Shabbat
    } as Partial<Record<Weekday, Category>>,
  },

  // "Identify the one task that makes everything else easier" — METHOD_LABELS.the_one_thing.
  // A single dominant block a day, sized like deep work since the premise is
  // the same "protect this one thing" focus.
  the_one_thing: {
    sessionMinutes: 120,
    minBlock: 60,
    maxBlock: 180,
    maxSessionsPerDay: 1, // literally "the one thing"
    preferContiguous: true,
    hardestFirst: false,
    dailyCapMinutes: 180,
  },

  // "Weekly: review, clear inboxes, plan next week" — METHOD_LABELS.weekly_review.
  // One weekly session, not a daily rhythm — sized generously since it covers
  // a whole week's worth of review and planning.
  weekly_review: {
    sessionMinutes: 60,
    minBlock: 30,
    maxBlock: 90,
    maxSessionsPerDay: 1,
    preferContiguous: true,
    hardestFirst: false,
    dailyCapMinutes: 90,
  },

  // "Set 3-5 quarterly objectives with key results" — METHOD_LABELS.okr.
  // A goal-setting framework, not a daily block shape — neutral defaults.
  okr: {
    ...NEUTRAL_PRIORITIZATION_DEFAULTS,
    hardestFirst: false,
  },

  // "To Do -> In Progress -> Done. Limit work-in-progress." — METHOD_LABELS.kanban.
  // Kanban limits WIP, it doesn't dictate session length; a moderate block
  // keeps one card in flight at a time without pomodoro-style forced breaks.
  kanban: {
    sessionMinutes: 60,
    minBlock: 30,
    maxBlock: 120,
    // "Limit work-in-progress" as a number, and it has TWO readers: the engine's
    // per-day session ceiling and BOARD_RULES.kanban.wipLimit, which imports it.
    // The board and the calendar have to agree — a board that refuses a 4th card
    // while the engine schedules a 4th block is the same lie in two windows.
    maxSessionsPerDay: 4,
    preferContiguous: false,
    hardestFirst: false,
    dailyCapMinutes: 300,
  },

  // "Hard timeboxes — when time is up, move on" — METHOD_LABELS.time_boxing.
  // Distinguished from time_blocking by strictness (min == max: no drift), not
  // by a different default length.
  time_boxing: {
    sessionMinutes: 45,
    minBlock: 45,
    maxBlock: 45,
    maxSessionsPerDay: 6,
    preferContiguous: false,
    hardestFirst: false,
    dailyCapMinutes: 300,
  },

  // "Must / Should / Could / Won't — rank tasks by necessity" — METHOD_LABELS.moscow.
  moscow: {
    ...NEUTRAL_PRIORITIZATION_DEFAULTS,
    hardestFirst: false,
  },

  // "52 min focused work + 17 min real break (research-based)" — METHOD_LABELS.rule_5217.
  rule_5217: {
    sessionMinutes: 52,
    minBlock: 52,
    maxBlock: 52,
    breakAfterMinutes: 52,
    breakMinutes: 17,
    maxSessionsPerDay: 5, // 5 x 69min ~= 5.75h, a full research-cited workday
    preferContiguous: false,
    hardestFirst: false,
    dailyCapMinutes: 260,
  },

  // "1-2 week sprints with clear goals and retrospectives" — METHOD_LABELS.scrum.
  // Sprint cadence lives above the day; day-to-day this behaves like ordinary
  // task-sized time blocking with room for a daily stand-up-sized slot.
  scrum: {
    sessionMinutes: 60,
    minBlock: 30,
    maxBlock: 120,
    maxSessionsPerDay: 5,
    preferContiguous: false,
    hardestFirst: false,
    dailyCapMinutes: 360,
  },

  // "Match task difficulty to your energy level, not just time" — METHOD_LABELS.energy_management.
  // No fixed block length is promised; the engine expresses this method mainly
  // through ENERGY_MATCH scoring (score.ts), so the shape here is a flexible
  // mid-length session with no contiguity requirement.
  energy_management: {
    sessionMinutes: 60,
    minBlock: 30,
    maxBlock: 150,
    maxSessionsPerDay: 5,
    preferContiguous: false,
    hardestFirst: false,
    dailyCapMinutes: 300,
  },

  // "Treat 12 weeks as a full year — create urgency and focus" — METHOD_LABELS.twelve_week_year.
  // Like scrum, the cadence is measured in weeks; daily shape defaults to
  // focused, deadline-driven blocks slightly longer than a plain time block.
  twelve_week_year: {
    sessionMinutes: 90,
    minBlock: 45,
    maxBlock: 150,
    maxSessionsPerDay: 4,
    preferContiguous: true,
    hardestFirst: false,
    dailyCapMinutes: 300,
  },
}

/** Looks up the rules for one method. Thin wrapper so callers don't reach into the map directly. */
export function getMethodRules(method: SchedulingMethod): MethodRules {
  return METHOD_RULES[method]
}

// Touch METHOD_LABELS so this file breaks loudly (not silently) if a method is
// ever removed from methodMapper without a corresponding rules update — the
// exhaustiveness check below cross-references the same key set.
const _labelKeys = Object.keys(METHOD_LABELS) as SchedulingMethod[]
const _ruleKeys = Object.keys(METHOD_RULES) as SchedulingMethod[]
if (_labelKeys.length !== _ruleKeys.length) {
  // This can only fire if METHOD_LABELS and METHOD_RULES fall out of sync at
  // runtime (e.g. via a future non-type-checked edit) — the TS exhaustive
  // Record above already prevents it at compile time for normal edits.
  throw new Error('[methodRules.ts] METHOD_RULES is out of sync with METHOD_LABELS')
}
