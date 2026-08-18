import { NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { runTurn } from '@/lib/ai/runTurn'
import { CalendarEvent, UserProfile, Task } from '@/types'
import { getUserIdFromCookie, COOKIE_NAME } from '@/lib/auth'

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

// ─── Main handler ────────────────────────────────────────────────────────────
//
// Transport only. Everything that decides what the assistant says — the profile
// and memory loads, the prompt, the Anthropic tool-call loop, the follow-up
// retry — lives in `lib/ai/runTurn.ts`, because a route file may export nothing
// but HTTP handlers and Next's route config, so nothing here could ever be
// reused by a second caller.
//
// The split is only possible because the tool loop always finished BEFORE the
// stream was built: by the first SSE byte the reply text and every flag were
// already final, and the word-by-word emission below is re-chunking, not
// generation. Keep it that way — the moment this file starts deciding anything,
// the two callers can disagree.

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

    // Anthropic is the only provider — one server-wide key, model chosen via env
    // (no code change to switch). Per-user API keys were removed: Settings never
    // shipped a UI to enter one, so the encrypted-key precedence was dead code.
    //
    // The check stays here rather than inside runTurn because its answer is a
    // *stream shape*: three frames with the message unsplit, unlike the ordinary
    // reply below. A second caller reports a missing key in its own shape.
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      return buildErrorStream('⚙️ No Anthropic API key configured on the server.')
    }

    // The whole turn — tool loop included — runs to completion here. See the note
    // above: nothing below this line can change what the assistant decided.
    const turn = await runTurn({
      userId, messages, events, profile, isOnboarding, memory, tasks, timezone, apiKey,
    })

    // ── Anthropic / shared SSE stream ───────────────────────────────────────
    const readableStream = new ReadableStream({
      async start(controller) {
        try {
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ type: 'events', createdEvents: turn.createdEvents, updatedEvents: turn.updatedEvents, deletedEventIds: turn.deletedEventIds })}\n\n`
          ))

          if (turn.completedProfile) {
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ type: 'onboarding_complete', profile: turn.completedProfile })}\n\n`
            ))
          }

          if (turn.memoryUpdated) {
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ type: 'memory_updated' })}\n\n`
            ))
          }

          if (turn.tasksUpdated) {
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ type: 'tasks_updated' })}\n\n`
            ))
          }

          // Its own frame rather than a reuse of tasks_updated: refetching projects
          // also pulls /api/projects/health, which runs a real placement pass, and
          // making every task edit pay for that would be a poor trade.
          if (turn.projectsUpdated) {
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ type: 'projects_updated' })}\n\n`
            ))
          }

          if (turn.text) {
            const words = turn.text.split(/(?<=\s)|(?=\s)/)
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
            // The wording is `runTurn`'s, so every caller says the same thing; it
            // goes out as ONE frame, deliberately unsplit, exactly as before.
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ type: 'text', content: turn.fallbackText })}\n\n`
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
