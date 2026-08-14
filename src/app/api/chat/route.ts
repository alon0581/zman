import { NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import OpenAI from 'openai'
import { getCalendarTools, getOnboardingTools, PROJECT_ONLY_TOOLS, V2_ONLY_TOOLS } from '@/lib/ai/tools'
import { buildSystemPrompt } from '@/lib/ai/systemPrompt'
import { buildOnboardingSystemPrompt } from '@/lib/ai/onboardingPrompt'
import { projectsEnabled, schedulerV2Enabled } from '@/lib/ai/featureFlags'
import { followupPrompt, needsFollowup } from '@/lib/ai/followup'
import { consumePlan } from '@/lib/ai/planStore'
import {
  buildBreakdownSpec, buildScheduleItemSpec, METHOD_SESSION_HOURS, methodMobility,
  methodTitleFormatter, planMove, planRecurring, proposePlan, recurringToolResult, SchedulerCtx,
} from '@/lib/ai/schedulerTools'
import { buildProjectPlanSpec } from '@/lib/ai/projectTools'
import { CalendarEvent, UserProfile, AIMemory, Project, Task, FeedbackSignal } from '@/types'
import { planProjectDeletion } from '@/lib/projects/cascade'
import { probeCapacity, ProjectProbeResult } from '@/lib/projects/capacity'
import { computeFacts, probeInputFor, resolveSignals } from '@/lib/projects/health'
import {
  buildSchedulingContext, horizonDaysFor, resolveMethod, resolveNow,
} from '@/lib/scheduling/adapter'
import { addDays, addHours, addMinutes, format, parseISO, startOfDay, endOfDay } from 'date-fns'
import { userStore } from '@/lib/store/userStore'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'
import { classifyMobility } from '@/lib/scheduling/mobilityClassifier'
import { mapToMethod } from '@/lib/scheduling/methodMapper'
import { sendPush, sendFcmPush } from '@/lib/push'
import { sendNtfy, defaultTopicFor, isNtfyConfigured } from '@/lib/notifications/channels/ntfy'
import { assertSafeUserId } from '@/lib/util/safeUserId'
import { readJsonFile, writeJsonFileAtomic } from '@/lib/util/jsonStore'
import { DATA_DIR } from '@/lib/util/dataDir'
import { recordFeedback, readFeedback } from '@/lib/feedback/store'
import crypto from 'crypto'
import path from 'path'

// Shared constants
const BUFFER_MIN = 15        // minutes of breathing room between events
// Wall-clock ceiling on the tool-call loop. Sonnet does several tool round-trips
// per scheduling request (each a few seconds), so 25s cut real work off mid-flow.
// 90s gives genuine multi-tool scheduling room to finish; env-overridable.
const MAX_LOOP_MS = Number(process.env.MAX_LOOP_MS) || 90000
const MEM_KEY_MAX = 100      // max length of a memory key
const MEM_VALUE_MAX = 10000  // max length of a memory value

function memoryFile(userId: string) {
  return path.join(DATA_DIR, 'users',assertSafeUserId(userId), 'memory.json')
}

// ── Model policy ────────────────────────────────────────────────────────────
//
// One model per conversation, deliberately. The previous tiered setup routed
// chit-chat to Haiku and scheduling to Sonnet, which reads as a saving and isn't:
// prompt caches are keyed per model, so alternating models alternately misses the
// cache. The static prefix is thousands of tokens, and re-writing it every other
// turn costs more than the cheaper model saves — while also making the assistant
// feel like two different assistants depending on how a sentence was phrased.
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5'

// Sonnet 5 runs adaptive thinking by default, and max_tokens caps thinking PLUS
// the reply. The old 2048 was sized for a non-thinking model and truncates
// answers here — the thinking eats the budget and the user gets half a sentence.
const ANTHROPIC_MAX_TOKENS = Number(process.env.ANTHROPIC_MAX_TOKENS) || 8192
const ANTHROPIC_FOLLOWUP_MAX_TOKENS = 4096

/**
 * `output_config.effort` is rejected by models that predate it, and a per-user
 * key from Settings can still point at one — so it is sent only to models known
 * to accept it.
 *
 * Why `medium` and not `low`: effort has to be set against who is doing the
 * thinking. While SCHEDULER_V2 is off, the model still works out slot placement
 * itself, and `low` is documented for short, scoped, non-intelligence-sensitive
 * turns — exactly the wrong setting for the work it is actually carrying. Once
 * the engine owns placement, the model's job shrinks to understanding Hebrew and
 * paraphrasing reasons it was handed, and `low` becomes the honest setting.
 * Overridable so that switch is an env change, not a deploy.
 *
 * Note what is NOT here: `temperature`, `top_p`, `top_k`. Sonnet 5 rejects
 * non-default sampling parameters outright. None were ever sent; keep it that way.
 */
const EFFORT_CAPABLE = /^claude-(opus-5|sonnet-5|fable-5|mythos-5|opus-4-[5678]|sonnet-4-6)/
// SDK upgraded to 0.116 — `xhigh` is now in `output_config.effort`'s type, so it's back.
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
type EffortLevel = typeof EFFORT_LEVELS[number]

function chatEffort(): EffortLevel {
  const raw = process.env.AI_EFFORT as EffortLevel | undefined
  return raw && EFFORT_LEVELS.includes(raw) ? raw : 'medium'
}

function effortConfig(model: string): { output_config: { effort: EffortLevel } } | Record<string, never> {
  return EFFORT_CAPABLE.test(model) ? { output_config: { effort: chatEffort() } } : {}
}

// ── SCHEDULER_V2 ────────────────────────────────────────────────────────────

/**
 * Appended to the DYNAMIC half of the system prompt when the flag is on.
 *
 * The v1 prompt is full of "call get_free_slots first" instructions, and under
 * the flag that tool is not offered at all — so without this the model would be
 * told to reach for something that no longer exists. Keeping the correction out
 * of the static prefix means the cacheable half never varies by flag.
 */
const SCHEDULER_V2_GUIDANCE = `
SCHEDULING ENGINE (this overrides any earlier instruction about get_free_slots):
- get_free_slots no longer exists. Do NOT compute free time, count hours, or pick times yourself — you will get it wrong on all-day events and recurring series, and you cannot see what the user has quietly been moving.
- "When should I…" / "מתי כדאי…" / "תמצא לי זמן" / anything needing multiple sessions → schedule_item.
- Splitting a big task or an exam across sessions → break_down_task (same engine).
- Moving an event without a specific new time → move_event with the times omitted (this one applies straight away and returns the new time).
- schedule_item and break_down_task return a PROPOSAL with a plan_id and write nothing. Show it, wait for agreement, then apply_plan with that plan_id. In autonomy_mode "auto" you may apply immediately.
- Every block comes with a "why" array of finished sentences. Paraphrase those. Never invent a different reason, and never state a reason the engine did not give.
- status "partial" or "blocked" means it did NOT all fit. Say so plainly, name what did not fit, and offer the "suggestions" verbatim. Do not round a partial plan up to a success.
- create_event stays for times the user named explicitly.
`.trim()

/**
 * Appended to the DYNAMIC half of the system prompt when PROJECTS is on.
 *
 * Same rule as SCHEDULER_V2_GUIDANCE and for the same reason: the static prefix is
 * prompt-cached, so anything that varies by flag must live in the dynamic suffix
 * or every user pays a cache miss on every turn, flag-off ones included.
 */
const PROJECTS_GUIDANCE = `
PROJECTS:
- A project is a body of work with several steps and usually a deadline: a course, something to hand in, something the user is building. A single errand stays a task.
- Three or more steps, or a deadline for a body of work rather than one item -> create_project, and pass the steps in "tasks" in that same call. Do not create the project and then make five create_task calls.
- kind: "course" (has an exam/submission date), "deliverable" (one hard date), "build" (usually open-ended). A project with no deadline has no risk to report - never describe it as "on track", because there is nothing it could be on track for.
- estimated_hours on each step is what makes the deadline-risk number possible. If you do not know, ASK. Never invent hours: a confident badge computed from a guess is worse than an honest "I cannot tell yet".
- "מה מצב הפרויקטים" / "איפה אני עומד" -> list_projects. It returns "signals" already worded. Paraphrase them. Do NOT work out for yourself whether something fits in time — that is the engine's answer, exactly as with schedule_item's reasons.
- "תכנן לי את הפרויקט" -> plan_project, which schedules every step together so dependencies and deadlines resolve against each other. It returns a PROPOSAL with a plan_id and writes nothing: show it, wait for agreement, then apply_plan.
- plan_project returns "skipped" for steps with no time estimate. Report them; do not pretend they were scheduled.
- If it reports a circular dependency, name the two tasks and ask the user to fix it. Do not work around it.
- Ordering between steps is "depends_on" on the task. A step never gets scheduled before the step it depends on has finished.
- delete_project keeps the tasks by default and NEVER clears the calendar. Prefer status "archived" unless the user actually said delete.
`.trim()

/** Parse an "HH:mm" string to an hour in [0,23], falling back on bad input. */
function parseHour(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const m = /^(\d{1,2})/.exec(value.trim())
  if (!m) return fallback
  const h = parseInt(m[1], 10)
  return h >= 0 && h <= 23 ? h : fallback
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildErrorStream(message: string): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        `data: ${JSON.stringify({ type: 'events', createdEvents: [], updatedEvents: [], deletedEventIds: [] })}\n\n`
      ))
      controller.enqueue(encoder.encode(
        `data: ${JSON.stringify({ type: 'text', content: message })}\n\n`
      ))
      controller.enqueue(encoder.encode('data: {"type":"done"}\n\n'))
      controller.close()
    },
  })
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' },
  })
}

function loadFreshProfile(userId: string): UserProfile | null {
  const file = path.join(DATA_DIR, 'users',assertSafeUserId(userId), 'profile.json')
  return readJsonFile<UserProfile | null>(file, null)
}

function toAnthropicTools(tools: OpenAI.ChatCompletionTool[]) {
  return tools.map(t => {
    // ChatCompletionTool has a .function property; cast to access it
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn = (t as any).function as { name: string; description?: string; parameters?: unknown }
    return {
      name: fn.name,
      description: fn.description ?? '',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      input_schema: fn.parameters as any,
    }
  })
}

