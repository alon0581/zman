import path from 'path'
import fs from 'fs'

/**
 * Single source of truth for the user-data directory (auth, events, tasks,
 * profiles, memory). Defaults to <cwd>/data — which on Railway is /app/data.
 *
 * Override with the DATA_DIR env var to point at a mounted volume wherever it
 * lands. On Railway this directory MUST be a mounted volume, otherwise the
 * container filesystem is ephemeral and ALL user data (including memory) resets
 * on every deploy/restart.
 */
export const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data')

// Log the resolved path + writability once at startup, so persistence can be
// verified straight from the deploy logs.
try {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.accessSync(DATA_DIR, fs.constants.W_OK)
  console.log(`[storage] DATA_DIR=${DATA_DIR} (writable). On Railway this MUST be a mounted volume, or user data (incl. memory) resets each deploy.`)
} catch (err) {
  console.error(`[storage] DATA_DIR=${DATA_DIR} is NOT writable — user data will not persist:`, (err as Error)?.message)
}
