import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.zman.app',
  appName: 'Zman',
  // `out/` only needs to exist to satisfy `cap sync`; the native apps load the
  // remote `server.url` below, NOT a static export. Do NOT add output:'export'
  // to next.config.ts — that would break the Next.js server runtime on Railway.
  webDir: 'out',
  server: {
    // Per-project Railway URL — set CAPACITOR_SERVER_URL at build/sync time so a
    // copy of this repo never silently points at another project (e.g. dad's).
    // Each separate Railway project has its own URL; this is the ONLY place the
    // native shell decides which backend to load.
    url: process.env.CAPACITOR_SERVER_URL ?? 'https://REPLACE-WITH-YOUR-RAILWAY-URL.up.railway.app',
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
