import OpenAI from 'openai'

/**
 * The tool surface, in two versions.
 *
 * `calendarTools` / `onboardingTools` are the shipped v1 arrays and are exported
 * unchanged — with SCHEDULER_V2 off, `getCalendarTools()` returns these exact
 * array references, so the model sees byte-identical JSON to before.
 *
 * The v2 arrays (built at the bottom of this file) exist only behind that flag.
 * The important difference is a subtraction: `get_free_slots` is *removed*, not
 * deprecated. Leaving it available while telling the model not to use it is the
 * pattern that produced the bug the engine exists to fix — the model reaches for
 * the arithmetic tool, does the arithmetic itself, and lands a study block inside
 * an all-day reserve-duty event. A tool that is not offered cannot be called.
 */
export const calendarTools: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'create_event',
      description: "Create a new calendar event. ALWAYS call list_events first to check for duplicates before creating. The server automatically detects time conflicts and returns { error: 'conflict', conflictingEvent, alternatives } if there is an overlap — in that case, check the conflicting event's mobility_type: if flexible (🟡) move it first via move_event then retry; if ask_first (🔵) ask user; if fixed (🔒) use alternatives. Also returns buffer_warnings if back-to-back. When the user doesn't specify duration: use the METHOD SESSION SIZES table. Set mobility_type from the same table. Prefer peak hours for hard tasks.",
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Event title' },
          start_time: { type: 'string', description: 'ISO 8601 datetime e.g. 2026-03-20T14:00:00' },
          end_time: { type: 'string', description: 'ISO 8601 datetime' },
          description: { type: 'string', description: 'Optional description' },
          color: { type: 'string', description: 'Hex color by type: #3B7EF7=work/meetings/calls, #6366F1=study/exams/homework, #34D399=fitness/sport/gym, #FBBF24=personal/errands, #F97316=social/friends/fun' },
          status: { type: 'string', enum: ['confirmed', 'proposed'] },
          is_all_day: { type: 'boolean', description: 'True for all-day events (holidays, birthdays, deadlines with no specific time). Default false.' },
          mobility_type: { type: 'string', enum: ['fixed', 'flexible', 'ask_first'], description: 'How movable this event is. fixed=never move (exams, flights), flexible=AI can move freely (study blocks, AI sessions), ask_first=ask user before moving (default)' },
          recurrence: {
            type: 'object',
            description: 'Create a recurring event. Generates multiple instances automatically. Use when the user says "every Tuesday", "כל שלישי", "every week", "כל שבוע", etc.',
            properties: {
              frequency: { type: 'string', enum: ['weekly', 'biweekly', 'monthly'], description: 'How often to repeat' },
              count: { type: 'number', description: 'Number of instances to create. Default: 12 for weekly/biweekly, 6 for monthly' },
              end_date: { type: 'string', description: 'Optional: stop generating after this ISO date (alternative to count)' },
            },
            required: ['frequency'],
          },
        },
        required: ['title', 'start_time', 'end_time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_event',
      description: 'Move an existing event to a different time. IMPORTANT: Check mobility_type before calling — never move fixed (🔒), ask user for ask_first (🔵), move flexible (🟡) freely. Use PROACTIVELY: when a new event needs space and flexible events are in the way, move them first. Call get_free_slots to find the new slot.',
      parameters: {
        type: 'object',
        properties: {
          event_id: { type: 'string' },
          new_start_time: { type: 'string' },
          new_end_time: { type: 'string' },
        },
        required: ['event_id', 'new_start_time', 'new_end_time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_event',
      description: 'Update properties of an existing event WITHOUT changing its time. Use to change title, color, or mobility_type. IMPORTANT: if the event belongs to a recurring series (has a series_id from list_events), set apply_to_series:true to update ALL instances at once — do NOT call this in a loop for each instance. Example: user says "lock all my course events" → list_events → find recurring_series → call update_event once per series with apply_to_series:true.',
      parameters: {
        type: 'object',
        properties: {
          event_id: { type: 'string', description: 'Any one instance ID from the series (or the single event ID)' },
          title: { type: 'string', description: 'New title (optional)' },
          color: { type: 'string', description: 'New hex color (optional)' },
          mobility_type: { type: 'string', enum: ['fixed', 'flexible', 'ask_first'], description: 'New mobility. fixed=🔒 never move, flexible=🟡 AI moves freely, ask_first=🔵 ask user first' },
          apply_to_series: { type: 'boolean', description: 'If true, applies the change to ALL instances of the recurring series. Use when event has a series_id.' },
        },
        required: ['event_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_event',
      description: 'Delete an event. Always confirm first unless user explicitly asked. For recurring events: use delete_series:true to delete the entire series, or leave it false/omit to delete only this one instance.',
      parameters: {
        type: 'object',
        properties: {
          event_id: { type: 'string' },
          title: { type: 'string' },
          delete_series: { type: 'boolean', description: 'If true, deletes ALL future instances of this recurring event. Use when user says "delete all", "מחק את כל", "stop recurring", "הסר את כל החזרות".' },
        },
        required: ['event_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_free_slots',
      description: 'Find available time slots between two dates. Call this BEFORE any scheduling decision. Set prefer_peak=true for study/deep work tasks. Use min_duration_minutes matching the user\'s method from the METHOD SESSION SIZES table (e.g. Pomodoro=30, Deep Work=150, Time Boxing=45). Each slot includes is_peak=true if in peak window.',
      parameters: {
        type: 'object',
        properties: {
          from_date: { type: 'string' },
          to_date: { type: 'string' },
          min_duration_minutes: { type: 'number' },
          prefer_peak: { type: 'boolean', description: 'If true, returns peak-hour slots first. Use for study/deep work scheduling.' },
        },
        required: ['from_date', 'to_date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'break_down_task',
      description: 'Break a big task (exam, project, deadline) into multiple scheduled sessions. CRITICAL: Consult the METHOD SESSION SIZES table in your system prompt — use the user\'s scheduling_method to choose session_length_hours and title format (e.g. Pomodoro=0.5h, Deep Work=2.5h, Time Boxing=0.75h). The server has a safety net but you should pass correct values. Automatically uses peak-hour slots.',
      parameters: {
        type: 'object',
        properties: {
          task_title: { type: 'string' },
          deadline: { type: 'string', description: 'ISO 8601 deadline' },
          total_hours: { type: 'number' },
          session_length_hours: { type: 'number', description: 'Default 2' },
          color: { type: 'string' },
        },
        required: ['task_title', 'deadline', 'total_hours'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_events',
      description: "List the user's events in a date range.",
      parameters: {
        type: 'object',
        properties: {
          from_date: { type: 'string' },
          to_date: { type: 'string' },
        },
        required: ['from_date', 'to_date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'analyze_schedule',
      description: `Deeply analyze the user's schedule for a date range. Returns events grouped by day PLUS pre-computed issues like: back-to-back meetings with no buffer, missing lunch breaks, overloaded days, empty days next to packed days, late-night study sessions, important events (exams/presentations) with no prep time scheduled before them, and tasks during low-productivity hours. Use this tool whenever the user asks to review/optimize/analyze their schedule, or says things like "what do you think about my week", "how does my schedule look", "analyze my schedule", "am I too busy", etc. Also use it after the app opens if the user seems to want a proactive check.`,
      parameters: {
        type: 'object',
        properties: {
          from_date: { type: 'string', description: 'Start of analysis range (ISO date)' },
          to_date: { type: 'string', description: 'End of analysis range (ISO date)' },
        },
        required: ['from_date', 'to_date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description: `Save facts learned about the user — this is your long-term brain. Call it proactively whenever the user reveals ANYTHING about themselves, AND whenever you NOTICE a consistent behaviour.
Use this key taxonomy so the profile stays organized (reuse the same key to update a fact):
- Identity: occupation, study_field, university, year_of_study, role, location, name
- Rhythm: wake_time, sleep_time, productivity_peak, energy_dip, commute_time
- Fixed commitments: recurring_* (classes, work shifts, gym, volunteering), work_hours, free_days
- Preferences: pref_study_time, pref_meeting_time, pref_session_length, prefers_buffers, main_challenge
- Life: relationship, family_commitment, hobby, volunteering
- Goals: current_goal, ongoing_task, upcoming_focus
- Method fit: method_feedback (how the user reacts to their scheduling method — e.g. "fights deep_work, prefers shorter blocks")
- Patterns: pattern_* (behaviours you OBSERVED, e.g. pattern_morning_study="always moves morning study to evening", pattern_reject_early="rejects slots before 9:00")
Examples: { key: "occupation", value: "מהנדס תוכנה" }, { key: "pref_study_time", value: "ערב, אחרי 20:00" }, { key: "pattern_reject_early", value: "דוחה זמנים לפני 9:00" }
ALWAYS save after learning something new OR after seeing the same behaviour 2-3 times. Use it aggressively — but keep values short.`,
      parameters: {
        type: 'object',
        properties: {
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string', description: 'Short snake_case key (e.g. "occupation", "wake_time", "pref_study_time", "main_challenge")' },
                value: { type: 'string', description: 'The fact, in plain natural language' },
              },
              required: ['key', 'value'],
            },
          },
        },
        required: ['entries'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Create a new task/todo item. ALWAYS assign a topic — infer from context if not given. Standard topics: "לימודים" (Study), "עבודה" (Work), "בריאות" (Health), "אישי" (Personal), "פרויקטים" (Projects), "חברתי" (Social). Use parent_task_id to create sub-tasks under a parent. After creating, the UI task panel updates automatically.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Task title' },
          priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Task priority' },
          topic: { type: 'string', description: 'Topic/category for grouping. Infer from context (e.g. "לימודים", "עבודה", "אישי", "בריאות")' },
          deadline: { type: 'string', description: 'Optional deadline as ISO date string (e.g. 2026-03-25)' },
          estimated_hours: { type: 'number', description: 'Estimated hours to complete' },
          description: { type: 'string', description: 'Optional description' },
          parent_task_id: { type: 'string', description: 'ID of parent task if this is a sub-task. Use when breaking a complex task into smaller actionable steps.' },
        },
        required: ['title', 'priority', 'topic'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_task',
      description: 'Update an existing task — change status, title, priority, topic, or deadline.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The task ID to update' },
          title: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
          priority: { type: 'string', enum: ['low', 'medium', 'high'] },
          topic: { type: 'string' },
          deadline: { type: 'string' },
          estimated_hours: { type: 'number' },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_task',
      description: 'Delete a task by ID.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The task ID to delete' },
          title: { type: 'string', description: 'Task title (for confirmation message)' },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: "List the user's tasks. Filter by status or topic to get a specific subset.",
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'in_progress', 'done'], description: 'Filter by status (optional — omit for all)' },
          topic: { type: 'string', description: 'Filter by topic/category (optional)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_memory',
      description: 'Remove outdated or incorrect facts from memory. Use when the user corrects something ("לא, אני קם ב-8 לא ב-7") or a fact is no longer true. After deleting, call save_memory to store the correct value.',
      parameters: {
        type: 'object',
        properties: {
          keys: {
            type: 'array',
            items: { type: 'string' },
            description: 'Keys to delete, e.g. ["wake_time", "occupation"]',
          },
        },
        required: ['keys'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_notification',
      description: "Send a real push notification to the user's device. Use when the user says: 'שלח לי התראה', 'send me a notification', 'תזכיר לי', 'remind me', 'שלח התראת בדיקה', 'test notification', or any request to send/push a notification or reminder. DO NOT just write text — call this tool to actually deliver it to the device.",
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Notification title (short, ≤50 chars)' },
          body: { type: 'string', description: 'Notification body text' },
        },
        required: ['title', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_all_events',
      description: 'Delete ALL calendar events for this user. Only call after the user explicitly confirms with "yes", "כן", "מחק", etc. Never call speculatively.',
      parameters: { type: 'object', properties: {} },
    },
  },
]

export const onboardingTools: OpenAI.ChatCompletionTool[] = [
  ...calendarTools,
  {
    type: 'function',
    function: {
      name: 'complete_onboarding',
      description: 'Call this ONCE when you have gathered enough information (the key topics covered) OR when user wants to skip. Saves everything and marks onboarding as complete. REQUIRED: persona (user type), challenge (their main time-management struggle), and day_structure (how their typical day looks) — these are used to assign the right scheduling methods automatically. Always include them in profile_updates.',
      parameters: {
        type: 'object',
        properties: {
          profile_updates: {
            type: 'object',
            description: 'Profile fields to update based on what was learned',
            properties: {
              productivity_peak: { type: 'string', enum: ['morning', 'afternoon', 'evening'] },
              sleep_time: { type: 'string', description: 'e.g. "23:00"' },
              wake_time: { type: 'string', description: 'e.g. "07:00"' },
              occupation: { type: 'string' },
              autonomy_mode: { type: 'string', enum: ['suggest', 'hybrid', 'auto'] },
              persona: { type: 'string', enum: ['student', 'manager', 'entrepreneur', 'developer', 'other'], description: 'User type inferred from occupation/role' },
              challenge: { type: 'string', enum: ['procrastination', 'overwhelmed', 'focus', 'scattered', 'goals'], description: 'Their biggest time-management challenge' },
              day_structure: { type: 'string', enum: ['fixed', 'variable', 'mixed', 'independent'], description: 'fixed=same schedule daily, variable=different every day, mixed=meetings+independent, independent=fully self-directed' },
            },
            required: ['persona', 'challenge', 'day_structure'],
          },
          memory_entries: {
            type: 'array',
            description: 'Final summary of everything learned',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                value: { type: 'string' },
              },
              required: ['key', 'value'],
            },
          },
          summary: { type: 'string', description: 'One sentence summary of what you learned about this user' },
        },
        required: ['profile_updates', 'memory_entries'],
      },
    },
  },
]

// ─── SCHEDULER_V2 tool surface ───────────────────────────────────────────────
//
// Everything below is inert unless SCHEDULER_V2 is set. Nothing here mutates the
// arrays above; the v2 lists are built by filtering and appending into new arrays.

const scheduleItemTool: OpenAI.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'schedule_item',
    description:
      'Ask the scheduling engine WHEN something should go. This is the tool for any "when should I..." / "מתי כדאי..." / "תקבע לי זמן ל..." request, and for anything that needs multiple sessions. ' +
      'The engine reads the real calendar (including all-day events and recurring series), the user\'s hours, their method, and what they have historically moved — you do NOT do this arithmetic yourself. ' +
      'It returns a PROPOSAL and writes nothing. Each block comes with a `why` array of ready-made sentences: paraphrase those when you explain the plan, and never invent a different reason. ' +
      'If the result is partial or blocked, say so honestly and offer the `suggestions` — do not pretend it fit. ' +
      'After showing the proposal, wait for the user to agree, then call apply_plan with the plan_id.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What is being scheduled, in the user\'s own words' },
        total_minutes: { type: 'number', description: 'Total work to place, in minutes. Omit for a single default-length session.' },
        session_count: { type: 'number', description: 'How many separate sessions to spread the work across.' },
        session_minutes: { type: 'number', description: 'Override the method\'s default session length. Usually omit — the method decides.' },
        deadline: { type: 'string', description: 'Must be finished by this local time, e.g. 2026-08-27T09:00:00' },
        earliest: { type: 'string', description: 'Must not start before this local time.' },
        category: { type: 'string', enum: ['study', 'work', 'fitness', 'personal', 'social', 'admin'] },
        energy: { type: 'string', enum: ['high', 'medium', 'low'], description: 'How much focus this needs. High-energy work is matched to the user\'s peak hours.' },
        color: { type: 'string', description: 'Hex color: #3B7EF7=work, #6366F1=study, #34D399=fitness, #FBBF24=personal, #F97316=social' },
        mobility_type: { type: 'string', enum: ['fixed', 'flexible', 'ask_first'] },
      },
      required: ['title'],
    },
  },
}

const applyPlanTool: OpenAI.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'apply_plan',
    description:
      'Write a previously proposed plan to the calendar, exactly as it was shown. Takes the plan_id returned by schedule_item or break_down_task. ' +
      'Call this only after the user has agreed (or when their autonomy mode is "auto"). The stored blocks are written verbatim — nothing is recomputed, so what the user approved is what they get. ' +
      'A plan_id can be applied once, and expires after about ten minutes; if it is gone, call schedule_item again rather than guessing times.',
    parameters: {
      type: 'object',
      properties: {
        plan_id: { type: 'string', description: 'The plan_id from the proposal' },
      },
      required: ['plan_id'],
    },
  },
}

/**
 * In v2, move_event no longer demands that the caller name the new time. The
 * whole point of the engine is that "where should this go" is its question, not
 * the model's — so the times become optional and their absence means "you pick".
 */
const V2_MOVE_EVENT_PARAMETERS = {
  type: 'object',
  properties: {
    event_id: { type: 'string' },
    new_start_time: { type: 'string', description: 'Optional. Local time, e.g. 2026-08-18T14:00:00. Omit to let the engine choose.' },
    new_end_time: { type: 'string', description: 'Optional, required only if new_start_time is given.' },
  },
  required: ['event_id'],
}

const V2_PARAMETER_OVERRIDES: Record<string, unknown> = {
  move_event: V2_MOVE_EVENT_PARAMETERS,
}

/** In v2 these stop being "do the arithmetic" tools and become engine front-ends. */
const V2_DESCRIPTION_OVERRIDES: Record<string, string> = {
  break_down_task:
    'Split a big task (exam, project, deadline) into scheduled sessions. Runs the same scheduling engine as schedule_item: it picks the session length from the user\'s method and the times from their real calendar. ' +
    'Returns a PROPOSAL with a plan_id and writes nothing — show it, get agreement, then call apply_plan. Report unplaced sessions honestly; never claim a session that the engine did not place.',
  move_event:
    'Move an existing event. Omit new_start_time/new_end_time to let the scheduling engine choose the best free slot — it moves the event and returns the new time plus a `why` array explaining the choice; paraphrase that, do not invent a reason. ' +
    'Pass explicit times only when the user named a specific time. Either way the move is written immediately (a move is one visible, reversible change — no plan_id needed). ' +
    'Never moves an event marked fixed (🔒); ask before moving one marked ask_first (🔵).',
  create_event:
    'Create a calendar event at a time the user explicitly named. If the user did NOT name a time, use schedule_item instead — do not pick a time yourself. ' +
    'The server detects conflicts and returns { error: "conflict", conflictingEvent, alternatives }. For recurring events every generated instance is checked against the real calendar and clashes are reported, not silently skipped. ' +
    'Colors: #3B7EF7=work, #6366F1=study, #34D399=fitness, #FBBF24=personal, #F97316=social.',
}

function toV2(tools: OpenAI.ChatCompletionTool[]): OpenAI.ChatCompletionTool[] {
  const out: OpenAI.ChatCompletionTool[] = []
  for (const tool of tools) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn = (tool as any).function as { name: string; description?: string; parameters?: unknown }
    if (fn?.name === 'get_free_slots') continue  // the arithmetic the model must stop doing
    const description = V2_DESCRIPTION_OVERRIDES[fn?.name]
    const parameters = V2_PARAMETER_OVERRIDES[fn?.name]
    if (!description && !parameters) { out.push(tool); continue }
    out.push({
      ...tool,
      function: {
        ...fn,
        ...(description ? { description } : {}),
        ...(parameters ? { parameters } : {}),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
  }
  // Inserted after the existing tools so the engine entry points read as the
  // scheduling section of the list rather than being buried mid-way.
  out.push(scheduleItemTool, applyPlanTool)
  return out
}

// ─── PROJECTS tool surface ───────────────────────────────────────────────────
//
// Five tools, kept deliberately few because chat is the write path in this app:
// TasksPanel's quick-add does not POST, it sends "הוסף משימה: …" through the chat
// engine. Anything the user can say, the model needs a tool for.

const projectTools: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'create_project',
      description:
        'Create a project — a body of work with several steps and usually a deadline (a course, an assignment to hand in, something the user is building). ' +
        'Use this instead of create_task when the user describes something with THREE OR MORE steps, or names a deadline for a body of work rather than a single errand. ' +
        'Pass the steps in `tasks` in the same call rather than making N follow-up create_task calls. ' +
        'kind matters: "course" and "deliverable" expect a deadline; "build" usually has none, and a project with no deadline is never reported as on-track — it simply has no risk to report.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          kind: { type: 'string', enum: ['course', 'deliverable', 'build'] },
          deadline: { type: 'string', description: 'YYYY-MM-DD or a local datetime. Omit for open-ended work.' },
          description: { type: 'string' },
          color: { type: 'string', description: 'Hex, e.g. #6366F1' },
          tasks: {
            type: 'array',
            description: 'The steps. `key` is a local label used only to express order between them in this call.',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                title: { type: 'string' },
                estimated_hours: { type: 'number', description: 'Ask the user if you do not know. Never invent one — the risk badge is computed from these.' },
                deadline: { type: 'string' },
                priority: { type: 'string', enum: ['low', 'medium', 'high'] },
                depends_on: { type: 'array', items: { type: 'string' }, description: 'Other `key` values that must finish first.' },
              },
              required: ['title'],
            },
          },
        },
        required: ['title', 'kind'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_projects',
      description:
        'List the user\'s projects with their computed health: deadline risk, progress, next step and time invested. ' +
        'The risk level and its explanation come from the real scheduling engine — PARAPHRASE them and never re-derive whether something fits, exactly as with schedule_item\'s reasons. ' +
        'Use for "מה מצב הפרויקטים שלי", "איפה אני עומד", or before proposing to plan one.',
      parameters: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['active', 'paused', 'done', 'archived'] } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_project',
      description: 'Change a project\'s title, status, deadline, description or colour. Use status "archived" to put one away, "done" when it is finished.',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'string', enum: ['active', 'paused', 'done', 'archived'] },
          deadline: { type: 'string' },
          description: { type: 'string' },
          color: { type: 'string' },
        },
        required: ['project_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_project',
      description:
        'Delete a project. By default its tasks SURVIVE and simply stop belonging to it. Pass delete_tasks:true only if the user clearly wants the work gone too. ' +
        'Calendar blocks are never removed by this — say so if the user expects otherwise. Prefer update_project with status "archived" unless they actually said delete.',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          delete_tasks: { type: 'boolean' },
        },
        required: ['project_id'],
      },
    },
  },
]

const planProjectTool: OpenAI.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'plan_project',
    description:
      'Plan a WHOLE project at once: every open task with a time estimate goes to the scheduling engine together, so deadlines and dependencies are resolved against each other rather than one task at a time. ' +
      'A task that depends on another is never scheduled before it finishes. ' +
      'Returns a PROPOSAL with a plan_id and writes nothing — show it, wait for the user to agree, then call apply_plan. ' +
      'Tasks with no time estimate come back in `skipped`: report them honestly and offer to estimate them, never guess a number and schedule against it. ' +
      'If the task graph has a circular dependency it refuses and names the two tasks — pass that on rather than working around it.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        only_task_ids: { type: 'array', items: { type: 'string' }, description: 'Plan just these tasks instead of the whole project.' },
      },
      required: ['project_id'],
    },
  },
}

/** In the projects world, tasks can belong to a project and can be ordered. */
const PROJECTS_PARAMETER_EXTRAS: Record<string, Record<string, unknown>> = {
  create_task: {
    project_id: { type: 'string', description: 'Attach this task to a project.' },
    depends_on: { type: 'array', items: { type: 'string' }, description: 'Task ids that must finish first.' },
  },
  update_task: {
    project_id: { type: 'string', description: 'Move this task into a project.' },
    depends_on: { type: 'array', items: { type: 'string' }, description: 'Task ids that must finish first.' },
  },
}

/**
 * Adds the projects surface. `plan_project` appears only when the engine path is
 * also on: it returns a plan_id that only `apply_plan` — a V2-only tool — can
 * commit, so offering it otherwise hands the model a proposal it can never apply.
 */
function withProjects(tools: OpenAI.ChatCompletionTool[], v2: boolean): OpenAI.ChatCompletionTool[] {
  const out = tools.map(tool => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn = (tool as any).function as { name: string; parameters?: any }
    const extras = PROJECTS_PARAMETER_EXTRAS[fn?.name]
    if (!extras || !fn.parameters?.properties) return tool
    return {
      ...tool,
      function: {
        ...fn,
        parameters: { ...fn.parameters, properties: { ...fn.parameters.properties, ...extras } },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
  })
  out.push(...projectTools)
  if (v2) out.push(planProjectTool)
  return out
}

const calendarToolsV2: OpenAI.ChatCompletionTool[] = toV2(calendarTools)
const onboardingToolsV2: OpenAI.ChatCompletionTool[] = toV2(onboardingTools)
const calendarToolsProjects: OpenAI.ChatCompletionTool[] = withProjects(calendarTools, false)
const calendarToolsV2Projects: OpenAI.ChatCompletionTool[] = withProjects(calendarToolsV2, true)
const onboardingToolsProjects: OpenAI.ChatCompletionTool[] = withProjects(onboardingTools, false)
const onboardingToolsV2Projects: OpenAI.ChatCompletionTool[] = withProjects(onboardingToolsV2, true)

/**
 * The tool list to hand the model. With `v2` false this returns the exact same
 * array reference the app has always used — not a copy, not a rebuild.
 */
export function getCalendarTools(v2: boolean, projects = false): OpenAI.ChatCompletionTool[] {
  if (!projects) return v2 ? calendarToolsV2 : calendarTools
  return v2 ? calendarToolsV2Projects : calendarToolsProjects
}

export function getOnboardingTools(v2: boolean, projects = false): OpenAI.ChatCompletionTool[] {
  if (!projects) return v2 ? onboardingToolsV2 : onboardingTools
  return v2 ? onboardingToolsV2Projects : onboardingToolsProjects
}

/** Tools that only exist under the flag. Used by the dispatcher to fail closed. */
export const V2_ONLY_TOOLS = new Set(['schedule_item', 'apply_plan'])

/** Same fail-closed guard, for the projects surface. */
export const PROJECT_ONLY_TOOLS = new Set([
  'create_project', 'list_projects', 'update_project', 'delete_project', 'plan_project',
])
