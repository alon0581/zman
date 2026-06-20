/**
 * Durable JSON file helpers shared by every file-based store (events, tasks,
 * profile, memory, auth).
 *
 * Two real-world failure modes this guards against on Railway:
 *  1. **Partial writes** — `fs.writeFileSync` is not atomic; if the process is
 *     killed mid-write (a redeploy/restart), the file is left truncated and the
 *     next parse throws. `writeJsonFileAtomic` writes to a temp file then
 *     renames, so a reader always sees either the old or the new file whole.
 *  2. **Silent data loss** — a corrupt file used to be swallowed by a bare
 *     `catch { return [] }`, which then got overwritten with the empty default
 *     on the next save. `readJsonFile` instead logs and moves the corrupt file
 *     aside to `<file>.corrupt-<ts>` so the data is recoverable.
 *
 * Single-process scope. The synchronous read-modify-write callers are already
 * atomic under Node's single thread; these helpers add crash durability, not a
 * cross-process lock.
 */
import fs from 'fs'
import path from 'path'

/** Read + JSON.parse a file. Returns `fallback` when missing or unparseable. */
export function readJsonFile<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback
    // Strip a leading UTF-8 BOM — a file touched by a Windows editor can carry one,
    // and JSON.parse throws on it, which would route a perfectly good profile to the
    // corrupt-backup path and make the user look brand new.
    const raw = fs.readFileSync(file, 'utf-8').replace(/^﻿/, '')
    if (raw.trim() === '') return fallback
    return JSON.parse(raw) as T
  } catch (err) {
    console.error('[jsonStore] Failed to read/parse', file, '—', (err as Error)?.message)
    // Preserve the corrupt content instead of letting the next write clobber it.
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      fs.copyFileSync(file, `${file}.corrupt-${stamp}`)
      console.error('[jsonStore] Backed up corrupt file to', `${file}.corrupt-${stamp}`)
    } catch { /* best-effort backup only */ }
    return fallback
  }
}

/** Atomically write `data` as pretty JSON: write to a temp file, then rename. */
export function writeJsonFileAtomic(file: string, data: unknown): void {
  const dir = path.dirname(file)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  // Unique-ish temp name (pid + hrtime) so concurrent writers don't share one.
  const tmp = `${file}.tmp-${process.pid}-${process.hrtime.bigint()}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)  // atomic on the same filesystem
}