// ─── Main handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder()

  try {
    const cookieStore = await cookies()
    const token = cookieStore.get(COOKIE_NAME)?.value
    const userId = getUserIdFromCookie(token)

    if (!userId) return new Response('Unauthorized', { status: 401 })

    const body = await req.json()
    const { messages, events, profile, isOnboarding, memory, tasks, timezone } = body as {
      messages: Array<{ role: 'user' | 'assistant'; content: string }>
      events: CalendarEvent[]
      profile: UserProfile | null
      isOnboarding?: boolean
      memory?: Array<{ key: string; value: string }>
      tasks?: Task[]
      timezone?: string
    }

    // Always load from server-side profile (never trust the client-sent profile for secrets)
    const freshProfile: UserProfile | null = loadFreshProfile(userId)

    // Anthropic is the only provider — one server-wide key, model chosen via env
    // (no code change to switch). Per-user API keys were removed: Settings never
    // shipped a UI to enter one, so the encrypted-key precedence was dead code.
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      return buildErrorStream('⚙️ No Anthropic API key configured on the server.')
    }
    const model = process.env.AI_MODEL || DEFAULT_ANTHROPIC_MODEL

    // One model, pinned for the whole conversation — see DEFAULT_ANTHROPIC_MODEL.
    const v2 = schedulerV2Enabled()
    const projects = projectsEnabled()
    console.log('[chat] model:', model, 'scheduler_v2:', v2)
    // ───────────────────────────────────────────────────────────────────────

    // Create "now" in the user's timezone (Railway runs UTC; user may be in Asia/Jerusalem etc.)
    const userNow = (() => {
      if (!timezone) return new Date()
      try {
        // Get the current time as it appears in the user's timezone
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: timezone,
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit',
          hourCycle: 'h23',
        }).formatToParts(new Date())
        const get = (t: string) => parts.find(p => p.type === t)?.value ?? '0'
        return new Date(`${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`)
      } catch { return new Date() }
    })()

    // Deterministic learning signals (rejections/moves of AI events).
    const feedback = readFeedback(userId)

    // Memory recall must NOT depend on the client sending it. The client loads
    // memory async on mount, so a fast first message can POST an empty array and
    // the AI "forgets" the user across sessions. We always read the file
    // server-side as the source of truth; fall back to the client body only
    // if the file is empty (e.g. a brand-new user mid-onboarding).
    const serverMemory = readJsonFile<AIMemory[]>(memoryFile(userId), [])
    const effectiveMemory: AIMemory[] | undefined =
      serverMemory && serverMemory.length > 0
        ? serverMemory
        : (memory as AIMemory[] | undefined)

    // The server's profile wins over the client's, for the same reason
    // effectiveMemory does above: the client's copy is a snapshot from page load,
    // and Settings writes go to the server. This mattered nowhere until a tool
    // could write profile fields mid-turn — then the turn that changes your hours
    // would be the one turn that reasons from the old ones.
    const effectiveProfile: UserProfile | null = freshProfile ?? profile

    // Split system prompt: stable `staticPrefix` (cacheable) + per-request `dynamicSuffix`.
    const rawSys = isOnboarding
      ? { staticPrefix: buildOnboardingSystemPrompt(effectiveProfile?.language ?? 'en', userNow), dynamicSuffix: '' }
      : buildSystemPrompt(effectiveProfile, events, userNow, effectiveMemory, tasks, feedback)
    // Under the flag the v1 prompt still tells the model to call get_free_slots and
    // do the arithmetic itself — a tool that no longer exists. The correction goes
    // in the DYNAMIC suffix, never the static prefix, so the cached prefix is
    // byte-identical whether the flag is on or off.
    const guidance = [
      v2 ? SCHEDULER_V2_GUIDANCE : '',
      projects ? PROJECTS_GUIDANCE : '',
    ].filter(Boolean).join('\n\n')
    const sys = guidance
      ? { ...rawSys, dynamicSuffix: `${rawSys.dynamicSuffix}\n\n${guidance}`.trim() }
      : rawSys

    const createdEvents: CalendarEvent[] = []
    const updatedEvents: CalendarEvent[] = []
    const deletedEventIds: string[] = []
    let lastContent = ''
    // "Did this turn actually do anything" — the input to the shared retry rule.
    let toolCallsMade = 0
    let completedProfile: UserProfile | null = null
    const state = { completedProfile: null as UserProfile | null, memoryUpdated: false, tasksUpdated: false, projectsUpdated: false }

    // Everything the engine-backed tools need that the v1 dispatcher never carried.
    // `enabled: false` makes every v2 branch inside executeTool unreachable.
    const schedCtx: SchedulerCtx = {
      enabled: v2,
      memory: effectiveMemory ?? [],
      feedback: feedback as FeedbackSignal[],
      timezone,
      isHe: (profile?.language ?? 'he') === 'he',
    }
    const activeTools = isOnboarding ? getOnboardingTools(v2, projects) : getCalendarTools(v2, projects)

    // ── Tool-call loop ──────────────────────────────────────────────────────

    {
      // Anthropic tool-call loop
      const Anthropic = (await import('@anthropic-ai/sdk')).default
      const anthropic = new Anthropic({ apiKey })
      const anthropicTools = toAnthropicTools(activeTools)
      const anthropicSystem = sys.dynamicSuffix
        ? [
            { type: 'text' as const, text: sys.staticPrefix, cache_control: { type: 'ephemeral' as const } },
            { type: 'text' as const, text: sys.dynamicSuffix },
          ]
        : [{ type: 'text' as const, text: sys.staticPrefix, cache_control: { type: 'ephemeral' as const } }]

      type AnthropicMessageParam = { role: 'user' | 'assistant'; content: string | object[] }
      const anthropicMessages: AnthropicMessageParam[] = messages.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }))

      // The provider loop gets its own try/catch: an SDK throw here used to fall
      // all the way out to the outer catch, which returns a bare error frame with
      // no `done` — and the client's reader waits forever on a turn that is over.
      try {
        let iterations = 0
        const loopStart = Date.now()
        while (iterations < 10) {
          if (Date.now() - loopStart > MAX_LOOP_MS) {
            console.warn('[chat] Anthropic tool-loop timeout after', iterations, 'iterations')
            if (!lastContent) lastContent = '⏱️ This took too long to process. Please try again.'
            break
          }
          iterations++
          const response = await anthropic.messages.create({
            model,
            // Prompt caching: stable prefix cached (~10% on reads), volatile suffix not.
            system: anthropicSystem,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            messages: anthropicMessages as any,
            tools: anthropicTools,
            max_tokens: ANTHROPIC_MAX_TOKENS,
            ...effortConfig(model),
          })

          // Cache visibility: cache_read_input_tokens > 0 means the static prefix was reused.
          if (response.usage) console.log('[chat] anthropic usage:', JSON.stringify(response.usage))

          if (response.stop_reason === 'tool_use') {
            anthropicMessages.push({ role: 'assistant', content: response.content as object[] })

            const toolResults: object[] = []
            for (const block of response.content) {
              if (block.type === 'tool_use') {
                toolCallsMade++
                const result = await executeTool(
                  block.name,
                  block.input as Record<string, unknown>,
                  userId as string,
                  events,
                  createdEvents,
                  updatedEvents,
                  deletedEventIds,
                  // The server's copy, not the client's — every scheduling call
                  // inside the dispatcher reads this for hours and method.
                  effectiveProfile,
                  state,
                  freshProfile?.push_subscription,
                  freshProfile?.fcm_token,
                  userNow,
                  schedCtx,
                )
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: block.id,
                  content: JSON.stringify(result),
                })
              }
            }
            anthropicMessages.push({ role: 'user', content: toolResults })
            continue
          }

          // End turn — extract text
          const textBlock = response.content.find(b => b.type === 'text')
          lastContent = (textBlock as { type: 'text'; text: string } | undefined)?.text ?? ''
          break
        }

        // A tool turn that ends with no text — or with "בוצע!" — leaves the user
        // watching events appear with no account of what was decided. One shared
        // rule decides that for both providers; see lib/ai/followup.ts.
        if (needsFollowup(lastContent, toolCallsMade)) {
          try {
            const followupMessages: AnthropicMessageParam[] = [...anthropicMessages]
            // An empty assistant turn is rejected by the API, so only echo real text.
            if (lastContent.trim()) followupMessages.push({ role: 'assistant', content: lastContent })
            followupMessages.push({ role: 'user', content: followupPrompt(schedCtx.isHe) })

            const followup = await anthropic.messages.create({
              model,
              system: anthropicSystem,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              messages: followupMessages as any,
              max_tokens: ANTHROPIC_FOLLOWUP_MAX_TOKENS,
              ...effortConfig(model),
            })
            const tb = followup.content.find(b => b.type === 'text')
            const retryText = (tb as { type: 'text'; text: string } | undefined)?.text ?? ''
            if (retryText.trim().length > lastContent.trim().length) lastContent = retryText
          } catch (err) {
            console.warn('[chat] follow-up summary failed:', (err as Error)?.message)
          }
        }
      } catch (err) {
        // Whatever happened, the turn still has to end cleanly: report it as text
        // and fall through to the stream, which always terminates with `done`.
        console.error('[chat] Anthropic provider loop failed:', err)
        if (!lastContent) {
          lastContent = schedCtx.isHe
            ? '⚠️ הייתה תקלה מול מנוע ה-AI. נסה שוב בעוד רגע.'
            : '⚠️ The AI provider failed on this request. Please try again in a moment.'
        }
      }

      if (state.completedProfile) completedProfile = state.completedProfile

    }

    // ── Anthropic / shared SSE stream ───────────────────────────────────────
    const readableStream = new ReadableStream({
      async start(controller) {
        try {
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ type: 'events', createdEvents, updatedEvents, deletedEventIds })}\n\n`
          ))

          if (completedProfile) {
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ type: 'onboarding_complete', profile: completedProfile })}\n\n`
            ))
          }

          if (state.memoryUpdated) {
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ type: 'memory_updated' })}\n\n`
            ))
          }

          if (state.tasksUpdated) {
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ type: 'tasks_updated' })}\n\n`
            ))
          }

          // Its own frame rather than a reuse of tasks_updated: refetching projects
          // also pulls /api/projects/health, which runs a real placement pass, and
          // making every task edit pay for that would be a poor trade.
          if (state.projectsUpdated) {
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ type: 'projects_updated' })}\n\n`
            ))
          }

          if (lastContent) {
            const words = lastContent.split(/(?<=\s)|(?=\s)/)
            for (const word of words) {
              if (word) {
                controller.enqueue(encoder.encode(
                  `data: ${JSON.stringify({ type: 'text', content: word })}\n\n`
                ))
              }
            }
          } else {
            // Last-resort backstop: never end a turn silently. If actions happened,
            // confirm them; otherwise send a soft ack so the UI isn't left blank.
            const isHe = (profile?.language ?? 'he') === 'he'
            const parts: string[] = []
            if (createdEvents.length) parts.push(isHe ? `נוספו ${createdEvents.length} אירועים` : `added ${createdEvents.length} event(s)`)
            if (updatedEvents.length) parts.push(isHe ? `עודכנו ${updatedEvents.length}` : `updated ${updatedEvents.length}`)
            if (deletedEventIds.length) parts.push(isHe ? `נמחקו ${deletedEventIds.length}` : `deleted ${deletedEventIds.length}`)
            const msg = parts.length
              ? `✓ ${parts.join(isHe ? ', ' : ', ')}`
              : (isHe ? '✓ בוצע' : '✓ Done')
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ type: 'text', content: msg })}\n\n`
            ))
          }

        } catch (err) {
          console.error('Stream error:', err)
          controller.enqueue(encoder.encode('data: {"type":"error"}\n\n'))
        } finally {
          // `done` must be unconditional, or an error frame leaves the client
          // waiting on a stream that has closed.
          controller.enqueue(encoder.encode('data: {"type":"done"}\n\n'))
          controller.close()
        }
      }
    })

    return new Response(readableStream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      },
    })

  } catch (err) {
    // Last line of defence — anything the provider loops didn't already catch
    // (bad request body, auth, storage). Still a well-formed SSE turn: the
    // client's reader only stops on `done`, so a bare error frame hangs the UI.
    console.error('Chat API error:', err)
    return new Response(
      `data: {"type":"events","createdEvents":[],"updatedEvents":[],"deletedEventIds":[]}\n\n` +
      `data: {"type":"error","message":"Internal server error"}\n\n` +
      `data: {"type":"done"}\n\n`,
      { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } }
    )
  }
}

