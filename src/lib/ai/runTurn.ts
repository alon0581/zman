/**
 * runTurn.ts — one assistant turn, with no transport attached.
 *
 * Everything from "here is a user message" to "here is the finished reply and
 * everything that changed" used to live inside the POST handler of
 * `src/app/api/chat/route.ts`, tangled up with the SSE stream that reports it.
 * It is lifted out here unchanged so a second, non-browser caller (the iPhone
 * Shortcut endpoint) can run exactly the same turn without pretending to be an
 * EventSource.
 *
 * The extraction is possible at all because of one structural fact: the
 * tool-call loop already ran to completion BEFORE the old handler constructed
 * its `ReadableStream`. By the time the first SSE byte was written, the reply
 * text was a finished string and every flag was final — the word-by-word
 * emission is cosmetic re-chunking of an answer that already existed. So this
 * function is not a new pipeline, it is the same code with the stream peeled off.
 *
 * What deliberately stayed in the route: the cookie check (transport), the
 * missing-key error stream and the outer catch (both SSE-shaped), and the frame
 * writing itself. What deliberately came along: the profile/memory/feedback
 * loads, the prompt assembly, the provider loop, the follow-up retry, and the
 * backstop text — a second caller needs all of them to behave identically.
 */

import OpenAI from 'openai'
import { getCalendarTools, getOnboardingTools } from '@/lib/ai/tools'
import { buildSystemPrompt } from '@/lib/ai/systemPrompt'
import { buildOnboardingSystemPrompt } from '@/lib/ai/onboardingPrompt'
import { phasesEnabled, placesEnabled, projectsEnabled, schedulerV2Enabled } from '@/lib/ai/featureFlags'
import { followupPrompt, needsFollowup } from '@/lib/ai/followup'
import { SchedulerCtx } from '@/lib/ai/schedulerTools'
import { executeTool, memoryFile } from '@/lib/ai/executeTool'
import { CalendarEvent, UserProfile, AIMemory, Task, FeedbackSignal } from '@/types'
import { userStore } from '@/lib/store/userStore'
import { assertSafeUserId } from '@/lib/util/safeUserId'
import { readJsonFile } from '@/lib/util/jsonStore'
import { DATA_DIR } from '@/lib/util/dataDir'
import { readFeedback } from '@/lib/feedback/store'
import path from 'path'

// Wall-clock ceiling on the tool-call loop. Sonnet does several tool round-trips
// per scheduling request (each a few seconds), so 25s cut real work off mid-flow.
// 90s gives genuine multi-tool scheduling room to finish; env-overridable.
// This is now the DEFAULT for `RunTurnInput.maxLoopMs`, not the only value: a
// caller whose client will not wait 90s (a phone Shortcut holding one HTTP
// request open) passes its own ceiling instead of racing this one.
export const MAX_LOOP_MS = Number(process.env.MAX_LOOP_MS) || 90000

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

/**
 * Appended to the DYNAMIC suffix when PHASES is on. Same cache rule as the two
 * above: anything that varies by flag must stay out of the cached static prefix.
 *
 * This explains the CONCEPT. The routing — when to reach for start_phase, and why
 * end_series rather than delete_event — lives in the tool descriptions, because
 * prose here lost to a more specific description once already in this repo.
 */
const PHASES_GUIDANCE = `
LIFE PHASES:
- A phase is a NAMED PERIOD of the user's life, not a category: "סמסטר ב׳", "צבא", "בין עבודות", "חופשת לידה". The label is theirs, in their words. Never invent a taxonomy.
- When they say their situation changed, call start_phase. It closes the previous phase atomically — there is no separate close tool.
- Ask AT MOST THREE questions (hours, what matters, what recurs weekly). A phase with one field filled beats a phase not opened. Record the answers with update_profile (hours) and save_memory (everything else).
- Call list_phases FIRST so you can reuse an existing slug. Same slug = same kind of period returning = their old settings and facts come back automatically. A near-duplicate slug silently breaks that.
- On a RETURN, the interview is ONE question: "מה השתנה הפעם?" Do not re-ask what was restored.
- Facts from closed phases appear under [Earlier phases]. They are NOT true now. Say "בתקופה הקודמת..." — never assert them as current.
- Goals from a previous phase (current_goal, ongoing_task) are deliberately NOT restored. Do not greet the user with an old goal.
- Reopening a phase NEVER recreates its calendar events. A timetable changes between semesters. Offer to rebuild and ask for the new one.
`.trim()

/**
 * Appended to the DYNAMIC suffix when PLACES is on. Same cache rule as the three
 * above. The routing itself (when to attach place_id, when to reuse an id instead
 * of minting one) lives in the tool descriptions — see tools.ts — for the same
 * reason PHASES_GUIDANCE gives for delete_event/end_series: prose here already
 * lost to a more specific tool description once in this repo.
 */
const PLACES_GUIDANCE = `
PLACES:
- A place is somewhere the user physically goes — home, work, campus, the gym — carrying how long it takes to get ready and how long the trip is from other places. Every number is DECLARED by the user; never invent prep or travel minutes.
- Call list_places before save_place so you reuse an existing place_id instead of minting a near-duplicate ("הבית" vs "בית").
- On an update, save_place's travel_from MERGES with pairs already declared — it never erases one the user stated earlier.
- At most one place is home. Marking a new one un-marks the previous one automatically.
`.trim()

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── The turn ────────────────────────────────────────────────────────────────

/**
 * Everything a turn needs that does not come from the transport.
 *
 * `profile` is the CLIENT-sent profile and stays separate from the server's copy
 * on purpose: the server's wins for reasoning (`effectiveProfile`), but the
 * language used for the provider-error text and the backstop line has always
 * been read off the client's, and changing that would change wording.
 */
