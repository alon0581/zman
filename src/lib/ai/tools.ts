import OpenAI from 'openai'

export const calendarTools: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'create_event',
      description: "Create a new calendar event. ALWAYS call list_events first to check for duplicates before creating. The server automatically detects time conflicts and returns { error: 'conflict', conflictingEvent, alternatives } if there is an overlap — in that case, propose a specific alternative from the alternatives array. Also returns buffer_warnings if the new event will be back-to-back with another event. When you have freedom to choose the time, prefer the user's peak productivity hours for hard tasks (study, deep work).",
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Event title' },
          start_time: { type: 'string', description: 'ISO 8601 datetime e.g. 2026-03-20T14:00:00' },
          end_time: { type: 'string', description: 'ISO 8601 datetime' },
          description: { type: 'string', description: 'Optional description' },
          color: { type: 'string', description: 'Hex color by type: #3B7EF7=work/meetings/calls, #6366F1=study/exams/homework, #34D399=fitness/sport/gym, #FBBF24=personal/errands, #F97316=social/friends/fun' },
          status: { type: 'string', enum: ['confirmed', 'proposed'] },
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
      description: 'Move an existing event to a different time. IMPORTANT: Check the event\'s mobility_type before calling. Never move fixed events. For ask_first events, ask the user first. Flexible events can be moved freely.',
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
      description: 'Update properties of an existing event WITHOUT changing its time. Use to change title, color, or mobility_type. For example: user says "mark this as fixed", "זה קבוע", "make this flexible", "change to ask first" — call this tool with the new mobility_type.',
      parameters: {
        type: 'object',
        properties: {
          event_id: { type: 'string' },
          title: { type: 'string', description: 'New title (optional)' },
          color: { type: 'string', description: 'New hex color (optional)' },
          mobility_type: { type: 'string', enum: ['fixed', 'flexible', 'ask_first'], description: 'New mobility classification (optional). fixed=🔒 never move, flexible=🟡 AI can move freely, ask_first=🔵 ask user before moving' },
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
        required: ['event_id', 'title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_free_slots',
      description: 'Find available time slots between two dates. Set prefer_peak=true for study/deep work tasks to get peak-hour slots listed first. Each slot includes is_peak=true if it falls in the user\'s peak productivity window.',
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
      description: 'Break a big task (exam, project, deadline) into multiple scheduled sessions. Automatically uses peak-hour slots for study/work tasks. Use this whenever the user mentions a deadline, paper, exam, or project that needs multiple sessions.',
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
      description: `Save facts learned about the user. Call this proactively whenever the user reveals ANYTHING about themselves.
Save keys like: occupation, wake_time, sleep_time, university, year_of_study, study_field, work_hours, free_days, pref_study_time, pref_meeting_time, main_challenge, goal, hobby, location, commute_time, pattern_* (behavioral patterns), recurring_* (fixed commitments).
Examples: { key: "occupation", value: "מהנדס תוכנה" }, { key: "wake_time", value: "07:00" }, { key: "pref_study_time", value: "ערב, אחרי 20:00" }
ALWAYS call save_memory after learning something new. This is your long-term brain — use it aggressively.`,
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
      description: 'Create a new task/todo item. ALWAYS assign a topic — infer from context if not given. Standard topics: "לימודים" (Study), "עבודה" (Work), "בריאות" (Health), "אישי" (Personal), "פרויקטים" (Projects), "חברתי" (Social). After creating, the UI task panel updates automatically.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Task title' },
          priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Task priority' },
          topic: { type: 'string', description: 'Topic/category for grouping. Infer from context (e.g. "לימודים", "עבודה", "אישי", "בריאות")' },
          deadline: { type: 'string', description: 'Optional deadline as ISO date string (e.g. 2026-03-25)' },
          estimated_hours: { type: 'number', description: 'Estimated hours to complete' },
          description: { type: 'string', description: 'Optional description' },
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
        required: ['task_id', 'title'],
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
      description: "Send a real push notification to the user's device. Use when the user asks you to send a reminder, motivational message, or any notification. DO NOT just write text — call this tool to actually send it.",
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
      description: 'Call this ONCE when you have gathered enough information (all 6 topics covered) OR when user wants to skip. Saves everything and marks onboarding as complete. IMPORTANT: also gather persona (user type), challenge (their main time-management struggle), and day_structure (how their typical day looks) — these are used to assign the right scheduling methods automatically.',
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
        required: ['memory_entries'],
      },
    },
  },
]
