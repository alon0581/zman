import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'url'
import path from 'path'

/**
 * Test config for the scheduling engine and other pure logic.
 *
 * The engine is deliberately dependency-free (no fs, no fetch, `now` injected),
 * so it runs in a plain node environment — no jsdom, no setup files, no mocks.
 * That is the whole point of keeping it pure: correctness is checked here, in
 * milliseconds and for free, instead of by asking a language model.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    // Mirror the "@/*" path alias from tsconfig.json.
    alias: { '@': path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'src') },
  },
})