export interface RunTurnInput {
  userId: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  events: CalendarEvent[]
  profile: UserProfile | null
  isOnboarding?: boolean
  memory?: Array<{ key: string; value: string }>
  tasks?: Task[]
  timezone?: string
  /** Resolved by the caller so a missing key can be reported in the caller's own shape. */
  apiKey: string
  /**
   * Wall-clock ceiling on the tool-call loop. Defaults to the same 90s the chat
   * route has always used; a caller on a tighter budget (a phone Shortcut waiting
   * on one HTTP response) passes a lower one.
   */
  maxLoopMs?: number
}

/** Everything the SSE stream reports, with nothing about SSE in it. */
export interface TurnResult {
  /** The finished reply. Empty when the model produced no text at all. */
  text: string
  /**
   * What to say when `text` is empty — precomputed here rather than in the
   * stream so every caller gets the same backstop wording.
   */
  fallbackText: string
  createdEvents: CalendarEvent[]
  updatedEvents: CalendarEvent[]
  deletedEventIds: string[]
  memoryUpdated: boolean
  tasksUpdated: boolean
  projectsUpdated: boolean
  completedProfile: UserProfile | null
}

export async function runTurn(input: RunTurnInput): Promise<TurnResult> {
  const {
    userId, messages, events, profile, isOnboarding, memory, tasks, timezone,
    apiKey, maxLoopMs = MAX_LOOP_MS,
  } = input

  // Always load from server-side profile (never trust the client-sent profile for secrets)
  const freshProfile: UserProfile | null = loadFreshProfile(userId)
  const model = process.env.AI_MODEL || DEFAULT_ANTHROPIC_MODEL

  // One model, pinned for the whole conversation — see DEFAULT_ANTHROPIC_MODEL.
  const v2 = schedulerV2Enabled()
  const projects = projectsEnabled()
  const phases = phasesEnabled()
  const places = placesEnabled()
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

  // Phase context for the PERSON PROFILE block. Absent when the flag is off,
  // and `buildSystemPrompt` then returns the legacy block byte for byte — the
  // parameter's presence IS the switch, so a flag-off turn cannot drift.
  const phaseCtx = phases
    ? (() => {
        const all = userStore.getPhases(userId)
        const active = all.find(p => p.status === 'active') ?? null
        return {
          active: active
            ? { id: active.id, label: active.label, started_at: active.started_at }
            : null,
          closedLabelById: Object.fromEntries(
            all.filter(p => p.status === 'closed').map(p => [p.id, p.label]),
          ),
        }
      })()
    : undefined

  // Split system prompt: stable `staticPrefix` (cacheable) + per-request `dynamicSuffix`.
  const rawSys = isOnboarding
    ? { staticPrefix: buildOnboardingSystemPrompt(effectiveProfile?.language ?? 'en', userNow), dynamicSuffix: '' }
    : buildSystemPrompt(effectiveProfile, events, userNow, effectiveMemory, tasks, feedback, phaseCtx)
  // Under the flag the v1 prompt still tells the model to call get_free_slots and
  // do the arithmetic itself — a tool that no longer exists. The correction goes
  // in the DYNAMIC suffix, never the static prefix, so the cached prefix is
  // byte-identical whether the flag is on or off.
  const guidance = [
    v2 ? SCHEDULER_V2_GUIDANCE : '',
    projects ? PROJECTS_GUIDANCE : '',
    phases ? PHASES_GUIDANCE : '',
    places ? PLACES_GUIDANCE : '',
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
    // Derived from the same read `phaseCtx` already did, so a closed phase's
    // feedback stops steering the plan the moment its facts stop being injected.
    closedPhaseIds: phaseCtx ? Object.keys(phaseCtx.closedLabelById ?? {}) : undefined,
    // Undefined when PLACES is off, and then no block carries a travel window
    // and every engine path behaves exactly as it did before places existed.
    places: places ? userStore.getPlaces(userId) : undefined,
  }
  const activeTools = isOnboarding
    ? getOnboardingTools(v2, projects, phases, places)
    : getCalendarTools(v2, projects, phases, places)

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
        if (Date.now() - loopStart > maxLoopMs) {
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

  // Last-resort backstop: never end a turn silently. If actions happened,
  // confirm them; otherwise send a soft ack so the UI isn't left blank.
  //
  // Computed unconditionally (the stream used to build it only inside its `else`)
  // because it is pure string assembly with no side effect, and a caller that is
  // not a stream still needs something to say. `profile` here is the CLIENT's
  // copy, not `effectiveProfile` — same as `schedCtx.isHe` above, and changing it
  // would change the wording of a shipped message.
  const isHe = (profile?.language ?? 'he') === 'he'
  const parts: string[] = []
  if (createdEvents.length) parts.push(isHe ? `נוספו ${createdEvents.length} אירועים` : `added ${createdEvents.length} event(s)`)
  if (updatedEvents.length) parts.push(isHe ? `עודכנו ${updatedEvents.length}` : `updated ${updatedEvents.length}`)
  if (deletedEventIds.length) parts.push(isHe ? `נמחקו ${deletedEventIds.length}` : `deleted ${deletedEventIds.length}`)
  const msg = parts.length
    ? `✓ ${parts.join(isHe ? ', ' : ', ')}`
    : (isHe ? '✓ בוצע' : '✓ Done')

  return {
    text: lastContent,
    fallbackText: msg,
    createdEvents,
    updatedEvents,
    deletedEventIds,
    memoryUpdated: state.memoryUpdated,
    tasksUpdated: state.tasksUpdated,
    projectsUpdated: state.projectsUpdated,
    completedProfile,
  }
}
