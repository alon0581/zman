import type { CapacitorConfig } from '@capacitor/cli'

// Per-project Railway origin. Set CAPACITOR_SERVER_URL at build/sync time so a
// copy of this repo never silently points at another project (e.g. dad's).
const ORIGIN = (process.env.CAPACITOR_SERVER_URL ?? 'https://REPLACE-WITH-YOUR-RAILWAY-URL.up.railway.app')
  .replace(/\/+$/, '')

const config: CapacitorConfig = {
  appId: 'com.zman.app',
  appName: 'Zman',
  // `out/` only needs to exist to satisfy `cap sync`; the native apps load the
  // remote `server.url` below, NOT a static export. Do NOT add output:'export'
  // to next.config.ts — that would break the Next.js server runtime on Railway.
  webDir: 'out',
  server: {
    // This is the ONLY place the native shell decides which backend to load, and
    // it does NOT read public/manifest.json — so the manifest's `start_url:"/app"`
    // does not apply here. Landing on the bare origin renders the marketing page
    // when logged out (src/app/page.tsx), which is wrong inside an installed app.
    // `/app` is the front door every other entry surface already uses (the
    // manifest and public/sw.js), and it redirects to /login without a cookie.
    url: `${ORIGIN}/app`,
    cleartext: false,
    androidScheme: 'https',
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    SplashScreen: {
      launchShowDuration: 800,
      backgroundColor: '#07070F',
      showSpinner: false,
    },
    StatusBar: {
      // 'light' = white icons — correct for our dark (#07070F) background.
      // 'dark' would show black icons which are invisible on dark background.
      style: 'light',
      backgroundColor: '#07070F', // solid dark — matches app background, no edge-to-edge needed
    },
  },
}

export default config
