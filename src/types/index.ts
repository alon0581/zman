export interface CalendarEvent {
  id: string
  user_id: string
  title: string
  description?: string
  start_time: string
  end_time: string
  is_all_day: boolean
  color?: string
  source: 'zman' | 'apple_calendar' | 'google_calendar'
  external_id?: string
  created_by: 'user' | 'ai'
  status: 'confirmed' | 'proposed'
  created_at: string
  series_id?: string          // groups all instances of a recurring event
  recurrence_rule?: string    // e.g. "weekly", "biweekly", "monthly"
  mobility_type?: 'fixed' | 'flexible' | 'ask_first'  // how movable this event is
  /**
   * Roll-up key: which Project this block's time counts towards. Denormalised on
   * purpose — invested-time is then one filter rather than an event->task->project
   * join across two JSON files, and deleting a task does not erase hours the
   * project really consumed.
   */
  project_id?: string
  /** The precise link. Retires title-prefix matching for project work. */
  ref?: { kind: 'event' | 'task' | 'project'; id: string }
}

export interface Task {
  id: string
  user_id: string
  title: string
  description?: string
  deadline?: string
  estimated_hours?: number
  priority: 'low' | 'medium' | 'high'
  status: 'pending' | 'in_progress' | 'done'
  parent_task_id?: string
  topic?: string
  created_at: string
  completed_at?: string
  /** Membership in a Project. `topic` remains a free-text lens; this is the real link. */
  project_id?: string
  /**
   * Task ids that must be done before this one can start. Optional and additive —
   * a task written before this existed reads as having no dependencies.
   * Consumed by the scheduling engine via PlacementRequest.dependsOn.
   */
  depends_on?: string[]
}

/**
 * What kind of thing a project is. Chosen explicitly by the user at creation —
 * never inferred from a profile field, because an inference that is wrong here
 * silently changes what the risk badge means.
 *
 * It controls two things and only two: the seeded task template, and whether a
 * deadline is expected at all. That second one is load-bearing: `build` usually
 * has no deadline, which is exactly the case where a green "on track" badge
 * would be a fabrication.
 */
export type ProjectKind = 'course' | 'deliverable' | 'build'

export interface Project {
  id: string
  user_id: string
  title: string
  kind: ProjectKind
  status: 'active' | 'paused' | 'done' | 'archived'
  created_at: string
  description?: string
  /** LocalISO or 'YYYY-MM-DD'. Absent is meaningful — see ProjectKind. */
  deadline?: string
  /** Hex; reused as the calendar colour for blocks this project generates. */
  color?: string
  /** Defaults to the title, so project tasks still group sensibly in TasksPanel. */
  topic?: string
  completed_at?: string
  archived_at?: string
}

export interface UserProfile {
  user_id: string
  /**
   * VESTIGIAL — read by nothing, written by nothing. Do not reintroduce a read.
   *
   * It had no UI, no tool, and was absent from complete_onboarding's parameters,
   * yet it took precedence over wake_time/sleep_time in three places — so a value
   * on a profile silently beat the controls the user can actually edit. No profile
   * on the production volume carries it. The field is kept (not deleted) only so
   * that an older profile.json still parses; the day window comes from
   * wake_time/sleep_time alone.
   */
  preferred_hours?: { start: number; end: number }
  productivity_peak?: 'morning' | 'afternoon' | 'evening'
  sleep_time?: string
  wake_time?: string
  autonomy_mode: 'suggest' | 'auto' | 'hybrid'
  theme: 'dark' | 'light'
  voice_response_enabled: boolean
  language: string
  onboarding_completed: boolean
  occupation?: string
  // Anthropic is the only provider now, so the type narrows to that. The field stays
  // present + optional (not removed) because real profiles on the production volume
  // still contain values written by earlier, now-deleted providers — a required-shape
  // change would break reads. Those old string values just won't type-check as this
  // literal anymore; nothing reads or branches on this field at runtime any more.
  ai_provider?: 'anthropic'
  ai_model?: string
  ai_api_key_masked?: string       // shown in UI: "sk-****abcd" — never the raw key
  ai_api_key_encrypted?: string    // AES-256-GCM encrypted — NEVER sent to frontend
  push_subscription?: string       // JSON-serialised PushSubscription for Web Push (browser PWA)
  fcm_token?: string               // Firebase Cloud Messaging token for native Capacitor push
  ntfy_topic?: string              // ntfy topic; derived from the user id when unset (see channels/ntfy.ts)
  mic_position?: 'left' | 'right'  // VoiceFAB side (default: 'right')
  // Smart notifications
  notifications_enabled?: boolean
  notify_pre_event?: boolean
  notify_morning_briefing?: boolean
  notify_evening_review?: boolean
  notify_task_nudge?: boolean
  last_nudge_at?: string                 // ISO timestamp for nudge throttling
  last_morning_briefing_date?: string    // "2026-03-29" — prevents double-send
  last_evening_review_date?: string      // "2026-03-29" — prevents double-send
  sent_event_notifications?: string[]    // ["eventId-2026-03-29", ...] — dedup pre-event reminders
  timezone?: string                      // IANA timezone (e.g. "Asia/Jerusalem"), set by client
  // Time management methodology
  persona?: 'student' | 'manager' | 'entrepreneur' | 'developer' | 'other'
  scheduling_method?: 'pomodoro' | 'deep_work' | 'eisenhower' | 'gtd' | 'time_blocking' | 'ivy_lee'
    | 'eat_the_frog' | 'theme_days' | 'the_one_thing' | 'weekly_review' | 'okr' | 'kanban' | 'time_boxing'
    | 'moscow' | 'rule_5217' | 'scrum' | 'energy_management' | 'twelve_week_year'
  secondary_methods?: string[]
  challenge?: 'procrastination' | 'overwhelmed' | 'focus' | 'scattered' | 'goals'
  day_structure?: 'fixed' | 'variable' | 'mixed' | 'independent'
  /**
   * Which weekend days the scheduler may use. 'none' (the default) keeps both
   * Friday and Saturday clear; 'friday' frees Friday and keeps only Shabbat;
   * 'both' holds nothing back. Worth an explicit answer rather than a guess —
   * in a typical exam week, freeing Friday is worth ~16 extra study sessions.
   */
  schedule_weekend?: 'none' | 'friday' | 'both'
}

/**
 * Minimal logged-in-user shape for the UI. Auth is file-based (see `src/lib/auth`);
 * this is just what the UI components (Header, AppShell, SettingsClient) read.
 */
export interface AppUser {
  id: string
  email?: string
  user_metadata?: { avatar_url?: string; full_name?: string }
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
  isError?: boolean   // assistant error bubble — UI may offer a retry
}

export interface FeedbackSignal {
  type: 'rejected' | 'moved'   // user deleted an AI event, or moved it to a different time
  title: string
  fromHour?: number            // original start hour (0-23)
  toHour?: number              // new start hour (moved only)
  day?: string                 // 'EEE' weekday of the original slot
  at: string                   // ISO timestamp the signal was recorded
}

export interface AIMemory {
  id: string
  user_id: string
  key: string
  value: string
  learned_from: 'onboarding' | 'behavior' | 'explicit'
  created_at: string
}