// ─── Tool executor ────────────────────────────────────────────────────────────

async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  userId: string,
  currentEvents: CalendarEvent[],
  createdEvents: CalendarEvent[],
  updatedEvents: CalendarEvent[],
  deletedEventIds: string[],
  profile: UserProfile | null,
  state: { completedProfile: UserProfile | null; memoryUpdated: boolean; tasksUpdated: boolean; projectsUpdated: boolean } = { completedProfile: null, memoryUpdated: false, tasksUpdated: false, projectsUpdated: false },
  pushSubscription?: string,
  fcmToken?: string,
  now: Date = new Date(),  // user-local "now" (Asia/Jerusalem), not server UTC — used for scheduling
  // Absent (or disabled) ⇒ every `sched?.enabled` branch below is dead and the
  // dispatcher behaves exactly as it did before the engine existed.
  sched?: SchedulerCtx,
): Promise<unknown> {
  // ── Input validation helpers ──────────────────────────────────────────────
  const str  = (v: unknown): string  => (typeof v === 'string' ? v : '')
  const num  = (v: unknown): number  => (typeof v === 'number' ? v : 0)
  const bool = (v: unknown): boolean => (typeof v === 'boolean' ? v : false)

  // A v2-only tool reached through a stale transcript when the flag is off must
  // fail loudly rather than silently doing nothing.
  if (!sched?.enabled && V2_ONLY_TOOLS.has(toolName)) {
    return { error: 'unknown_tool', message: `Unknown tool: ${toolName}` }
  }

  // Same fail-closed rule for the projects surface: a stale transcript must not be
  // able to reach a tool the flag has turned off.
  const projectsOn = projectsEnabled()
  if (!projectsOn && PROJECT_ONLY_TOOLS.has(toolName)) {
    return { error: 'unknown_tool', message: `Unknown tool: ${toolName}` }
  }

  switch (toolName) {
    case 'create_event': {
      // Validate required fields
      if (!str(input.title) || !str(input.start_time) || !str(input.end_time)) {
        return { error: 'missing_required_fields', message: 'title, start_time, and end_time are required' }
      }
      if (isNaN(Date.parse(str(input.start_time))) || isNaN(Date.parse(str(input.end_time)))) {
        return { error: 'invalid_date', message: 'start_time or end_time is not a valid date' }
      }
      if (Date.parse(str(input.end_time)) <= Date.parse(str(input.start_time))) {
        return { error: 'invalid_range', message: 'end_time must be after start_time' }
      }
      // ── Recurring shortcut: generate N instances, skip conflict checks ───
      const recurrence = input.recurrence as { frequency?: string; count?: number; end_date?: string } | undefined
      if (recurrence?.frequency && sched?.enabled) {
        // Same generation, but every instance is checked against the real
        // timeline — the one that understands all-day events and multi-day
        // spans — and every skip is reported. The v1 path below checks only
        // `fixed` clashes with a naive overlap test and then swallows the
        // result in a bare `skipped` count, which is how a weekly series
        // quietly double-booked itself from week three onward.
        return applyRecurringPlan(input, userId, currentEvents, createdEvents, profile, sched, recurrence)
      }
      if (recurrence?.frequency) {
        const seriesId = crypto.randomUUID()
        const baseStart = new Date(input.start_time as string)
        const baseEnd   = new Date(input.end_time as string)
        const durationMs = baseEnd.getTime() - baseStart.getTime()
        const freq = recurrence.frequency
        const daysStep = freq === 'monthly' ? 30 : freq === 'biweekly' ? 14 : 7
        const maxCount = recurrence.count ?? (freq === 'monthly' ? 6 : 12)
        const endDate  = recurrence.end_date ? new Date(recurrence.end_date) : null
        const recTitleLower = str(input.title).toLowerCase().trim()
        let created = 0
        let skipped = 0
        let recWriteErrors = 0

        for (let i = 0; i < maxCount; i++) {
          const instanceStart = addDays(baseStart, i * daysStep)
          if (endDate && instanceStart > endDate) break
          const instanceEnd = new Date(instanceStart.getTime() + durationMs)

          const known = [...currentEvents, ...createdEvents]
          // Dedupe: identical title at this exact start already exists (e.g. the series
          // was created once already in a retry) — don't pile on duplicates.
          const isDup = known.some(e =>
            e.title.toLowerCase().trim() === recTitleLower &&
            new Date(e.start_time).getTime() === instanceStart.getTime()
          )
          if (isDup) { skipped++; continue }
          // Never drop a recurring (usually flexible) instance on top of a FIXED
          // commitment (exam/lecture/flight). Skip that instance instead of stomping it.
          const clashesFixed = known.some(e => {
            const mob = e.mobility_type ?? classifyMobility(e.title, e.created_by, true)
            if (mob !== 'fixed') return false
            return instanceStart < new Date(e.end_time) && instanceEnd > new Date(e.start_time)
          })
          if (clashesFixed) { skipped++; continue }

          const instance: CalendarEvent = {
            id: crypto.randomUUID(),
            user_id: userId,
            title: str(input.title),
            start_time: format(instanceStart, "yyyy-MM-dd'T'HH:mm:ss"),
            end_time: format(instanceEnd, "yyyy-MM-dd'T'HH:mm:ss"),
            description: str(input.description),
            color: str(input.color) || '#3B7EF7',
            source: 'zman',
            created_by: 'ai',
            status: 'confirmed',
            is_all_day: false,
            created_at: new Date().toISOString(),
            series_id: seriesId,
            recurrence_rule: freq,
          }

          try {
            userStore.addEvent(instance, userId)
          } catch (err) {
            recWriteErrors++
            console.warn('[chat] recurring instance write failed:', (err as Error)?.message)
            continue  // don't count an instance that didn't save
          }

          createdEvents.push(instance)
          created++
        }
        return {
          success: recWriteErrors === 0,
          series_id: seriesId,
          instances_created: created,
          skipped,
          ...(recWriteErrors > 0 ? { error: 'write_failed', message: `${recWriteErrors} instance(s) failed to save — do NOT claim those were created.` } : {}),
        }
      }

      const allKnownEvents = [...currentEvents, ...createdEvents]

      // 1. Duplicate check — same title AND same start time.
      // (Same title at a different hour is a legitimate second session, not a dup.)
      const newTitle = str(input.title).toLowerCase().trim()
      const newStartTs = new Date(str(input.start_time)).getTime()
      const duplicate = allKnownEvents.find(e =>
        new Date(e.start_time).getTime() === newStartTs &&
        e.title.toLowerCase().trim() === newTitle
      )
      if (duplicate) {
        return { error: 'duplicate', existingId: duplicate.id, existingTitle: duplicate.title, existingTime: duplicate.start_time }
      }

      // 2. Overlap check — detect real time conflicts and suggest alternatives
      const newStart = new Date(str(input.start_time))
      const newEnd = new Date(str(input.end_time))
      const overlapping = allKnownEvents.find(e => {
        const eStart = new Date(e.start_time)
        const eEnd = new Date(e.end_time)
        return newStart < eEnd && newEnd > eStart
      })
      if (overlapping) {
        const duration = (newEnd.getTime() - newStart.getTime()) / 60000
        const rangeStart = new Date(newStart)
        rangeStart.setHours(0, 0, 0, 0)
        const rangeEnd = addDays(rangeStart, 3)
        const alternatives = getFreeSlots(
          allKnownEvents, rangeStart.toISOString(), rangeEnd.toISOString(), duration, profile, false, now
        ).slice(0, 3)
        return {
          error: 'conflict',
          conflictingEvent: { id: overlapping.id, title: overlapping.title, start: overlapping.start_time, end: overlapping.end_time },
          alternatives,
        }
      }

      // 3. Buffer check — warn if this event will be back-to-back with another
      const bufferWarnings: string[] = []
      for (const ev of allKnownEvents) {
        const evStart = new Date(ev.start_time)
        const evEnd = new Date(ev.end_time)
        const gapAfter = (newStart.getTime() - evEnd.getTime()) / 60000
        if (gapAfter >= 0 && gapAfter < BUFFER_MIN) {
          bufferWarnings.push(`"${ev.title}" ends only ${Math.round(gapAfter)} min before this event`)
        }
        const gapBefore = (evStart.getTime() - newEnd.getTime()) / 60000
        if (gapBefore >= 0 && gapBefore < BUFFER_MIN) {
          bufferWarnings.push(`"${ev.title}" starts only ${Math.round(gapBefore)} min after this event`)
        }
      }

      const status = str(input.status)
      const event: CalendarEvent = {
        id: crypto.randomUUID(),
        user_id: userId,
        title: str(input.title),
        start_time: str(input.start_time),
        end_time: str(input.end_time),
        description: str(input.description),
        color: str(input.color) || '#3B7EF7',
        source: 'zman',
        created_by: 'ai',
        status: (status === 'confirmed' || status === 'proposed') ? status : 'confirmed',
        is_all_day: bool(input.is_all_day),
        created_at: new Date().toISOString(),
        // Auto-classify mobility if AI didn't specify
        mobility_type: (input.mobility_type === 'fixed' || input.mobility_type === 'flexible' || input.mobility_type === 'ask_first')
          ? input.mobility_type
          : classifyMobility(str(input.title), 'ai', true),
      }

      try {
        userStore.addEvent(event, userId)
      } catch (err) {
        return { error: 'write_failed', message: `Could not save the event: ${(err as Error)?.message}. Do NOT tell the user it was created.` }
      }

      createdEvents.push(event)
      return { success: true, event, buffer_warnings: bufferWarnings.length > 0 ? bufferWarnings : undefined }
    }

    case 'update_event': {
      const { event_id, title, color, mobility_type, apply_to_series } = input as {
        event_id: string; title?: string; color?: string; mobility_type?: string; apply_to_series?: boolean
      }
      const existing = currentEvents.find(e => e.id === event_id)
      if (!existing) return { error: 'Event not found' }

      const changes: Record<string, string> = {}
      if (title)         changes.title         = title
      if (color)         changes.color         = color
      if (mobility_type) changes.mobility_type = mobility_type

      if (Object.keys(changes).length === 0) return { error: 'No changes provided' }

      // Apply to entire recurring series
      if (apply_to_series && existing.series_id) {
        const seriesEvents = currentEvents.filter(e => e.series_id === existing.series_id)
        for (const e of seriesEvents) userStore.updateEvent(e.id, changes as Partial<CalendarEvent>, userId)
        const updatedSeries = seriesEvents.map(e => ({ ...e, ...changes } as CalendarEvent))
        updatedEvents.push(...updatedSeries)
        return { success: true, updated_count: seriesEvents.length, series_id: existing.series_id }
      }

      // Single event update
      userStore.updateEvent(event_id, changes as Partial<CalendarEvent>, userId)

      const updated = { ...existing, ...changes }
      updatedEvents.push(updated as CalendarEvent)
      return {
        success: true,
        event: updated,
        // Signal the mismatch when the model asked for a series update but there's no series
        ...(apply_to_series && !existing.series_id ? { warning: 'This event has no series_id — updated the single instance only.' } : {}),
      }
    }

    case 'move_event': {
      const { event_id, new_start_time, new_end_time } = input as { event_id: string; new_start_time: string; new_end_time: string }

      // ── SCHEDULER_V2: no time given means "you find one" ──────────────────
      // A move is a single, visible, reversible change, so unlike schedule_item
      // it applies immediately — but the slot is the engine's answer, not the
      // model's guess, and it comes back with the reasons that chose it.
      if (sched?.enabled && !str(new_start_time)) {
        return applyEngineMove(
          str(event_id), userId, currentEvents, createdEvents, updatedEvents, profile, sched, now,
        )
      }

      if (!str(new_start_time) || !str(new_end_time) ||
          isNaN(Date.parse(str(new_start_time))) || isNaN(Date.parse(str(new_end_time)))) {
        return { error: 'invalid_date', message: 'new_start_time and new_end_time must be valid dates' }
      }
      if (Date.parse(str(new_end_time)) <= Date.parse(str(new_start_time))) {
        return { error: 'invalid_range', message: 'new_end_time must be after new_start_time' }
      }
      const existing = currentEvents.find(e => e.id === event_id)
      if (!existing) return { error: 'Event not found' }
      // Enforce mobility_type — fixed events cannot be moved
      if (existing.mobility_type === 'fixed') {
        return { error: 'fixed_event', message: `"${existing.title}" is marked as Fixed (🔒) and cannot be moved.` }
      }

      // Overlap check — don't let a move stack this event on top of another
      const moveStart = new Date(str(new_start_time))
      const moveEnd = new Date(str(new_end_time))
      const moveConflict = [...currentEvents, ...createdEvents].find(e => {
        if (e.id === event_id) return false  // ignore the event being moved
        return moveStart < new Date(e.end_time) && moveEnd > new Date(e.start_time)
      })
      if (moveConflict) {
        const duration = (moveEnd.getTime() - moveStart.getTime()) / 60000
        const rangeStart = new Date(moveStart); rangeStart.setHours(0, 0, 0, 0)
        const alternatives = getFreeSlots(
          currentEvents.filter(e => e.id !== event_id),
          rangeStart.toISOString(), addDays(rangeStart, 3).toISOString(), duration, profile, false, now
        ).slice(0, 3)
        return {
          error: 'conflict',
          conflictingEvent: { id: moveConflict.id, title: moveConflict.title, start: moveConflict.start_time, end: moveConflict.end_time },
          alternatives,
        }
      }

      const updated = { ...existing, start_time: new_start_time, end_time: new_end_time }

      // Learning signal: moving an AI-created event = its proposed time wasn't right.
      if (existing.created_by === 'ai') {
        const oldStart = new Date(existing.start_time)
        recordFeedback(userId, {
          type: 'moved', title: existing.title,
          fromHour: oldStart.getHours(), toHour: new Date(str(new_start_time)).getHours(),
          day: format(oldStart, 'EEE'), at: new Date().toISOString(),
        })
      }

      userStore.updateEvent(event_id, { start_time: new_start_time, end_time: new_end_time }, userId)

      updatedEvents.push(updated)
      return { success: true, event: updated }
    }

    case 'delete_event': {
      const { event_id, delete_series } = input as { event_id: string; delete_series?: boolean }

      // ── Delete entire recurring series ──────────────────────────────────
      if (delete_series) {
        const allKnownEvents = [...currentEvents, ...createdEvents]
        const target = allKnownEvents.find(e => e.id === event_id)
        const sid = target?.series_id

        if (sid) {
          const seriesIds = currentEvents.filter(e => e.series_id === sid).map(e => e.id)
          for (const id of seriesIds) userStore.deleteEvent(id, userId)
          deletedEventIds.push(...seriesIds)
          return { success: true, deleted_series_id: sid, instances_deleted: seriesIds.length }
        }
        // No series_id — fall through to single delete
      }

      userStore.deleteEvent(event_id, userId)

      deletedEventIds.push(event_id)
      return { success: true }
    }

    // Still declared and still working with the flag off. With the flag on it is
    // simply not in the tool list the model is given, so this case is unreachable
    // — the arithmetic is the engine's job, and an unoffered tool cannot be called.
    case 'get_free_slots': {
      const { from_date, to_date, min_duration_minutes = 60, prefer_peak = false } = input as { from_date: string; to_date: string; min_duration_minutes?: number; prefer_peak?: boolean }
      return { free_slots: getFreeSlots(currentEvents, from_date, to_date, min_duration_minutes as number, profile, prefer_peak as boolean, now) }
    }

    // ── SCHEDULER_V2 tools ────────────────────────────────────────────────
    // Guarded above by V2_ONLY_TOOLS, so with the flag off neither is reachable.

    case 'schedule_item': {
      if (!sched?.enabled) return { error: 'unknown_tool', message: 'Unknown tool: schedule_item' }
      const spec = buildScheduleItemSpec(input, profile, sched)
      if (!spec) return { error: 'missing_required_fields', message: 'title is required' }
      // Events created earlier in this same turn are part of the world the
      // engine must plan around, or two tool calls in one turn book the same hour.
      return proposePlan(userId, [...currentEvents, ...createdEvents], profile, sched, now, spec).toolResult
    }

    case 'apply_plan': {
      if (!sched?.enabled) return { error: 'unknown_tool', message: 'Unknown tool: apply_plan' }
      const planId = str(input.plan_id)
      if (!planId) return { error: 'missing_required_fields', message: 'plan_id is required' }

      // Consumed, not just read: the blocks are written verbatim, so applying the
      // same proposal twice would duplicate every event on the calendar.
      const plan = consumePlan(userId, planId)
      if (!plan) {
        return {
          error: 'plan_expired',
          message: 'That plan is no longer available (applied already, or older than ~10 minutes). Call schedule_item again — do NOT invent times from the earlier message.',
        }
      }

      const written: CalendarEvent[] = []
      const failed: string[] = []
      // A project plan changes what the board shows, so the client must refetch.
      if (plan.blocks.some(b => b.project_id)) state.projectsUpdated = true
      for (const block of plan.blocks) {
        const event: CalendarEvent = {
          id: crypto.randomUUID(),
          user_id: userId,
          title: block.title,
          start_time: block.start,
          end_time: block.end,
          // The engine's own justification, kept on the event so the calendar
          // can still answer "why is this here" long after the chat scrolled away.
          description: block.why.join(' · '),
          color: block.color,
          source: 'zman',
          created_by: 'ai',
          status: 'confirmed',
          is_all_day: false,
          created_at: new Date().toISOString(),
          mobility_type: block.mobility,
          // Set only for project plans. Without these the written events are not
          // linked to anything, and both invested-time and next-step silently
          // return nothing — the feature would look like it worked and quietly not.
          ...(block.project_id ? { project_id: block.project_id } : {}),
          ...(block.ref ? { ref: block.ref } : {}),
        }
        try {
          await persistEvent(event, userId)
          createdEvents.push(event)
          written.push(event)
        } catch (err) {
          failed.push(`${block.title} @ ${block.start}: ${(err as Error)?.message}`)
        }
      }

      return {
        success: failed.length === 0,
        events_created: written.length,
        events: written.map(e => ({ id: e.id, title: e.title, start: e.start_time, end: e.end_time })),
        ...(failed.length > 0 ? {
          error: 'write_failed',
          failed,
          message: `${failed.length} block(s) failed to save. Do NOT tell the user those were scheduled.`,
        } : {}),
      }
    }

    case 'break_down_task': {
      const { task_title, deadline, total_hours, session_length_hours, color = '#6366F1' } = input as {
        task_title: string; deadline: string; total_hours: number; session_length_hours?: number; color?: string
      }

      // ── SCHEDULER_V2: the same request, answered by the engine ─────────────
      // Session length still comes from the method (that is a promise the UI
      // makes), but WHERE the sessions land is the engine's answer, and nothing
      // is written until the user agrees.
      if (sched?.enabled) {
        const spec = buildBreakdownSpec(input, profile, sched)
        if (!spec) return { error: 'missing_required_fields', message: 'task_title and a positive total_hours are required' }
        return proposePlan(userId, [...currentEvents, ...createdEvents], profile, sched, now, spec).toolResult
      }

      const userMethod = profile?.scheduling_method as string | undefined
      const effectiveSessionLength = session_length_hours
        ?? (userMethod ? METHOD_SESSION_HOURS[userMethod] : undefined)
        ?? 2

      const formatTitle = methodTitleFormatter(userMethod)
      const defaultMobility = methodMobility(userMethod)

      // Gather candidate slots chronologically (with is_peak flags) across the whole
      // window, then SPREAD the sessions across non-consecutive days instead of
      // stacking them — pickSpreadSlots prefers the peak slot within each chosen day.
      const sessionsNeeded = Math.ceil(total_hours / effectiveSessionLength)
      const candidateSlots = getFreeSlots(
        currentEvents, now.toISOString(), deadline, effectiveSessionLength * 60, profile, false, now,
        Math.max(40, sessionsNeeded * 6)
      )
      const slots = pickSpreadSlots(candidateSlots, sessionsNeeded)
      let created = 0
      let writeErrors = 0

      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i]
        const event: CalendarEvent = {
          id: crypto.randomUUID(),
          user_id: userId,
          title: formatTitle(task_title, i),
          start_time: slot.start,
          end_time: format(addMinutes(parseISO(slot.start), effectiveSessionLength * 60), "yyyy-MM-dd'T'HH:mm:ss"),
          color: color as string,
          source: 'zman',
          created_by: 'ai',
          status: 'confirmed',
          is_all_day: false,
          created_at: new Date().toISOString(),
          mobility_type: defaultMobility,
        }

        try {
          userStore.addEvent(event, userId)
        } catch (err) {
          writeErrors++
          console.warn('[chat] break_down_task write failed:', (err as Error)?.message)
          continue  // don't count or surface a session that didn't actually save
        }

        createdEvents.push(event)
        created++
      }

      // Distinguish "couldn't fit before the deadline" (normal) from "write failed" (error)
      // so the AI reports honestly instead of claiming sessions that don't exist.
      const noRoom = Math.max(0, sessionsNeeded - slots.length)
      return {
        success: writeErrors === 0,
        sessions_created: created,
        sessions_needed: sessionsNeeded,
        sessions_unscheduled: sessionsNeeded - created,
        ...(noRoom > 0 ? { warning: `Only ${slots.length} of ${sessionsNeeded} sessions fit before the deadline — ${noRoom} could not be placed. Tell the user and suggest extending the deadline or freeing time.` } : {}),
        ...(writeErrors > 0 ? { error: 'write_failed', message: `${writeErrors} session(s) failed to save. Do NOT claim those were scheduled.` } : {}),
      }
    }

    case 'list_events': {
      const { from_date, to_date } = input as { from_date: string; to_date: string }
      const filtered = currentEvents.filter(e => {
        const start = new Date(e.start_time)
        return start >= new Date(from_date) && start <= new Date(to_date)
      })

      // Group recurring events by series_id so AI understands them as series, not individual instances
      const seriesMap: Record<string, { title: string; instances: string[]; mobility_type: string | undefined }> = {}
      const standalone: typeof filtered = []

      for (const e of filtered) {
        if (e.series_id) {
          if (!seriesMap[e.series_id]) {
            seriesMap[e.series_id] = { title: e.title, instances: [], mobility_type: e.mobility_type }
          }
          seriesMap[e.series_id].instances.push(e.id)
        } else {
          standalone.push(e)
        }
      }

      // Helper: strip lab/tutorial prefixes to find the base course name
      const baseCourse = (title: string) =>
        title.replace(/^(מעבדה ל|תרגול ל|תרגיל ל|lab for |tutorial for |lab |recitation )/i, '').trim()

      // Group series by base course name so AI understands lecture+lab+tutorial = one course
      const courseGroups: Record<string, string[]> = {}
      for (const [sid, s] of Object.entries(seriesMap)) {
        const base = baseCourse(s.title)
        if (!courseGroups[base]) courseGroups[base] = []
        courseGroups[base].push(sid)
      }

      const recurring_series = Object.entries(seriesMap).map(([series_id, s]) => ({
        series_id,
        title: s.title,
        base_course: baseCourse(s.title),
        instance_count: s.instances.length,
        instance_ids: s.instances,
        mobility_type: s.mobility_type ?? 'ask_first',
        note: 'Recurring series — use apply_to_series:true in update_event to update all instances at once',
      }))

      // Logical course list (lecture + lab + tutorial grouped under one course name)
      const logical_courses = Object.entries(courseGroups).map(([base, seriesIds]) => ({
        course_name: base,
        components: seriesIds.map(sid => ({ series_id: sid, title: seriesMap[sid].title, instance_count: seriesMap[sid].instances.length })),
        total_instances: seriesIds.reduce((n, sid) => n + seriesMap[sid].instances.length, 0),
        note: seriesIds.length > 1 ? `This course has ${seriesIds.length} components (e.g. lecture + lab). Hebrew number words in the title (אחד/שתיים/שלוש) are part of the course name, not arithmetic.` : undefined,
      }))

      return {
        events: standalone.map(e => ({ id: e.id, title: e.title, start: e.start_time, end: e.end_time, mobility_type: e.mobility_type ?? 'ask_first', series_id: e.series_id })),
        recurring_series,
        logical_courses,
        summary: `${standalone.length} standalone events, ${logical_courses.length} distinct courses (${recurring_series.length} series total, ${filtered.length - standalone.length} recurring instances)`,
      }
    }

    case 'analyze_schedule': {
      const { from_date, to_date } = input as { from_date: string; to_date: string }

      const rangeEvents = currentEvents
        .filter(e => {
          const start = new Date(e.start_time)
          return start >= new Date(from_date) && start <= new Date(to_date)
        })
        .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())

      // Group events by day
      const byDay: Record<string, CalendarEvent[]> = {}
      for (const ev of rangeEvents) {
        const day = format(new Date(ev.start_time), 'yyyy-MM-dd')
        if (!byDay[day]) byDay[day] = []
        byDay[day].push(ev)
      }

      const issues: string[] = []

      // Peak productivity hours from profile
      const peak = profile?.productivity_peak ?? 'morning'
      const peakStart = peak === 'morning' ? 6 : peak === 'afternoon' ? 12 : 18
      const peakEnd   = peak === 'morning' ? 12 : peak === 'afternoon' ? 18 : 23
      const sleepHour = parseHour(profile?.sleep_time, 23)
      // Active-day bounds (same source as getFreeSlots) — used to avoid midday-lunch
      // false positives for shift/night workers whose day doesn't span noon.
      // wake/sleep only — see the note on UserProfile.preferred_hours.
      const dayStartHour = parseHour(profile?.wake_time, 9)
      const dayEndHour = parseHour(profile?.sleep_time, 22)
      const hasMiddayWindow = dayStartHour <= 12 && dayEndHour >= 14
      const mob = (e: CalendarEvent) => e.mobility_type ?? classifyMobility(e.title, e.created_by, true)

      const dayStats: Array<{
        date: string
        dayOfWeek: string
        eventCount: number
        totalHours: number
        events: { id: string; title: string; start: string; end: string; color?: string }[]
      }> = []

      for (const [day, dayEvs] of Object.entries(byDay).sort()) {
        const totalMinutes = dayEvs.reduce((sum, e) =>
          sum + (new Date(e.end_time).getTime() - new Date(e.start_time).getTime()) / 60000, 0)
        const totalHours = Math.round(totalMinutes / 6) / 10

        dayStats.push({
          date: day,
          dayOfWeek: format(new Date(day), 'EEEE'),
          eventCount: dayEvs.length,
          totalHours,
          events: dayEvs.map(e => ({ id: e.id, title: e.title, start: e.start_time, end: e.end_time, color: e.color, mobility_type: e.mobility_type ?? 'ask_first' })),
        })

        // 1. Back-to-back events (< 15 min gap) — only worth flagging if at least one
        //    is movable. Two fixed events (lecture+lab) can't be spaced, so don't nag.
        for (let i = 0; i < dayEvs.length - 1; i++) {
          const gapMin = (new Date(dayEvs[i + 1].start_time).getTime() - new Date(dayEvs[i].end_time).getTime()) / 60000
          const movable = mob(dayEvs[i]) !== 'fixed' || mob(dayEvs[i + 1]) !== 'fixed'
          if (gapMin >= 0 && gapMin < 15 && movable) {
            issues.push(`BACK_TO_BACK: "${dayEvs[i].title}" and "${dayEvs[i + 1].title}" on ${day} — only ${Math.round(gapMin)} min gap, no buffer time`)
          }
        }

        // 2. No lunch break on a busy day (3+ events, nothing free 12:00–13:30).
        //    Skip entirely for shift/night schedules whose active window misses midday.
        if (dayEvs.length >= 3 && hasMiddayWindow) {
          const lunchStart = new Date(`${day}T12:00:00`)
          const lunchEnd   = new Date(`${day}T13:30:00`)
          const blocksLunch = dayEvs.some(e =>
            new Date(e.start_time) < lunchEnd && new Date(e.end_time) > lunchStart
          )
          if (blocksLunch) {
            issues.push(`NO_LUNCH: Busy day on ${day} (${dayEvs.length} events) with no free time between 12:00–13:30`)
          }
        }

        // 3. Overloaded day (> 6 hours scheduled)
        if (totalHours > 6) {
          issues.push(`OVERLOADED: ${day} (${format(new Date(day), 'EEEE')}) has ${totalHours}h of scheduled events`)
        }

        // 4. Late-night study or work (after sleepHour - 1)
        for (const ev of dayEvs) {
          const startHour = new Date(ev.start_time).getHours()
          const isStudyOrWork = ev.color === '#6366F1' ||
            /study|exam|homework|work|project|לימוד|מבחן|עבודה|שיעורי|תרגיל/i.test(ev.title)
          if (startHour >= sleepHour - 1 && isStudyOrWork) {
            issues.push(`LATE_NIGHT: "${ev.title}" on ${day} starts at ${format(new Date(ev.start_time), 'HH:mm')} — very close to sleep time (${profile?.sleep_time ?? '23:00'})`)
          }
        }

        // 5. Important event (exam/presentation) with no prep in the 3 days leading up.
        //    Checking only the day-before caused false "no prep" alerts when the user
        //    studied 2–3 days earlier.
        for (const ev of dayEvs) {
          const isImportant = /exam|test|presentation|מבחן|מצגת|הגשה|deadline/i.test(ev.title)
          if (isImportant) {
            const prepRe = /study|prep|review|practice|לימוד|חזרה|תרגול|הכנה/i
            const hasPrep = [1, 2, 3].some(d => {
              const prepDay = format(addDays(new Date(day), -d), 'yyyy-MM-dd')
              return byDay[prepDay]?.some(pe => prepRe.test(pe.title))
            })
            if (!hasPrep) {
              issues.push(`NO_PREP: "${ev.title}" on ${day} — no study/prep session found in the 3 days before`)
            }
          }
        }

        // 6. Important tasks scheduled outside peak productivity hours
        for (const ev of dayEvs) {
          const startHour = new Date(ev.start_time).getHours()
          const isImportantTask = ev.color === '#6366F1' ||
            /study|exam|project|work meeting|לימוד|מבחן|פרויקט/i.test(ev.title)
          if (isImportantTask && (startHour < peakStart || startHour >= peakEnd)) {
            issues.push(`OFF_PEAK: "${ev.title}" on ${day} starts at ${format(new Date(ev.start_time), 'HH:mm')} — outside your peak productivity (${peak}: ${peakStart}:00–${peakEnd}:00)`)
          }
        }
      }

      // 7. Overloaded day next to an empty day
      const sortedDays = dayStats.sort((a, b) => a.date.localeCompare(b.date))
      for (let i = 0; i < sortedDays.length - 1; i++) {
        const curr = sortedDays[i]
        const next = sortedDays[i + 1]
        const diff = (new Date(next.date).getTime() - new Date(curr.date).getTime()) / 86400000
        if (diff === 1 && curr.totalHours > 5 && next.totalHours < 1) {
          issues.push(`IMBALANCE: ${curr.date} (${curr.dayOfWeek}) is packed (${curr.totalHours}h) but ${next.date} (${next.dayOfWeek}) is nearly empty — could redistribute`)
        }
      }

      return {
        from: from_date,
        to: to_date,
        total_events: rangeEvents.length,
        days: dayStats,
        issues,
        mobility_summary: (() => {
          const fixedCount = rangeEvents.filter(e => (e.mobility_type ?? 'ask_first') === 'fixed').length
          const flexibleCount = rangeEvents.filter(e => e.mobility_type === 'flexible').length
          const askFirstCount = rangeEvents.length - fixedCount - flexibleCount
          return {
            fixed: fixedCount,
            flexible: flexibleCount,
            ask_first: askFirstCount,
            note: flexibleCount === 0
              ? 'ALL events are fixed or ask_first — nothing can be moved freely'
              : `${flexibleCount} events can be moved freely`,
          }
        })(),
        summary: issues.length === 0
          ? 'Schedule looks well-balanced — no major issues detected'
          : `Found ${issues.length} potential issue(s) to address`,
      }
    }

    case 'save_memory': {
      const { entries } = input as { entries: Array<{ key: string; value: string }> }
      if (!Array.isArray(entries) || entries.length === 0) {
        return { error: 'invalid_entries', message: 'entries must be a non-empty array' }
      }
      // Guard against runaway/oversized writes bloating memory.json
      for (const entry of entries) {
        if (!entry || typeof entry.key !== 'string' || typeof entry.value !== 'string') {
          return { error: 'invalid_entry', message: 'each entry needs string key and value' }
        }
        if (entry.key.length === 0 || entry.key.length > MEM_KEY_MAX) {
          return { error: 'key_length', message: `key must be 1–${MEM_KEY_MAX} chars` }
        }
        if (entry.value.length > MEM_VALUE_MAX) {
          return { error: 'value_too_large', message: `value must be ≤ ${MEM_VALUE_MAX} chars` }
        }
      }
      const memHelper = (existing: AIMemory[]) => {
        for (const entry of entries) {
          const idx = existing.findIndex(m => m.key === entry.key)
          const item: AIMemory = {
            id: idx >= 0 ? existing[idx].id : crypto.randomUUID(),
            user_id: userId,
            key: entry.key,
            value: entry.value,
            learned_from: 'behavior',   // save_memory is only used in normal chat (onboarding uses complete_onboarding)
            created_at: idx >= 0 ? existing[idx].created_at : new Date().toISOString(),
          }
          if (idx >= 0) existing[idx] = item
          else existing.push(item)
        }
        return existing
      }
      const memFile = memoryFile(userId)
      const updated = memHelper(readJsonFile<AIMemory[]>(memFile, []))
      writeJsonFileAtomic(memFile, updated)
      state.memoryUpdated = true
      return { success: true, saved: entries.length }
    }

    case 'delete_memory': {
      const { keys } = input as { keys: string[] }
      const memFile = memoryFile(userId)
      const filtered = readJsonFile<AIMemory[]>(memFile, []).filter(m => !keys.includes(m.key))
      writeJsonFileAtomic(memFile, filtered)
      return { success: true, deleted: keys.length }
    }

    case 'create_task': {
      const task: Task = {
        id: crypto.randomUUID(),
        user_id: userId,
        title: str(input.title),
        description: input.description ? str(input.description) : undefined,
        deadline: input.deadline ? str(input.deadline) : undefined,
        estimated_hours: input.estimated_hours ? num(input.estimated_hours) : undefined,
        priority: (['low', 'medium', 'high'].includes(str(input.priority)) ? str(input.priority) : 'medium') as Task['priority'],
        status: 'pending',
        topic: input.topic ? str(input.topic) : undefined,
        parent_task_id: input.parent_task_id ? str(input.parent_task_id) : undefined,
        created_at: new Date().toISOString(),
      }
      userStore.addTask(task, userId)
      state.tasksUpdated = true
      return { success: true, task }
    }

    case 'update_task': {
      const taskId = str(input.task_id)
      const updates: Partial<Task> = {}
      if (input.title) updates.title = str(input.title)
      if (input.status) updates.status = str(input.status) as Task['status']
      if (input.priority) updates.priority = str(input.priority) as Task['priority']
      if (input.topic) updates.topic = str(input.topic)
      if (input.deadline) updates.deadline = str(input.deadline)
      if (input.estimated_hours) updates.estimated_hours = num(input.estimated_hours)

      userStore.updateTask(taskId, updates, userId)
      state.tasksUpdated = true
      return { success: true }
    }

    case 'delete_task': {
      const taskId = str(input.task_id)
      userStore.deleteTask(taskId, userId)
      state.tasksUpdated = true
      return { success: true }
    }

    case 'list_tasks': {
      const { status, topic } = input as { status?: string; topic?: string }
      let tasks = userStore.getTasks(userId)
      if (status) tasks = tasks.filter(t => t.status === status)
      if (topic) tasks = tasks.filter(t => t.topic === topic)
      return { tasks }
    }

    case 'complete_onboarding': {
      const { profile_updates, memory_entries } = input as {
        profile_updates?: Partial<UserProfile>
        memory_entries?: Array<{ key: string; value: string }>
      }

      // Compute scheduling methods from persona+challenge+day_structure if provided
      const pu = profile_updates ?? {}
      if (pu.persona && pu.challenge && pu.day_structure) {
        const methodResult = mapToMethod(pu.persona, pu.challenge, pu.day_structure)
        pu.scheduling_method = methodResult.primary
        pu.secondary_methods = methodResult.secondary
        // Append method info to memory_entries so it survives cross-device
        const extraEntries: Array<{ key: string; value: string }> = [
          { key: 'persona_type', value: pu.persona },
          { key: 'main_challenge', value: pu.challenge },
          { key: 'day_structure', value: pu.day_structure },
          { key: 'scheduling_method', value: methodResult.primary },
          { key: 'secondary_methods', value: methodResult.secondary.join(', ') },
        ];
        if (memory_entries) {
          memory_entries.push(...extraEntries)
        } else {
          (input as Record<string, unknown>).memory_entries = extraEntries
        }
      } else if (!pu.scheduling_method) {
        // Fallback: never finish onboarding without a method, or MethodOnboardingModal
        // re-triggers forever. Default to time_blocking (general-purpose).
        pu.scheduling_method = 'time_blocking'
        pu.secondary_methods = pu.secondary_methods ?? []
        const fallbackEntry = { key: 'scheduling_method', value: 'time_blocking' }
        if (memory_entries) memory_entries.push(fallbackEntry)
        else (input as Record<string, unknown>).memory_entries = [fallbackEntry]
      }

      const safeId = assertSafeUserId(userId)
      // Save memory entries
      if (memory_entries?.length) {
        const memFile = path.join(DATA_DIR, 'users',safeId, 'memory.json')
        const existing = readJsonFile<AIMemory[]>(memFile, [])
        for (const entry of memory_entries) {
          const idx = existing.findIndex(m => m.key === entry.key)
          const item: AIMemory = {
            id: idx >= 0 ? existing[idx].id : crypto.randomUUID(),
            user_id: userId, key: entry.key, value: entry.value,
            learned_from: 'onboarding',
            created_at: idx >= 0 ? existing[idx].created_at : new Date().toISOString(),
          }
          if (idx >= 0) existing[idx] = item
          else existing.push(item)
        }
        writeJsonFileAtomic(memFile, existing)
      }
      // Update profile
      const profFile = path.join(DATA_DIR, 'users',safeId, 'profile.json')
      const existing = readJsonFile<UserProfile>(profFile,
        { user_id: userId, autonomy_mode: 'hybrid', theme: 'dark', voice_response_enabled: false, language: 'en', onboarding_completed: false, productivity_peak: 'morning' })
      const updated: UserProfile = { ...existing, ...(profile_updates ?? {}), onboarding_completed: true, user_id: userId }
      writeJsonFileAtomic(profFile, updated)
      state.completedProfile = updated

      if (memory_entries?.length) state.memoryUpdated = true
      return { success: true }
    }

    case 'send_notification': {
      const { title, body } = input as { title: string; body: string }
      const payload = { title, body, url: '/app', tag: 'zman-message' }

      // Same channel order as the cron job (see api/cron/notifications). ntfy
      // leads because it is the only one that reaches a phone on this deployment.
      const topic = profile?.ntfy_topic || defaultTopicFor(userId)
      if (topic && isNtfyConfigured()) {
        // Unlike the two below, this one reports whether it landed — so the model
        // is told the truth instead of being handed success unconditionally.
        const delivered = await sendNtfy(topic, payload)
        return delivered
          ? { success: true, channel: 'ntfy' }
          : { success: false, reason: 'delivery_failed', message: 'The notification service rejected the message. Tell the user it did not go through.' }
      }

      if (fcmToken) {
        await sendFcmPush(fcmToken, payload)
        return { success: true, channel: 'fcm' }
      }
      if (pushSubscription) {
        await sendPush(pushSubscription, payload)
        return { success: true, channel: 'web-push' }
      }

      return { success: false, reason: 'no_delivery_channel', message: 'No notification channel is configured for this user, so nothing was sent. Say so plainly — do not claim a reminder was set.' }
    }

    case 'delete_all_events': {
      const allIds = currentEvents.map(e => e.id)
      for (const id of allIds) userStore.deleteEvent(id, userId)
      deletedEventIds.push(...allIds)
      return { success: true, deleted_count: allIds.length }
    }

    // ── Projects ────────────────────────────────────────────────────────────
    //
    // Decisions live in lib/ai/projectTools.ts and lib/projects/*; these arms are
    // storage glue only, the same split the engine tools already follow.

    case 'create_project': {
      const title = str(input.title).trim()
      if (!title) return { error: 'missing_required_fields', message: 'title is required' }
      const kind = (['course', 'deliverable', 'build'].includes(str(input.kind))
        ? str(input.kind) : 'build') as Project['kind']

      const project: Project = {
        id: crypto.randomUUID(),
        user_id: userId,
        title,
        kind,
        status: 'active',
        description: str(input.description) || undefined,
        deadline: str(input.deadline) || undefined,
        color: str(input.color) || undefined,
        topic: title,
        created_at: new Date().toISOString(),
      }
      userStore.addProject(project, userId)

      // `key` is caller-local: resolve it to real ids here so the model never has
      // to make N round trips just to express "step 3 needs step 2".
      const raw = Array.isArray(input.tasks) ? input.tasks as Record<string, unknown>[] : []
      const idByKey = new Map<string, string>()
      const created: Task[] = []
      for (const t of raw) {
        const tTitle = str(t.title).trim()
        if (!tTitle) continue
        const id = crypto.randomUUID()
        if (str(t.key)) idByKey.set(str(t.key), id)
        created.push({
          id,
          user_id: userId,
          title: tTitle,
          priority: (['low', 'medium', 'high'].includes(str(t.priority)) ? str(t.priority) : 'medium') as Task['priority'],
          status: 'pending',
          estimated_hours: typeof t.estimated_hours === 'number' && t.estimated_hours > 0 ? t.estimated_hours : undefined,
          deadline: str(t.deadline) || project.deadline,
          topic: project.topic,
          project_id: project.id,
          created_at: new Date().toISOString(),
        })
      }
      // Second pass, so a step may depend on one declared after it.
      created.forEach((task, i) => {
        const deps = Array.isArray(raw[i]?.depends_on) ? raw[i].depends_on as string[] : []
        const resolved = deps.map(k => idByKey.get(k)).filter((v): v is string => !!v)
        if (resolved.length) task.depends_on = resolved
        userStore.addTask(task, userId)
      })

      state.projectsUpdated = true
      if (created.length) state.tasksUpdated = true
      return {
        success: true,
        project: { id: project.id, title: project.title, kind: project.kind, deadline: project.deadline },
        tasks_created: created.length,
        tasks: created.map(t => ({ id: t.id, title: t.title, estimated_hours: t.estimated_hours })),
        next_step: sched?.isHe
          ? 'אם למשימות אין הערכת שעות — שאל את המשתמש, כי בלי זה אי אפשר לחשב סיכון עמידה ביעד.'
          : 'If tasks have no estimated_hours, ask the user — deadline risk cannot be computed without them.',
      }
    }

    case 'list_projects': {
      const wanted = str(input.status)
      const all = userStore.getProjects(userId)
      const filtered = wanted ? all.filter(p => p.status === wanted) : all.filter(p => p.status === 'active')
      const allTasks = userStore.getTasks(userId)
      const nowLocal = resolveNow(now, sched?.timezone || profile?.timezone)

      // Health is computed here rather than left to the model: the risk number is
      // the engine's answer, and the model's job is to paraphrase it.
      const probeInputs = []
      const factsById = new Map<string, ReturnType<typeof computeFacts>>()
      for (const p of filtered) {
        const f = computeFacts(p, allTasks, currentEvents, nowLocal)
        factsById.set(p.id, f)
        const pi = probeInputFor(p, f)
        if (pi) probeInputs.push(pi)
      }

      let probe = new Map<string, ProjectProbeResult>()
      if (probeInputs.length) {
        try {
          const horizon = probeInputs.reduce((m, i) => Math.max(m, horizonDaysFor(nowLocal, i.deadline)), 14)
          const ctx = buildSchedulingContext(
            profile, currentEvents, sched?.memory, sched?.feedback, sched?.timezone, now, horizon,
          )
          probe = probeCapacity(ctx, probeInputs, !!sched?.isHe)
        } catch (err) {
          console.error('[chat] project capacity probe failed:', err)
        }
      }

      const method = resolveMethod(profile).primary
      return {
        projects: filtered.map(p => ({
          id: p.id,
          title: p.title,
          kind: p.kind,
          status: p.status,
          deadline: p.deadline,
          tasks_open: factsById.get(p.id)?.openLeafTasks.length ?? 0,
          tasks_total: factsById.get(p.id)?.totalLeafCount ?? 0,
          signals: resolveSignals(p, allTasks, currentEvents, probe.get(p.id), method, nowLocal)
            .map(s => ({ signal: s.signal, state: s.state, text: sched?.isHe ? s.text.he : s.text.en, code: s.code })),
        })),
        next_step: sched?.isHe
          ? 'הסתמך על signals כפי שהם. אל תחשב בעצמך אם משהו נכנס בזמן — זו התשובה של מנוע התזמון.'
          : 'Use `signals` as given. Do not work out for yourself whether something fits — that is the engine\'s answer.',
      }
    }

    case 'update_project': {
      const id = str(input.project_id)
      if (!id) return { error: 'missing_required_fields', message: 'project_id is required' }
      const updates: Partial<Project> = {}
      if (str(input.title)) updates.title = str(input.title)
      if (str(input.description)) updates.description = str(input.description)
      if (str(input.color)) updates.color = str(input.color)
      if (str(input.deadline)) updates.deadline = str(input.deadline)
      if (['active', 'paused', 'done', 'archived'].includes(str(input.status))) {
        updates.status = str(input.status) as Project['status']
        if (updates.status === 'done') updates.completed_at = new Date().toISOString()
        if (updates.status === 'archived') updates.archived_at = new Date().toISOString()
      }
      const updated = userStore.updateProject(id, updates, userId)
      if (!updated) return { error: 'not_found', message: `No project with id ${id}` }
      state.projectsUpdated = true
      return { success: true, project: { id: updated.id, title: updated.title, status: updated.status } }
    }

    case 'delete_project': {
      const id = str(input.project_id)
      if (!id) return { error: 'missing_required_fields', message: 'project_id is required' }
      const project = userStore.getProjects(userId).find(p => p.id === id)
      if (!project) return { error: 'not_found', message: `No project with id ${id}` }

      const mode = bool(input.delete_tasks) ? 'cascade' : 'detach'
      const plan = planProjectDeletion(project, userStore.getTasks(userId), currentEvents, mode)
      for (const taskId of plan.deleteTaskIds) userStore.deleteTask(taskId, userId)
      for (const taskId of plan.detachTaskIds) userStore.updateTask(taskId, { project_id: undefined }, userId)
      userStore.deleteProject(id, userId)

      state.projectsUpdated = true
      state.tasksUpdated = true
      return {
        success: true,
        deleted_tasks: plan.deleteTaskIds.length,
        detached_tasks: plan.detachTaskIds.length,
        calendar_blocks_kept: plan.untouchedEvents,
        message: plan.untouchedEvents > 0
          ? `${plan.untouchedEvents} calendar block(s) were left in place — deleting a project never clears the calendar. Tell the user, and offer to remove them separately if that is what they wanted.`
          : undefined,
      }
    }

    case 'plan_project': {
      // Needs BOTH flags: the proposal it returns can only be committed by
      // apply_plan, which is V2-only.
      if (!sched?.enabled) {
        return { error: 'unknown_tool', message: 'Unknown tool: plan_project' }
      }
      const id = str(input.project_id)
      if (!id) return { error: 'missing_required_fields', message: 'project_id is required' }
      const project = userStore.getProjects(userId).find(p => p.id === id)
      if (!project) return { error: 'not_found', message: `No project with id ${id}` }

      const onlyIds = Array.isArray(input.only_task_ids)
        ? (input.only_task_ids as unknown[]).filter((v): v is string => typeof v === 'string')
        : undefined

      const build = buildProjectPlanSpec(project, userStore.getTasks(userId), profile, sched, onlyIds)

      if (build.cycle) {
        return {
          error: 'circular_dependency',
          message: sched.isHe
            ? `יש תלות מעגלית בין "${build.cycle.a}" ל-"${build.cycle.b}" — תקן אותה ואז נתכנן.`
            : `"${build.cycle.a}" and "${build.cycle.b}" depend on each other — fix that first, then we can plan.`,
        }
      }
      if (!build.spec) {
        return { error: 'nothing_to_plan', message: build.error, skipped: build.skipped }
      }

      const result = proposePlan(userId, [...currentEvents, ...createdEvents], profile, sched, now, build.spec)
      return {
        ...result.toolResult,
        ...(build.skipped.length ? { skipped: build.skipped } : {}),
      }
    }

    default:
      return { error: `Unknown tool: ${toolName}` }
  }
}

