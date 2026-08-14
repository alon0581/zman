/**
 * profileMirror.ts — keeps `memory.json` from contradicting `profile.json`.
 *
 * A handful of profile fields are ALSO written into memory as facts, because the
 * PERSON PROFILE block the model reads is built from memory, not from the profile
 * object. That mirroring used to happen in exactly one place: the one-time
 * transition to `onboarding_completed`. Every later edit — every Settings save —
 * wrote `profile.json` only.
 *
 * The result was a permanent, silent contradiction. Change `productivity_peak`
 * from morning to evening in Settings and the profile says evening while a
 * `productivity_peak: morning` memory row keeps being injected into every prompt,
 * with no timestamp for the model to arbitrate between them. It believes whichever
 * it reads last.
 *
 * So this is the single writer, called from every place a mirrored field can
 * change. Adding a field to MIRRORED_KEYS is the only step required to keep a new
 * one in sync.
 */

import path from 'path'
import crypto from 'crypto'
import { AIMemory, UserProfile } from '@/types'
import { DATA_DIR } from '@/lib/util/dataDir'
import { assertSafeUserId } from '@/lib/util/safeUserId'
import { readJsonFile, writeJsonFileAtomic } from '@/lib/util/jsonStore'

/**
 * profile field -> memory key. The keys are the ones PROFILE_CATEGORIES in
 * systemPrompt.ts already recognises, which is why they are worth mirroring at
 * all: an unrecognised key lands in the low-signal `[Other]` bucket.
 */
export const MIRRORED_KEYS: { field: keyof UserProfile; key: string }[] = [
  { field: 'persona', key: 'persona_type' },
  { field: 'challenge', key: 'main_challenge' },
  { field: 'day_structure', key: 'day_structure' },
  { field: 'scheduling_method', key: 'scheduling_method' },
  { field: 'secondary_methods', key: 'secondary_methods' },
  { field: 'productivity_peak', key: 'productivity_peak' },
  { field: 'occupation', key: 'occupation' },
  { field: 'wake_time', key: 'wake_time' },
  { field: 'sleep_time', key: 'sleep_time' },
]

function memoryFile(userId: string): string {
  return path.join(DATA_DIR, 'users', assertSafeUserId(userId), 'memory.json')
}

function valueOf(profile: UserProfile, field: keyof UserProfile): string | null {
  const raw = profile[field]
  if (raw === undefined || raw === null || raw === '') return null
  if (Array.isArray(raw)) return raw.length ? raw.join(', ') : null
  if (typeof raw === 'string') return raw
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
  return null
}

/**
 * Writes the mirrored subset of `profile` into memory, overwriting same-key rows.
 *
 * `fields` narrows it to what actually changed, so a Settings save that touches
 * one toggle does not rewrite seven memory rows. Omit it to mirror everything
 * present (what the onboarding transition wants).
 *
 * Returns the memory keys it wrote, so a caller can report them. Never throws:
 * a mirroring failure must not fail the profile save that triggered it.
 */
export function mirrorProfileToMemory(
  userId: string,
  profile: UserProfile,
  fields?: (keyof UserProfile)[],
  learnedFrom: AIMemory['learned_from'] = 'explicit',
): string[] {
  try {
    const wanted = fields
      ? MIRRORED_KEYS.filter(m => fields.includes(m.field))
      : MIRRORED_KEYS

    const entries = wanted
      .map(m => ({ key: m.key, value: valueOf(profile, m.field) }))
      .filter((e): e is { key: string; value: string } => e.value !== null)

    if (entries.length === 0) return []

    const file = memoryFile(userId)
    const existing = readJsonFile<AIMemory[]>(file, [])
    for (const entry of entries) {
      const idx = existing.findIndex(m => m.key === entry.key)
      const item: AIMemory = {
        id: idx >= 0 ? existing[idx].id : crypto.randomUUID(),
        user_id: userId,
        key: entry.key,
        value: entry.value,
        learned_from: learnedFrom,
        // created_at is FIRST-seen and is deliberately preserved across overwrites
        // everywhere in this codebase. Do not "fix" it to now — several readers
        // depend on it meaning first-seen.
        created_at: idx >= 0 ? existing[idx].created_at : new Date().toISOString(),
      }
      if (idx >= 0) existing[idx] = item
      else existing.push(item)
    }
    writeJsonFileAtomic(file, existing)
    return entries.map(e => e.key)
  } catch (err) {
    console.error('[profileMirror] failed to mirror profile to memory:', (err as Error)?.message)
    return []
  }
}
