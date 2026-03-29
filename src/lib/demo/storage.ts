import { CalendarEvent, Task } from '@/types'
import fs from 'fs'
import path from 'path'

const DATA_DIR = path.join(process.cwd(), 'data')

const SAFE_ID_RE = /^[0-9a-f-]+$/i
function userDir(userId: string) {
  if (!SAFE_ID_RE.test(userId)) throw new Error(`Invalid userId: ${userId}`)
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

function tasksFile(userId: string) {
  return path.join(userDir(userId), 'tasks.json')
}

function readTasks(userId: string): Task[] {
  try {
    ensureUserDir(userId)
    const file = tasksFile(userId)
    if (!fs.existsSync(file)) return []
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return []
  }
}

function writeTasks(userId: string, tasks: Task[]) {
  ensureUserDir(userId)
  fs.writeFileSync(tasksFile(userId), JSON.stringify(tasks, null, 2))
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
  getTasks(userId = 'demo'): Task[] {
    return readTasks(userId)
  },
  addTask(task: Task, userId = 'demo') {
    const tasks = readTasks(userId)
    tasks.push(task)
    writeTasks(userId, tasks)
  },
  updateTask(id: string, updates: Partial<Task>, userId = 'demo') {
    const tasks = readTasks(userId)
    const idx = tasks.findIndex(t => t.id === id)
    if (idx !== -1) tasks[idx] = { ...tasks[idx], ...updates }
    writeTasks(userId, tasks)
  },
  deleteTask(id: string, userId = 'demo') {
    writeTasks(userId, readTasks(userId).filter(t => t.id !== id))
  },
}