// ─── SCHEDULER_V2 storage glue ────────────────────────────────────────────────
//
// The decisions live in lib/ai/schedulerTools.ts, which is pure and tested. What
// stays here is the part that touches storage: writing events, updating one, and
// recording the learning signal. Only reachable from a `sched?.enabled` branch.

/** One write path for engine-created events. */
async function persistEvent(event: CalendarEvent, userId: string): Promise<void> {
  userStore.addEvent(event, userId)
}

/** Applies the slot `planMove` chose, and records that the AI's original time was wrong. */
async function applyEngineMove(
  eventId: string,
  userId: string,
  currentEvents: CalendarEvent[],
  createdEvents: CalendarEvent[],
  updatedEvents: CalendarEvent[],
  profile: UserProfile | null,
  sched: SchedulerCtx,
  now: Date,
): Promise<unknown> {
  // Events created earlier in this same turn are part of the world too, or two
  // tool calls in one turn will book the same hour.
  const known = [...currentEvents, ...createdEvents]
  const decision = planMove(eventId, known, profile, sched, now)
  if (!decision.ok) return decision.toolResult

  const existing = known.find(e => e.id === eventId)!

  userStore.updateEvent(eventId, { start_time: decision.start, end_time: decision.end }, userId)

  if (existing.created_by === 'ai') {
    try {
      const oldStart = new Date(existing.start_time)
      recordFeedback(userId, {
        type: 'moved', title: existing.title,
        fromHour: oldStart.getHours(), toHour: Number(decision.start.slice(11, 13)),
        day: format(oldStart, 'EEE'), at: new Date().toISOString(),
      })
    } catch { /* a lost learning signal must not fail the move */ }
  }

  const updated = { ...existing, start_time: decision.start, end_time: decision.end }
  updatedEvents.push(updated)
  return { success: true, event: updated, moved_to: decision.view.blocks[0], why: decision.why }
}

