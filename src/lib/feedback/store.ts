/**
 * Deterministic user-feedback signals for "learn while running".
 *
 * When the user deletes an AI-created event (rejection) or moves it to a
 * different time, we record a small signal. The chat route injects a compact
 * summary into the prompt so the AI adapts immediately and can promote a
 * repeated signal to durable `pattern_*` memory.
 *
 * File-based, single source of truth via DATA_DIR + atomic writes; capped so
 * the file (and the injected summary) stay small.
 */
import path from 'path'
import { FeedbackSignal } from '@/types'
import { assertSafeUserId } from '@/lib/util/safeUserId'
import { readJsonFile, writeJsonFileAtomic } from '@/lib/util/jsonStore'
import { DATA_DIR } from '@/lib/util/dataDir'

const MAX_SIGNALS = 40

function feedbackFile(userId: string) {
  return path.join(DATA_DIR, 'users', assertSafeUserId(userId), 'feedback.json')
}

export function readFeedback(userId: string): FeedbackSignal[] {
  return readJsonFile<FeedbackSignal[]>(feedbackFile(userId), [])
}

/** Append a signal (FIFO-capped). Best-effort — never throws to the caller. */
export function recordFeedback(userId: string, signal: FeedbackSignal): void {
  try {
    const file = feedbackFile(userId)
    const list = readJsonFile<FeedbackSignal[]>(file, [])
    list.push(signal)
    writeJsonFileAtomic(file, list.slice(-MAX_SIGNALS))
  } catch (err) {
    console.warn('[feedback] failed to record signal:', (err as Error)?.message)
  }
}
