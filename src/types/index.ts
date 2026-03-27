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
}

export interface UserProfile {
  user_id: string
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
  ai_provider?: 'openai' | 'anthropic' | 'minimax' | 'openrouter'
  ai_model?: string
  ai_api_key_masked?: string       // shown in UI: "sk-****abcd" — never the raw key
  ai_api_key_encrypted?: string    // AES-256-GCM encrypted — NEVER sent to frontend
  push_subscription?: string       // JSON-serialised PushSubscription for Web Push (browser PWA)
  fcm_token?: string               // Firebase Cloud Messaging token for native Capacitor push
  mic_position?: 'left' | 'right'  // VoiceFAB side (default: 'right')
  // Time management methodology
  persona?: 'student' | 'manager' | 'entrepreneur' | 'developer' | 'other'
  scheduling_method?: 'pomodoro' | 'deep_work' | 'eisenhower' | 'gtd' | 'time_blocking' | 'ivy_lee'
    | 'eat_the_frog' | 'theme_days' | 'the_one_thing' | 'weekly_review' | 'okr' | 'kanban' | 'time_boxing'
    | 'moscow' | 'rule_5217' | 'scrum' | 'energy_management' | 'twelve_week_year'
  secondary_methods?: string[]
  challenge?: 'procrastination' | 'overwhelmed' | 'focus' | 'scattered' | 'goals'
  day_structure?: 'fixed' | 'variable' | 'mixed' | 'independent'
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
}

export interface AIMemory {
  id: string
  user_id: string
  key: string
  value: string
  learned_from: 'onboarding' | 'behavior' | 'explicit'
  created_at: string
}