/** Writes the instances `planRecurring` cleared, and reports every one it didn't. */
async function applyRecurringPlan(
  input: Record<string, unknown>,
  userId: string,
  currentEvents: CalendarEvent[],
  createdEvents: CalendarEvent[],
  profile: UserProfile | null,
  sched: SchedulerCtx,
  recurrence: { frequency?: string; count?: number; end_date?: string },
): Promise<unknown> {
  const known = [...currentEvents, ...createdEvents]
  const plan = planRecurring(input, known, profile, sched, recurrence)
  if (plan.error) return plan.error

  const seriesId = crypto.randomUUID()
  const writeErrors: string[] = []
  let created = 0

  for (const slot of plan.instances) {
    const instance: CalendarEvent = {
      id: crypto.randomUUID(),
      user_id: userId,
      title: String(input.title ?? ''),
      start_time: slot.start,
      end_time: slot.end,
      description: String(input.description ?? ''),
      color: String(input.color ?? '') || '#3B7EF7',
      source: 'zman',
      created_by: 'ai',
      status: 'confirmed',
      is_all_day: false,
      created_at: new Date().toISOString(),
      series_id: seriesId,
      recurrence_rule: recurrence.frequency,
      mobility_type: slot.mobility,
    }
    try {
      await persistEvent(instance, userId)
    } catch (err) {
      writeErrors.push(`${slot.start}: ${(err as Error)?.message}`)
      continue
    }
    createdEvents.push(instance)
    created++
  }

  return recurringToolResult(seriesId, created, plan, writeErrors)
}

