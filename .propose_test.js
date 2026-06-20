const fs = require('fs')
// Profile with a method set so the TASK INTAKE PROTOCOL (propose, don't ask) renders.
const profile = {
  user_id: 'x', autonomy_mode: 'hybrid', theme: 'dark', language: 'he',
  onboarding_completed: true, productivity_peak: 'morning',
  scheduling_method: 'time_blocking', wake_time: '07:00', sleep_time: '23:00',
}
const memory = [
  { key: 'productivity_peak', value: 'morning' },
  { key: 'pref_workout_time', value: 'בוקר, אחרי שאני קם' },
]
fs.writeFileSync('./.vc.json', JSON.stringify({
  messages: [{ role: 'user', content: 'אני רוצה להתחיל להתאמן כוח, תסדר לי את זה השבוע' }],
  events: [], profile, memory, tasks: [], timezone: 'Asia/Jerusalem',
}))
console.log('payload written')
