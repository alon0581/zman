import { CalendarEvent } from '@/types'
import fs from 'fs'
import path from 'path'

const DATA_DIR = path.join(process.cwd(), 'data')

function userDir(userId: string) {
  return path.join(DATA_DIR, 'users', userId)
}

function eventsFile(userId: string) {
  return path.join(userDir(userId), 'events.json')
}

function ensureUserDir(userId: string) {
  const dir = userDir(userId)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function readEvents(userId: string): CalendarEvent[] {
  try {
    ensureUserDir(userId)
    const file = eventsFile(userId)
    if (!fs.existsSync(file)) return []
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return []
  }
}

function writeEvents(userId: string, events: CalendarEvent[]) {
  ensureUserDir(userId)
  fs.writeFileSync(eventsFile(userId), JSON.stringify(events, null, 2))
}

export const demoStorage = {
  getEvents(userId = 'demo'): CalendarEvent[] {
    return readEvents(userId)
  },
  addEvent(event: CalendarEvent, userId = 'demo') {
    const events = readEvents(userId)
    events.push(event)
    writeEvents(userId, events)
  },
  updateEvent(id: string, updates: Partial<CalendarEvent>, userId = 'demo') {
    const events = readEvents(userId)
    const idx = events.findIndex(e => e.id === id)
    if (idx !== -1) events[idx] = { ...events[idx], ...updates }
    writeEvents(userId, events)
  },
  deleteEvent(id: string, userId = 'demo') {
    writeEvents(userId, readEvents(userId).filter(e => e.id !== id))
  },
}
