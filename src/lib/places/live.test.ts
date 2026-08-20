/**
 * live.test.ts — the one thing unit tests cannot prove: that the MODEL uses this.
 *
 * Every other test here mocks the provider, so they check that the engine
 * reserves the right minutes and that the tool array has the right shape. None of
 * them can tell you whether Claude, handed a Hebrew sentence about where the user
 * lives, actually calls `save_place`, or whether it remembers to attach a
 * `place_id` when it later creates an event. That is a property of the tool
 * DESCRIPTIONS and the guidance block, not of any function, and it has been the
 * failure mode twice in this repo already — `break_down_task` winning over
 * `plan_project`, and prompt prose losing to a more specific description.
 *
 * So this file makes real API calls. It is skipped unless ANTHROPIC_API_KEY is
 * present, which means `npm test` ignores it entirely. To run it:
 *
 *   railway run --service zman -- npx vitest run src/lib/places/live
 *
 * `railway run` injects the production key without printing it. DATA_DIR is
 * redirected to a temp directory below, so nothing here can touch real user data
 * — not the Railway volume (different machine) and not the local data/ folder.
 *
 * Budget: six turns, a few cents. Keep it that way.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP = path.join(os.tmpdir(), `zman-live-places-${process.pid}`)
const USER_ID = 'live-test-user'

process.env.DATA_DIR = TMP
process.env.AUTH_SECRET = 'live-test-secret-not-for-production'
process.env.SCHEDULER_V2 = '1'
process.env.PLACES = '1'
process.env.PROJECTS = '0'
process.env.PHASES = '0'

const HAS_KEY = !!process.env.ANTHROPIC_API_KEY

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runTurn: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let userStore: any

/** Every turn shares one growing transcript, exactly as a real conversation does. */
const history: Array<{ role: 'user' | 'assistant'; content: string }> = []

async function say(text: string) {
  history.push({ role: 'user', content: text })
  const turn = await runTurn({
    userId: USER_ID,
    messages: [...history],
    events: userStore.getEvents(USER_ID),
    profile: userStore.getPlaces ? readProfile() : null,
    memory: [],
    tasks: [],
    timezone: 'Asia/Jerusalem',
    apiKey: process.env.ANTHROPIC_API_KEY!,
    maxLoopMs: 60_000,
  })
  history.push({ role: 'assistant', content: turn.text || turn.fallbackText })
  return turn
}

function readProfile() {
  const f = path.join(TMP, 'users', USER_ID, 'profile.json')
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : null
}

beforeAll(async () => {
  const dir = path.join(TMP, 'users', USER_ID)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({
    user_id: USER_ID,
    autonomy_mode: 'hybrid', theme: 'dark', language: 'he',
    onboarding_completed: true,
    wake_time: '08:00', sleep_time: '23:00',
    scheduling_method: 'time_blocking',
    timezone: 'Asia/Jerusalem',
  }, null, 2))

  const mod = await import('@/lib/ai/runTurn')
  runTurn = mod.runTurn
  userStore = (await import('@/lib/store/userStore')).userStore
})

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe.skipIf(!HAS_KEY)('places, end to end with a real model', () => {
  it('creates places from one plain Hebrew sentence', async () => {
    await say('הבית שלי בבאר שבע. לנדוור נמצא 20 דקות נסיעה מהבית, ולוקח לי חצי שעה להתארגן לפני שאני יוצא לשם.')

    const places = userStore.getPlaces(USER_ID)
    console.log('[live] places after turn 1:', JSON.stringify(places, null, 2))

    expect(places.length).toBeGreaterThanOrEqual(2)
    const home = places.find((p: { is_home?: boolean }) => p.is_home)
    expect(home, 'one place must be flagged as home').toBeTruthy()

    const work = places.find((p: { id: string }) => p.id !== home.id)
    expect(work.prep_minutes, 'prep should be the 30 minutes stated').toBe(30)
    expect(work.travel_from[home.id], 'travel from home should be the 20 stated').toBe(20)
  }, 90_000)

  it('attaches the place when it creates the event there', async () => {
    await say('תקבע לי משמרת בלנדוור ביום רביעי הקרוב מ-17:00 עד 23:00.')

    const events = userStore.getEvents(USER_ID)
    console.log('[live] events after turn 2:', events.map((e: Record<string, unknown>) =>
      ({ title: e.title, start: e.start_time, place_id: e.place_id })))

    const shift = events.find((e: { title: string }) => /לנדוור/.test(e.title))
    expect(shift, 'the shift must exist').toBeTruthy()
    expect(shift.place_id, 'and it must carry the place — this is the link the whole feature hangs on').toBeTruthy()
  }, 90_000)

  it('refuses to schedule into the journey, and says why', async () => {
    // The shift starts at 17:00 and is 20 minutes away with 30 of prep and a 10
    // minute margin, so 16:00-17:00 is inside the travel window. A scheduler that
    // does not understand places would take it happily.
    const turn = await say('תמצא לי שעה ללמוד ביום רביעי אחרי הצהריים, כמה שיותר קרוב ל-16:00.')
    console.log('[live] reply to turn 3:\n' + (turn.text || turn.fallbackText))

    const events = userStore.getEvents(USER_ID)
    const wednesday = events
      .filter((e: { start_time: string }) => e.start_time.slice(0, 10) >= '2026-08-01')
      .map((e: { title: string; start_time: string; end_time: string }) =>
        ({ title: e.title, start: e.start_time, end: e.end_time }))
    console.log('[live] wednesday after turn 3:', wednesday)

    // Nothing may end inside the hour before the shift.
    const shift = events.find((e: { title: string }) => /לנדוור/.test(e.title))
    const guardStart = new Date(new Date(shift.start_time).getTime() - 60 * 60_000)
    const intruder = events.find((e: { id: string; start_time: string; end_time: string }) =>
      e.id !== shift.id &&
      new Date(e.end_time) > guardStart &&
      new Date(e.start_time) < new Date(shift.start_time))

    expect(intruder, `nothing may be scheduled into the travel window, found: ${JSON.stringify(intruder)}`).toBeFalsy()
  }, 90_000)
})
