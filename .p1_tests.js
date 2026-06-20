// Generates payloads + parses results for Phase 1 live verification.
const fs = require('fs')
const mode = process.argv[2]

if (mode === 'gen-breakdown') {
  // 8h study task, 2-week window → should SPREAD across non-consecutive days.
  fs.writeFileSync('./.vc.json', JSON.stringify({
    messages: [{ role: 'user', content: 'תפרק לי משימה: ללמוד למבחן, בערך 8 שעות סך הכל, פזר את זה עד עוד שבועיים. תקבע את הסשנים.' }],
    events: [], profile: { user_id: 'x', autonomy_mode: 'auto', scheduling_method: 'time_blocking', productivity_peak: 'morning', wake_time: '07:00', sleep_time: '23:00' },
    memory: [], tasks: [], timezone: 'Asia/Jerusalem',
  }))
} else if (mode === 'gen-propose') {
  // NO profile, NO method → should still PROPOSE concretely, not interrogate.
  fs.writeFileSync('./.vc.json', JSON.stringify({
    messages: [{ role: 'user', content: 'יש לי שבוע עמוס, תארגן לי אותו' }],
    events: [], profile: null, memory: [], tasks: [], timezone: 'Asia/Jerusalem',
  }))
} else if (mode === 'parse-breakdown') {
  const t = fs.readFileSync('./.oc.txt', 'utf8')
  let cr = [], rp = ''
  for (const l of t.split('\n').filter(l => l.startsWith('data: '))) {
    try { const o = JSON.parse(l.slice(6)); if (o.type === 'events' && o.createdEvents) cr = o.createdEvents; if (o.type === 'text') rp += o.content } catch {}
  }
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
  const dates = cr.map(e => e.start_time.slice(0, 10))
  const uniq = new Set(dates)
  console.log('sessions created:', cr.length)
  cr.forEach(e => console.log('  ', days[new Date(e.start_time).getDay()], e.start_time.slice(0, 16)))
  console.log('distinct days:', uniq.size, '| same-day doubles:', dates.length - uniq.size)
  // sorted gap between consecutive distinct days
  const sortedDays = [...uniq].sort()
  console.log('SPREAD GOOD (>=2 sessions, mostly 1/day):', cr.length >= 2 && uniq.size >= Math.min(cr.length, 3) ? 'YES' : 'CHECK')
  console.log('reply:', rp.slice(0, 160))
} else if (mode === 'parse-propose') {
  const t = fs.readFileSync('./.oc.txt', 'utf8')
  let cr = [], rp = ''
  for (const l of t.split('\n').filter(l => l.startsWith('data: '))) {
    try { const o = JSON.parse(l.slice(6)); if (o.type === 'events' && o.createdEvents) cr = o.createdEvents; if (o.type === 'text') rp += o.content } catch {}
  }
  const interrogates = /איך אתה מעדיף|מתי נוח לך|כמה זמן|באיזה ימים אתה מעדיף|מה הדברים|תפרט|איזה משימות יש/.test(rp)
  const concrete = cr.length > 0 || /\d{1,2}:\d{2}|ראשון|שני|שלישי|רביעי|חמישי/.test(rp)
  console.log('events created:', cr.length)
  console.log('reply:', rp)
  console.log('PROPOSED CONCRETELY:', concrete ? 'YES' : 'NO', '| interrogated:', interrogates ? 'YES (bad)' : 'no (good)')
}