// ─── Free slot calculator ─────────────────────────────────────────────────────

type FreeSlot = { start: string; end: string; duration_minutes: number; is_peak?: boolean }

/**
 * Pick `n` slots for a multi-session task, SPREAD across days instead of clustered.
 * - One session per day first; prefer the peak slot within each day.
 * - When there are more days than sessions, stride across them so sessions land on
 *   non-consecutive days (rest gaps), e.g. 3 sessions over 2 weeks → Mon/Wed/Fri-ish.
 * - Only stacks 2+ sessions on the same day when there aren't enough distinct days.
 * Always returns the chosen slots in chronological order.
 */
function pickSpreadSlots(slots: FreeSlot[], n: number): FreeSlot[] {
  if (n <= 0 || slots.length === 0) return []
  const byDay = new Map<string, FreeSlot[]>()
  for (const s of slots) {
    const day = s.start.slice(0, 10)
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day)!.push(s)
  }
  // Within a day: best slot first (peak before non-peak, then earliest).
  for (const arr of byDay.values()) {
    arr.sort((a, b) => (Number(b.is_peak) - Number(a.is_peak)) || (a.start < b.start ? -1 : 1))
  }
  const days = [...byDay.keys()].sort()
  const chosen: FreeSlot[] = []

  if (n <= days.length) {
    // Enough distinct days → one per day, strided for rest gaps.
    const stride = Math.max(1, Math.floor(days.length / n))
    const picked = new Set<number>()
    for (let i = 0, d = 0; i < n && d < days.length; i++, d += stride) picked.add(d)
    for (let d = 0; picked.size < n && d < days.length; d++) picked.add(d) // fill if rounding left gaps
    for (const d of [...picked].sort((a, b) => a - b).slice(0, n)) chosen.push(byDay.get(days[d])![0])
  } else {
    // More sessions than days → one per day, then a 2nd/3rd pass on earliest days.
    let r = 0
    while (chosen.length < n) {
      let added = false
      for (const day of days) {
        const slot = byDay.get(day)![r]
        if (slot) { chosen.push(slot); added = true; if (chosen.length >= n) break }
      }
      if (!added) break
      r++
    }
  }
  return chosen.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
}

