import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.zman.app',
  appName: 'Zman',
  webDir: 'out',
  server: {
    // Replace this with your actual Railway URL
    url: process.env.CAPACITOR_SERVER_URL ?? 'https://zman-production.up.railway.app',
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
      style: 'dark',
      backgroundColor: '#07070F',
    },
  },
}

export default config
