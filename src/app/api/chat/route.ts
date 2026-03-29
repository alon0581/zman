import { NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import OpenAI from 'openai'
import { calendarTools, onboardingTools } from '@/lib/ai/tools'
import { buildSystemPrompt } from '@/lib/ai/systemPrompt'
import { buildOnboardingSystemPrompt } from '@/lib/ai/onboardingPrompt'
import { CalendarEvent, UserProfile, AIMemory, Task } from '@/types'
import { addDays, addHours, addMinutes, format, parseISO, startOfDay, endOfDay } from 'date-fns'
import { demoStorage } from '@/lib/demo/storage'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'
import { classifyMobility } from '@/lib/scheduling/mobilityClassifier'
import { mapToMethod } from '@/lib/scheduling/methodMapper'
import { decryptApiKey } from '@/lib/encryption'
import { sendPush, sendFcmPush } from '@/lib/push'
import fs from 'fs'
import path from 'path'

const DEMO_MODE = !process.env.NEXT_PUBLIC_SUPABASE_URL?.startsWith('http')

// Shared constants
const BUFFER_MIN = 15  // minutes of breathing room between events

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
  if (!DEMO_MODE) return null  // Supabase handled separately in POST
  try {
    const file = path.join(process.cwd(), 'data', 'users', userId, 'profile.json')
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8')) as UserProfile
  } catch { /* ignore */ }
  return null
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

function parseXmlToolCalls(content: string): { name: string; args: Record<string, unknown> }[] {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const invokeRe = /<invoke name="([^"]+)">([\s\S]*?)<\/invoke>/g
  let m
  while ((m = invokeRe.exec(content)) !== null) {
    const args: Record<string, unknown> = {}
    const paramRe = /<parameter name="([^"]+)">([\s\S]*?)<\/parameter>/g
    let pm
    while ((pm = paramRe.exec(m[2])) !== null) {
      let val: unknown = pm[2].trim()
      try { val = JSON.parse(val as string) } catch { /* keep as string */ }
      args[pm[1]] = val
    }
    calls.push({ name: m[1], args })
  }
  return calls
}