function getFreeSlots(
  events: CalendarEvent[],
  fromDate: string,
  toDate: string,
  minMinutes: number,
  profile?: UserProfile | null,
  preferPeak = false,
  now: Date = new Date(),  // user-local now, so "today" / past-slot floor match the user's timezone
  limit = 20               // max candidate slots to return (break_down_task asks for more, to spread)
) {
  const slots: FreeSlot[] = []
  let cursor = parseISO(fromDate)
  const to = parseISO(toDate)

  // Determine day bounds from profile
  // wake/sleep only — see the note on UserProfile.preferred_hours.
  const dayStartHour = parseHour(profile?.wake_time, 9)
  const dayEndHour = parseHour(profile?.sleep_time, 22)

  // Peak productivity window
  const peak = profile?.productivity_peak ?? 'morning'
  const peakStart = peak === 'morning' ? 6 : peak === 'afternoon' ? 12 : 18
  const peakEnd   = peak === 'morning' ? 12 : peak === 'afternoon' ? 18 : 23

  cursor.setHours(dayStartHour, 0, 0, 0)

  while (cursor < to) {
    const dayEnd = new Date(cursor)
    dayEnd.setHours(dayEndHour, 0, 0, 0)

    const dayEvents = events
      .filter(e => {
        const s = new Date(e.start_time)
        return s >= startOfDay(cursor) && s <= endOfDay(cursor)
      })
      .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())

    // On the current day, never start a slot in the past — use now as the floor
    const nowTs = now
    let slotStart = (cursor.toDateString() === nowTs.toDateString() && nowTs > cursor)
      ? new Date(nowTs)
      : new Date(cursor)
    for (const ev of dayEvents) {
      const evStart = new Date(ev.start_time)
      const evEnd = new Date(ev.end_time)
      if (evStart > slotStart) {
        const dMin = (evStart.getTime() - slotStart.getTime()) / 60000
        if (dMin >= minMinutes) {
          const h = slotStart.getHours()
          slots.push({
            start: format(slotStart, "yyyy-MM-dd'T'HH:mm:ss"),
            end: format(evStart, "yyyy-MM-dd'T'HH:mm:ss"),
            duration_minutes: Math.floor(dMin),
            is_peak: h >= peakStart && h < peakEnd,
          })
        }
      }
      if (evEnd > slotStart) slotStart = evEnd
    }

    if (slotStart < dayEnd) {
      const dMin = (dayEnd.getTime() - slotStart.getTime()) / 60000
      if (dMin >= minMinutes) {
        const h = slotStart.getHours()
        slots.push({
          start: format(slotStart, "yyyy-MM-dd'T'HH:mm:ss"),
          end: format(dayEnd, "yyyy-MM-dd'T'HH:mm:ss"),
          duration_minutes: Math.floor(dMin),
          is_peak: h >= peakStart && h < peakEnd,
        })
      }
    }

    cursor = addHours(startOfDay(cursor), 24)
    cursor.setHours(dayStartHour, 0, 0, 0)
  }

  const result = slots.slice(0, limit)

  // If preferPeak, surface peak slots first — but keep each group in chronological
  // order so callers that take the first N don't get times out of sequence.
  if (preferPeak) {
    return [
      ...result.filter(s => s.is_peak),
      ...result.filter(s => !s.is_peak),
    ]
  }

  return result
}
