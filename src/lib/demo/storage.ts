import { CalendarEvent, Task } from '@/types'
import path from 'path'
import { assertSafeUserId } from '@/lib/util/safeUserId'
import { readJsonFile, writeJsonFileAtomic } from '@/lib/util/jsonStore'
import { DATA_DIR } from '@/lib/util/dataDir'

function userDir(userId: string) {
  return path.join(DATA_DIR, 'users', assertSafeUserId(userId))
}

function eventsFile(userId: string) {
  return path.join(userDir(userId), 'events.json')
}

function readEvents(userId: string): CalendarEvent[] {
  return readJsonFile<CalendarEvent[]>(eventsFile(userId), [])
}

function writeEvents(userId: string, events: CalendarEvent[]) {
  writeJsonFileAtomic(eventsFile(userId), events)
}

function tasksFile(userId: string) {
  return path.join(userDir(userId), 'tasks.json')
}

function readTasks(userId: string): Task[] {
  return readJsonFile<Task[]>(tasksFile(userId), [])
}

function writeTasks(userId: string, tasks: Task[]) {
  writeJsonFileAtomic(tasksFile(userId), tasks)
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