// ─── Main handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder()

  try {
    let userId: string | null = null

    if (DEMO_MODE) {
      const cookieStore = await cookies()
      const token = cookieStore.get(COOKIE_NAME)?.value
      userId = getUserIdFromCookie(token)
    } else {
      const { createClient } = await import('@/lib/supabase/server')
      const supabase = await createClient()
      const { data: { user } } = await supabase.auth.getUser()
      userId = user?.id ?? null
    }

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

    // ── Resolve AI provider + key ───────────────────────────────────────────
    // Always load from server-side profile (never trust the client-sent profile for secrets)
    let freshProfile: UserProfile | null = null
    if (DEMO_MODE) {
      freshProfile = loadFreshProfile(userId)
    } else {
      const { createClient } = await import('@/lib/supabase/server')
      const supabase = await createClient()
      const { data } = await supabase.from('user_profiles').select('*').eq('user_id', userId).single()
      freshProfile = data as UserProfile | null
    }

    let provider = freshProfile?.ai_provider ?? 'openai'
    let model = freshProfile?.ai_model ?? 'gpt-4o-mini'

    let apiKey: string
    if (freshProfile?.ai_api_key_encrypted) {
      apiKey = decryptApiKey(freshProfile.ai_api_key_encrypted)
    } else if (process.env.MINIMAX_API_KEY) {
      // Server-wide MiniMax key — no per-user setup needed
      apiKey = process.env.MINIMAX_API_KEY
      provider = 'minimax'
      model = 'MiniMax-M2.5'
    } else if (process.env.OPENAI_API_KEY) {
      apiKey = process.env.OPENAI_API_KEY
      provider = 'openai'
      model = 'gpt-4o-mini'
    } else {
      return buildErrorStream(
        '⚙️ No API key configured. Go to **Settings → AI Model** to add your API key.'
      )
    }
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

    const systemPrompt = isOnboarding
      ? buildOnboardingSystemPrompt(profile?.language ?? 'en', userNow)
      : buildSystemPrompt(profile, events, userNow, memory as AIMemory[] | undefined, tasks)

    const createdEvents: CalendarEvent[] = []
    const updatedEvents: CalendarEvent[] = []
    const deletedEventIds: string[] = []
    let lastContent = ''
    let completedProfile: UserProfile | null = null
    const state = { completedProfile: null as UserProfile | null, memoryUpdated: false, tasksUpdated: false }

    // ── Tool-call loop ──────────────────────────────────────────────────────

    if (provider === 'anthropic') {
      // Anthropic tool-call loop
      const Anthropic = (await import('@anthropic-ai/sdk')).default
      const anthropic = new Anthropic({ apiKey })
      const anthropicTools = toAnthropicTools(isOnboarding ? onboardingTools : calendarTools)

      type AnthropicMessageParam = { role: 'user' | 'assistant'; content: string | object[] }
      const anthropicMessages: AnthropicMessageParam[] = messages.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }))

      let iterations = 0
      while (iterations < 10) {
        iterations++
        const response = await anthropic.messages.create({
          model,
          system: systemPrompt,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          messages: anthropicMessages as any,
          tools: anthropicTools,
          max_tokens: 1024,
        })

        if (response.stop_reason === 'tool_use') {
          anthropicMessages.push({ role: 'assistant', content: response.content as object[] })

          const toolResults: object[] = []
          for (const block of response.content) {
            if (block.type === 'tool_use') {
              const result = await executeTool(
                block.name,
                block.input as Record<string, unknown>,
                userId as string,
                events,
                createdEvents,
                updatedEvents,
                deletedEventIds,
                profile,
                state,
                freshProfile?.push_subscription,
                freshProfile?.fcm_token,
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

      if (state.completedProfile) completedProfile = state.completedProfile

    } else {
      // OpenAI-compatible loop (OpenAI + MiniMax + OpenRouter)
      const openaiClient = new OpenAI({
        apiKey,
        baseURL:
          provider === 'minimax'    ? 'https://api.minimaxi.chat/v1' :
          provider === 'openrouter' ? 'https://openrouter.ai/api/v1' :
          undefined,
        defaultHeaders: provider === 'openrouter' ? {
          'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
          'X-Title': 'Zman AI Scheduler',
        } : undefined,
      })

      let currentMessages: OpenAI.ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
        ...messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      ]

      // Reasoning models (MiniMax-M2.5, o1, etc.) need more tokens for thinking
      const isReasoningModel = model.includes('M2.5') || model.includes('M2-5') || model.startsWith('o1') || model.startsWith('o3')
      const maxTokens = isReasoningModel ? 4096 : 1024

      let iterations = 0
      while (iterations < 10) {
        iterations++
        const response = await openaiClient.chat.completions.create({
          model,
          messages: currentMessages,
          tools: isOnboarding ? onboardingTools : calendarTools,
          tool_choice: 'auto',
          max_tokens: maxTokens,
        })

        const message = response.choices[0].message

        if (message.tool_calls?.length) {
          currentMessages.push(message)
          for (const toolCall of message.tool_calls) {
            const tc = toolCall as { id: string; function: { name: string; arguments: string } }
            const input = JSON.parse(tc.function.arguments) as Record<string, unknown>
            const result = await executeTool(
              tc.function.name, input, userId as string, events,
              createdEvents, updatedEvents, deletedEventIds, profile, state,
              freshProfile?.push_subscription,
              freshProfile?.fcm_token,
            )
            currentMessages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify(result),
            })
          }
          if (state.completedProfile) completedProfile = state.completedProfile
          continue
        }

        // Fallback: MiniMax M2.5 sometimes outputs XML tool calls in content
        if (!message.tool_calls?.length && message.content?.includes('<invoke name=')) {
          const xmlCalls = parseXmlToolCalls(message.content)
          if (xmlCalls.length > 0) {
            currentMessages.push(message)
            for (const tc of xmlCalls) {
              const result = await executeTool(
                tc.name, tc.args, userId as string, events,
                createdEvents, updatedEvents, deletedEventIds, profile, state,
                freshProfile?.push_subscription,
                freshProfile?.fcm_token,
              )
              currentMessages.push({
                role: 'tool',
                tool_call_id: `xml-${tc.name}-${Date.now()}`,
                content: JSON.stringify(result),
              })
            }
            continue
          }
        }

        // No more tool calls — capture final text (strip reasoning + XML blocks)
        lastContent = (message.content ?? '')
          .replace(/<think>[\s\S]*?<\/think>/g, '')
          .replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, '')
          .trim()
        break
      }

      // Safety net: if AI responded with just "Done!" or similarly terse after tool calls,
      // re-prompt to get a proper explanation (MiniMax-M2.5 sometimes does this with large prompts)
      if (lastContent && lastContent.length < 30 && iterations > 1) {
        try {
          currentMessages.push({ role: 'assistant', content: lastContent })
          currentMessages.push({
            role: 'user',
            content: profile?.language === 'he'
              ? 'תן תשובה מפורטת על סמך תוצאות הכלים למעלה. הסבר מה מצאת, בעיות, והצעות. ענה בעברית.'
              : 'Please provide a detailed response based on the tool results above. Explain what you found, any issues, and your suggestions.',
          })
          const retryResp = await openaiClient.chat.completions.create({
            model,
            messages: currentMessages,
            max_tokens: isReasoningModel ? 4096 : 1024,
          })
          const retryText = (retryResp.choices[0].message.content ?? '')
            .replace(/<think>[\s\S]*?<\/think>/g, '')
            .replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, '')
            .trim()
          if (retryText.length > lastContent.length) {
            lastContent = retryText
          }
        } catch { /* keep original lastContent */ }
      }

      if (state.completedProfile) completedProfile = state.completedProfile

      // Send push notification when AI creates events (FCM for native, VAPID for browser)
      if (createdEvents.length > 0 && freshProfile && (freshProfile.fcm_token || freshProfile.push_subscription)) {
        const lang = freshProfile.language ?? 'en'
        const titles = createdEvents.slice(0, 2).map(e => e.title).join(', ')
        const more = createdEvents.length > 2 ? (lang === 'he' ? ` ועוד ${createdEvents.length - 2}` : ` +${createdEvents.length - 2} more`) : ''
        const pushPayload = {
          title: lang === 'he' ? '📅 זמן הוסיף לוח שנה' : '📅 Zman added to calendar',
          body: titles + more,
          url: '/app',
        }
        if (freshProfile.fcm_token) {
          sendFcmPush(freshProfile.fcm_token, pushPayload).catch(() => {})
        } else if (freshProfile.push_subscription) {
          sendPush(freshProfile.push_subscription, { ...pushPayload, tag: 'zman-events' }).catch(() => {})
        }
      }

      // Stream final response
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

            // Notify client to re-fetch memory if any save_memory calls were made
            if (state.memoryUpdated) {
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({ type: 'memory_updated' })}\n\n`
              ))
            }

            // Notify client to re-fetch tasks if any task tool calls were made
            if (state.tasksUpdated) {
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({ type: 'tasks_updated' })}\n\n`
              ))
            }

            if (lastContent) {
              // Stream content word-by-word so the client shows progressive rendering
              const words = lastContent.split(/(?<=\s)|(?=\s)/)
              for (const word of words) {
                if (word) {
                  controller.enqueue(encoder.encode(
                    `data: ${JSON.stringify({ type: 'text', content: word })}\n\n`
                  ))
                }
              }
            } else {
              // No text yet — stream a fresh response
              const currentMsgs: OpenAI.ChatCompletionMessageParam[] = [
                { role: 'system', content: systemPrompt },
                ...messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
              ]
              const streamResp = await openaiClient.chat.completions.create({
                model,
                messages: currentMsgs,
                max_tokens: maxTokens,
                stream: true,
              })

              let streamBuffer = ''
              let thinkingDone = false
              for await (const chunk of streamResp) {
                const delta = chunk.choices[0]?.delta?.content
                if (!delta) continue
                if (!thinkingDone) {
                  streamBuffer += delta
                  // Once we see the closing </think> tag, emit everything after it
                  const closeIdx = streamBuffer.indexOf('</think>')
                  if (closeIdx !== -1) {
                    thinkingDone = true
                    const afterThink = streamBuffer.slice(closeIdx + 8).trimStart()
                    if (afterThink) {
                      controller.enqueue(encoder.encode(
                        `data: ${JSON.stringify({ type: 'text', content: afterThink })}\n\n`
                      ))
                    }
                    streamBuffer = ''
                  } else if (!streamBuffer.startsWith('<think>') && !streamBuffer.startsWith('<')) {
                    // No thinking block — emit directly
                    thinkingDone = true
                    controller.enqueue(encoder.encode(
                      `data: ${JSON.stringify({ type: 'text', content: streamBuffer })}\n\n`
                    ))
                    streamBuffer = ''
                  }
                } else {
                  controller.enqueue(encoder.encode(
                    `data: ${JSON.stringify({ type: 'text', content: delta })}\n\n`
                  ))
                }
              }
            }

            controller.enqueue(encoder.encode('data: {"type":"done"}\n\n'))
          } catch (err) {
            console.error('Stream error:', err)
            controller.enqueue(encoder.encode('data: {"type":"error"}\n\n'))
          } finally {
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

          if (lastContent) {
            const words = lastContent.split(/(?<=\s)|(?=\s)/)
            for (const word of words) {
              if (word) {
                controller.enqueue(encoder.encode(
                  `data: ${JSON.stringify({ type: 'text', content: word })}\n\n`
                ))
              }
            }
          }

          controller.enqueue(encoder.encode('data: {"type":"done"}\n\n'))
        } catch (err) {
          console.error('Stream error:', err)
          controller.enqueue(encoder.encode('data: {"type":"error"}\n\n'))
        } finally {
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
    console.error('Chat API error:', err)
    return new Response(
      `data: {"type":"error","message":"Internal server error"}\n\n`,
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
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
  state: { completedProfile: UserProfile | null; memoryUpdated: boolean; tasksUpdated: boolean } = { completedProfile: null, memoryUpdated: false, tasksUpdated: false },
  pushSubscription?: string,
  fcmToken?: string,
): Promise<unknown> {
  // ── Input validation helpers ──────────────────────────────────────────────
  const str  = (v: unknown): string  => (typeof v === 'string' ? v : '')
  const num  = (v: unknown): number  => (typeof v === 'number' ? v : 0)
  const bool = (v: unknown): boolean => (typeof v === 'boolean' ? v : false)

  switch (toolName) {
    case 'create_event': {
      // Validate required fields
      if (!str(input.title) || !str(input.start_time) || !str(input.end_time)) {
        return { error: 'missing_required_fields', message: 'title, start_time, and end_time are required' }
      }
      if (isNaN(Date.parse(str(input.start_time))) || isNaN(Date.parse(str(input.end_time)))) {
        return { error: 'invalid_date', message: 'start_time or end_time is not a valid date' }
      }
      // ── Recurring shortcut: generate N instances, skip conflict checks ───
      const recurrence = input.recurrence as { frequency?: string; count?: number; end_date?: string } | undefined
      if (recurrence?.frequency) {
        const seriesId = crypto.randomUUID()
        const baseStart = new Date(input.start_time as string)
        const baseEnd   = new Date(input.end_time as string)
        const durationMs = baseEnd.getTime() - baseStart.getTime()
        const freq = recurrence.frequency
        const daysStep = freq === 'monthly' ? 30 : freq === 'biweekly' ? 14 : 7
        const maxCount = recurrence.count ?? (freq === 'monthly' ? 6 : 12)
        const endDate  = recurrence.end_date ? new Date(recurrence.end_date) : null
        let created = 0

        for (let i = 0; i < maxCount; i++) {
          const instanceStart = addDays(baseStart, i * daysStep)
          if (endDate && instanceStart > endDate) break
          const instanceEnd = new Date(instanceStart.getTime() + durationMs)

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

          if (DEMO_MODE) {
            demoStorage.addEvent(instance, userId)
          } else {
            const { createClient } = await import('@/lib/supabase/server')
            const supabase = await createClient()
            await supabase.from('events').insert(instance)
          }

          createdEvents.push(instance)
          created++
        }
        return { success: true, series_id: seriesId, instances_created: created }
      }

      const allKnownEvents = [...currentEvents, ...createdEvents]

      // 1. Duplicate check — same title on same day
      const newTitle = str(input.title).toLowerCase().trim()
      const newDate = new Date(str(input.start_time)).toDateString()
      const duplicate = allKnownEvents.find(e =>
        new Date(e.start_time).toDateString() === newDate &&
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
          allKnownEvents, rangeStart.toISOString(), rangeEnd.toISOString(), duration, profile
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

      if (DEMO_MODE) {
        demoStorage.addEvent(event, userId)
      } else {
        const { createClient } = await import('@/lib/supabase/server')
        const supabase = await createClient()
        const { data, error } = await supabase.from('events').insert(event).select().single()
        if (error) return { error: error.message }
        Object.assign(event, data)
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
        if (DEMO_MODE) {
          for (const e of seriesEvents) demoStorage.updateEvent(e.id, changes as Partial<CalendarEvent>, userId)
        } else {
          const { createClient } = await import('@/lib/supabase/server')
          const supabase = await createClient()
          await supabase.from('events').update(changes).eq('series_id', existing.series_id).eq('user_id', userId)
        }
        const updatedSeries = seriesEvents.map(e => ({ ...e, ...changes } as CalendarEvent))
        updatedEvents.push(...updatedSeries)
        return { success: true, updated_count: seriesEvents.length, series_id: existing.series_id }
      }

      // Single event update
      if (DEMO_MODE) {
        demoStorage.updateEvent(event_id, changes as Partial<CalendarEvent>, userId)
      } else {
        const { createClient } = await import('@/lib/supabase/server')
        const supabase = await createClient()
        await supabase.from('events').update(changes).eq('id', event_id).eq('user_id', userId)
      }

      const updated = { ...existing, ...changes }
      updatedEvents.push(updated as CalendarEvent)
      return { success: true, event: updated }
    }

    case 'move_event': {
      const { event_id, new_start_time, new_end_time } = input as { event_id: string; new_start_time: string; new_end_time: string }
      const existing = currentEvents.find(e => e.id === event_id)
      if (!existing) return { error: 'Event not found' }
      // Enforce mobility_type — fixed events cannot be moved
      if (existing.mobility_type === 'fixed') {
        return { error: 'fixed_event', message: `"${existing.title}" is marked as Fixed (🔒) and cannot be moved.` }
      }

      const updated = { ...existing, start_time: new_start_time, end_time: new_end_time }

      if (DEMO_MODE) {
        demoStorage.updateEvent(event_id, { start_time: new_start_time, end_time: new_end_time }, userId)
      } else {
        const { createClient } = await import('@/lib/supabase/server')
        const supabase = await createClient()
        await supabase.from('events').update({ start_time: new_start_time, end_time: new_end_time }).eq('id', event_id).eq('user_id', userId)
      }

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
          if (DEMO_MODE) {
            for (const id of seriesIds) demoStorage.deleteEvent(id, userId)
          } else {
            const { createClient } = await import('@/lib/supabase/server')
            const supabase = await createClient()
            await supabase.from('events').delete().eq('series_id', sid).eq('user_id', userId)
          }
          deletedEventIds.push(...seriesIds)
          return { success: true, deleted_series_id: sid, instances_deleted: seriesIds.length }
        }
        // No series_id — fall through to single delete
      }

      if (DEMO_MODE) {
        demoStorage.deleteEvent(event_id, userId)
      } else {
        const { createClient } = await import('@/lib/supabase/server')
        const supabase = await createClient()
        await supabase.from('events').delete().eq('id', event_id).eq('user_id', userId)
      }

      deletedEventIds.push(event_id)
      return { success: true }
    }

    case 'get_free_slots': {
      const { from_date, to_date, min_duration_minutes = 60, prefer_peak = false } = input as { from_date: string; to_date: string; min_duration_minutes?: number; prefer_peak?: boolean }
      return { free_slots: getFreeSlots(currentEvents, from_date, to_date, min_duration_minutes as number, profile, prefer_peak as boolean) }
    }

    case 'break_down_task': {
      const { task_title, deadline, total_hours, session_length_hours, color = '#6366F1' } = input as {
        task_title: string; deadline: string; total_hours: number; session_length_hours?: number; color?: string
      }

      // Method-aware session length safety net (all 18 methods)
      const METHOD_SESSION_HOURS: Record<string, number> = {
        pomodoro: 0.5, deep_work: 2.5, eisenhower: 1.5, gtd: 1,
        time_blocking: 1.5, ivy_lee: 1, eat_the_frog: 1.5, theme_days: 2,
        the_one_thing: 3, weekly_review: 1.25, okr: 1.5, kanban: 1,
        time_boxing: 0.75, moscow: 1.5, rule_5217: 0.87, scrum: 1.5,
        energy_management: 1.5, twelve_week_year: 1.5,
      }
      const userMethod = profile?.scheduling_method as string | undefined
      const effectiveSessionLength = session_length_hours
        ?? (userMethod ? METHOD_SESSION_HOURS[userMethod] : undefined)
        ?? 2

      // Method-aware title format (all 18 methods)
      const METHOD_TITLE: Record<string, (t: string, i: number) => string> = {
        pomodoro:     (t, i) => `${t} — פומודורו ${i + 1}`,
        deep_work:    (t, i) => `${t} — Deep Work ${i + 1}`,
        eisenhower:   (t, i) => `${t} — Session ${i + 1}`,
        gtd:          (t, i) => `${t} — Action ${i + 1}`,
        time_blocking:(t, i) => `${t} — Block ${i + 1}`,
        ivy_lee:      (t, i) => `#${i + 1} ${t}`,
        eat_the_frog: (t, i) => i === 0 ? `🐸 ${t}` : `${t} — Session ${i + 1}`,
        theme_days:   (t, i) => `${t} — Session ${i + 1}`,
        the_one_thing:(t, i) => i === 0 ? `🎯 ${t}` : `${t} — Session ${i + 1}`,
        weekly_review:(t, i) => `🔄 ${t}`,
        okr:          (t, i) => `${t} — OKR ${i + 1}`,
        kanban:       (t, i) => `${t} — ${i + 1}`,
        time_boxing:  (t, i) => `${t} (timebox ${i + 1})`,
        moscow:       (t, i) => `${t} — Session ${i + 1}`,
        rule_5217:    (t, i) => `${t} — 52/17 #${i + 1}`,
        scrum:        (t, i) => `${t} — Sprint Task ${i + 1}`,
        energy_management: (t, i) => `${t} — Session ${i + 1}`,
        twelve_week_year:  (t, i) => `${t} — W${i + 1}`,
      }
      const formatTitle = userMethod && METHOD_TITLE[userMethod]
        ? METHOD_TITLE[userMethod]
        : (t: string, i: number) => `${t} — Session ${i + 1}`

      // Method-aware mobility default
      const FIXED_METHODS = new Set(['deep_work', 'the_one_thing'])
      const ASK_FIRST_METHODS = new Set(['eat_the_frog', 'theme_days', 'weekly_review', 'scrum', 'moscow'])
      const defaultMobility: 'fixed' | 'flexible' | 'ask_first' =
        userMethod && FIXED_METHODS.has(userMethod) ? 'fixed' :
        userMethod && ASK_FIRST_METHODS.has(userMethod) ? 'ask_first' :
        'flexible'

      // Use peak-hour preferred slots for study/work tasks
      const slots = getFreeSlots(currentEvents, new Date().toISOString(), deadline, effectiveSessionLength * 60, profile, true)
      const sessionsNeeded = Math.ceil(total_hours / effectiveSessionLength)
      let created = 0

      for (let i = 0; i < Math.min(sessionsNeeded, slots.length); i++) {
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

        if (DEMO_MODE) {
          demoStorage.addEvent(event, userId)
        } else {
          const { createClient } = await import('@/lib/supabase/server')
          const supabase = await createClient()
          const { data } = await supabase.from('events').insert(event).select().single()
          if (data) Object.assign(event, data)
        }

        createdEvents.push(event)
        created++
      }

      return { success: true, sessions_created: created }
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
        title.replace(/^(מעבדה ל|תרגול ל|תרגיל ל|חדווה ל|lab for |tutorial for |lab |recitation )/i, '').trim()

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
      const peakEnd   = peak === 'morning' ? 12 : peak === 'afternoon' ? 18 : 24
      const sleepHour = profile?.sleep_time ? parseInt(profile.sleep_time.split(':')[0]) : 23

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

        // 1. Back-to-back events (< 15 min gap)
        for (let i = 0; i < dayEvs.length - 1; i++) {
          const gapMin = (new Date(dayEvs[i + 1].start_time).getTime() - new Date(dayEvs[i].end_time).getTime()) / 60000
          if (gapMin >= 0 && gapMin < 15) {
            issues.push(`BACK_TO_BACK: "${dayEvs[i].title}" and "${dayEvs[i + 1].title}" on ${day} — only ${Math.round(gapMin)} min gap, no buffer time`)
          }
        }

        // 2. No lunch break on a busy day (3+ events, nothing free 12:00–13:30)
        if (dayEvs.length >= 3) {
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

        // 5. Important event (exam/presentation) with no prep the day before
        for (const ev of dayEvs) {
          const isImportant = /exam|test|presentation|מבחן|מצגת|הגשה|deadline/i.test(ev.title)
          if (isImportant) {
            const dayBefore = format(addDays(new Date(day), -1), 'yyyy-MM-dd')
            const hasPrep = byDay[dayBefore]?.some(pe =>
              /study|prep|review|practice|לימוד|חזרה|תרגול/i.test(pe.title)
            )
            if (!hasPrep) {
              issues.push(`NO_PREP: "${ev.title}" on ${day} — no study/prep session found on ${dayBefore} (day before)`)
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
      if (DEMO_MODE) {
        const memFile = path.join(process.cwd(), 'data', 'users', userId, 'memory.json')
        const existing: AIMemory[] = fs.existsSync(memFile)
          ? JSON.parse(fs.readFileSync(memFile, 'utf-8')) : []
        const updated = memHelper(existing)
        const dir = path.join(process.cwd(), 'data', 'users', userId)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(memFile, JSON.stringify(updated, null, 2))
      } else {
        const { createClient } = await import('@/lib/supabase/server')
        const supabase = await createClient()
        for (const entry of entries) {
          await supabase.from('ai_memory').upsert({
            user_id: userId, key: entry.key, value: entry.value, learned_from: 'behavior',
          }, { onConflict: 'user_id,key' })
        }
      }
      state.memoryUpdated = true
      return { success: true, saved: entries.length }
    }

    case 'delete_memory': {
      const { keys } = input as { keys: string[] }
      if (DEMO_MODE) {
        const memFile = path.join(process.cwd(), 'data', 'users', userId, 'memory.json')
        const existing: AIMemory[] = fs.existsSync(memFile)
          ? JSON.parse(fs.readFileSync(memFile, 'utf-8')) : []
        const filtered = existing.filter(m => !keys.includes(m.key))
        fs.writeFileSync(memFile, JSON.stringify(filtered, null, 2))
      } else {
        const { createClient } = await import('@/lib/supabase/server')
        const supabase = await createClient()
        await supabase.from('ai_memory').delete().eq('user_id', userId).in('key', keys)
      }
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
        created_at: new Date().toISOString(),
      }
      if (DEMO_MODE) {
        demoStorage.addTask(task, userId)
      } else {
        const { createClient } = await import('@/lib/supabase/server')
        const supabase = await createClient()
        const { error } = await supabase.from('tasks').insert(task)
        if (error) return { error: error.message }
      }
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

      if (DEMO_MODE) {
        demoStorage.updateTask(taskId, updates, userId)
      } else {
        const { createClient } = await import('@/lib/supabase/server')
        const supabase = await createClient()
        const { error } = await supabase.from('tasks').update(updates).eq('id', taskId).eq('user_id', userId)
        if (error) return { error: error.message }
      }
      state.tasksUpdated = true
      return { success: true }
    }

    case 'delete_task': {
      const taskId = str(input.task_id)
      if (DEMO_MODE) {
        demoStorage.deleteTask(taskId, userId)
      } else {
        const { createClient } = await import('@/lib/supabase/server')
        const supabase = await createClient()
        const { error } = await supabase.from('tasks').delete().eq('id', taskId).eq('user_id', userId)
        if (error) return { error: error.message }
      }
      state.tasksUpdated = true
      return { success: true }
    }

    case 'list_tasks': {
      const { status, topic } = input as { status?: string; topic?: string }
      if (DEMO_MODE) {
        let tasks = demoStorage.getTasks(userId)
        if (status) tasks = tasks.filter(t => t.status === status)
        if (topic) tasks = tasks.filter(t => t.topic === topic)
        return { tasks }
      } else {
        const { createClient } = await import('@/lib/supabase/server')
        const supabase = await createClient()
        let query = supabase.from('tasks').select('*').eq('user_id', userId)
        if (status) query = query.eq('status', status)
        if (topic) query = query.eq('topic', topic)
        const { data, error } = await query.order('created_at', { ascending: false })
        if (error) return { error: error.message }
        return { tasks: data }
      }
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
      }

      if (DEMO_MODE) {
        // Save memory entries
        if (memory_entries?.length) {
          const memFile = path.join(process.cwd(), 'data', 'users', userId, 'memory.json')
          const existing: AIMemory[] = fs.existsSync(memFile)
            ? JSON.parse(fs.readFileSync(memFile, 'utf-8'))
            : []
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
          const dir = path.join(process.cwd(), 'data', 'users', userId)
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
          fs.writeFileSync(memFile, JSON.stringify(existing, null, 2))
        }
        // Update profile
        const profFile = path.join(process.cwd(), 'data', 'users', userId, 'profile.json')
        const existing: UserProfile = fs.existsSync(profFile)
          ? JSON.parse(fs.readFileSync(profFile, 'utf-8'))
          : { user_id: userId, autonomy_mode: 'hybrid', theme: 'dark', voice_response_enabled: false, language: 'en', onboarding_completed: false, productivity_peak: 'morning' }
        const updated: UserProfile = { ...existing, ...(profile_updates ?? {}), onboarding_completed: true, user_id: userId }
        fs.writeFileSync(profFile, JSON.stringify(updated, null, 2))
        state.completedProfile = updated
      } else {
        // Supabase mode
        const { createClient } = await import('@/lib/supabase/server')
        const supabase = await createClient()
        // Save memory entries
        if (memory_entries?.length) {
          for (const entry of memory_entries) {
            await supabase.from('ai_memory').upsert({
              user_id: userId, key: entry.key, value: entry.value, learned_from: 'onboarding',
            }, { onConflict: 'user_id,key' })
          }
        }
        // Update profile
        const { data: existing } = await supabase
          .from('user_profiles').select('*').eq('user_id', userId).single()
        const updated: UserProfile = {
          ...(existing ?? { user_id: userId, autonomy_mode: 'hybrid', theme: 'dark', voice_response_enabled: false, language: 'en', onboarding_completed: false, productivity_peak: 'morning' }),
          ...(profile_updates ?? {}),
          onboarding_completed: true,
          user_id: userId,
        } as UserProfile
        await supabase.from('user_profiles').upsert(updated)
        state.completedProfile = updated
      }

      if (memory_entries?.length) state.memoryUpdated = true
      return { success: true }
    }

    case 'send_notification': {
      const { title, body } = input as { title: string; body: string }
      if (!fcmToken && !pushSubscription) {
        return { success: false, reason: 'no_push_subscription', message: 'User has no push subscription. Ask them to enable notifications in Settings.' }
      }
      // Try FCM (native Capacitor) first, then fall back to VAPID (browser PWA)
      if (fcmToken) {
        await sendFcmPush(fcmToken, { title, body, url: '/app' })
      } else if (pushSubscription) {
        await sendPush(pushSubscription, { title, body, url: '/app', tag: 'zman-message' })
      }
      return { success: true }
    }

    case 'delete_all_events': {
      const allIds = currentEvents.map(e => e.id)
      if (DEMO_MODE) {
        for (const id of allIds) demoStorage.deleteEvent(id, userId)
      } else {
        const { createClient } = await import('@/lib/supabase/server')
        const supabase = await createClient()
        await supabase.from('events').delete().eq('user_id', userId)
      }
      deletedEventIds.push(...allIds)
      return { success: true, deleted_count: allIds.length }
    }

    default:
      return { error: `Unknown tool: ${toolName}` }
  }
}

// ─── Free slot calculator ─────────────────────────────────────────────────────

function getFreeSlots(
  events: CalendarEvent[],
  fromDate: string,
  toDate: string,
  minMinutes: number,
  profile?: UserProfile | null,
  preferPeak = false
) {
  const slots: Array<{ start: string; end: string; duration_minutes: number; is_peak?: boolean }> = []
  let cursor = parseISO(fromDate)
  const to = parseISO(toDate)

  // Determine day bounds from profile
  const dayStartHour = profile?.preferred_hours?.start ??
    (profile?.wake_time ? parseInt(profile.wake_time.split(':')[0]) : 9)
  const dayEndHour = profile?.preferred_hours?.end ??
    (profile?.sleep_time ? parseInt(profile.sleep_time.split(':')[0]) : 22)

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
    const nowTs = new Date()
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

  const result = slots.slice(0, 20)

  // If preferPeak, sort so peak slots come first (preserving original order within each group)
  if (preferPeak) {
    return [
      ...result.filter(s => s.is_peak),
      ...result.filter(s => !s.is_peak),
    ]
  }

  return result
}
