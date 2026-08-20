import { CalendarEvent, Phase, Place, Project, Task } from '@/types'
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

function phasesFile(userId: string) {
  return path.join(userDir(userId), 'phases.json')
}

function readPhases(userId: string): Phase[] {
  return readJsonFile<Phase[]>(phasesFile(userId), [])
}

function writePhases(userId: string, phases: Phase[]) {
  writeJsonFileAtomic(phasesFile(userId), phases)
}

function placesFile(userId: string) {
  return path.join(userDir(userId), 'places.json')
}

function readPlaces(userId: string): Place[] {
  return readJsonFile<Place[]>(placesFile(userId), [])
}

function writePlaces(userId: string, places: Place[]) {
  writeJsonFileAtomic(placesFile(userId), places)
}

function projectsFile(userId: string) {
  return path.join(userDir(userId), 'projects.json')
}

function readProjects(userId: string): Project[] {
  return readJsonFile<Project[]>(projectsFile(userId), [])
}

function writeProjects(userId: string, projects: Project[]) {
  writeJsonFileAtomic(projectsFile(userId), projects)
}

/**
 * The real, production event/task store — every logged-in user's data lives here,
 * under `<DATA_DIR>/users/<id>/`. It was once called `demoStorage`, which is why
 * `DEMO_MODE` leaked into auth checks; the name was wrong, the storage never was.
 *
 * Deliberately synchronous: each method is a read-modify-write that completes
 * within one turn of the event loop, so it is already atomic in-process and needs
 * no lock (see `lock.ts`). Do not make these async.
 */
export const userStore = {
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

  // ── Projects ──────────────────────────────────────────────────────────────
  //
  // Same synchronous read-modify-write discipline as above, with one deliberate
  // difference: updateProject/deleteProject REPORT whether they found anything.
  // `updateTask` returns nothing and writes the file back even on a miss, which
  // is why PUT /api/tasks/[id] answers `{success:true}` for an id that does not
  // exist and the client's res.ok rollback can never fire. Not copying that.

  getProjects(userId = 'demo'): Project[] {
    return readProjects(userId)
  },
  addProject(project: Project, userId = 'demo') {
    const projects = readProjects(userId)
    projects.push(project)
    writeProjects(userId, projects)
  },
  /** Returns the updated project, or null if no such id — and writes nothing on a miss. */
  updateProject(id: string, updates: Partial<Project>, userId = 'demo'): Project | null {
    const projects = readProjects(userId)
    const idx = projects.findIndex(p => p.id === id)
    if (idx === -1) return null
    projects[idx] = { ...projects[idx], ...updates, id, user_id: projects[idx].user_id }
    writeProjects(userId, projects)
    return projects[idx]
  },
  /** Returns true if a project was actually removed. */
  deleteProject(id: string, userId = 'demo'): boolean {
    const projects = readProjects(userId)
    const next = projects.filter(p => p.id !== id)
    if (next.length === projects.length) return false
    writeProjects(userId, next)
    return true
  },

  // ── Phases ────────────────────────────────────────────────────────────────
  //
  // No migration and no bootstrap: a missing phases.json reads as [], getActivePhase
  // returns null, and every phase-aware read path degrades to exactly today's
  // behaviour. The first transition the user declares creates the OUTGOING phase
  // retroactively and then opens the new one — the bootstrap path IS the close+open
  // path, so there is only one code path to get right.

  getPhases(userId = 'demo'): Phase[] {
    return readPhases(userId)
  },
  /** The open phase, or null when the user has never declared one. */
  getActivePhase(userId = 'demo'): Phase | null {
    return readPhases(userId).find(p => p.status === 'active') ?? null
  },
  addPhase(phase: Phase, userId = 'demo') {
    const phases = readPhases(userId)
    phases.push(phase)
    writePhases(userId, phases)
  },
  /** Returns the updated phase, or null if no such id — and writes nothing on a miss. */
  updatePhase(id: string, updates: Partial<Phase>, userId = 'demo'): Phase | null {
    const phases = readPhases(userId)
    const idx = phases.findIndex(p => p.id === id)
    if (idx === -1) return null
    phases[idx] = { ...phases[idx], ...updates, id, user_id: phases[idx].user_id }
    writePhases(userId, phases)
    return phases[idx]
  },

  // ── Places ────────────────────────────────────────────────────────────────
  //
  // Same no-migration contract as phases and projects: a missing places.json
  // reads as [], no event carries a place_id, and every travel-aware path
  // degrades to exactly the behaviour that predates this table.

  getPlaces(userId = 'demo'): Place[] {
    return readPlaces(userId)
  },
  /** The declared home, or null. The default origin when the day says nothing. */
  getHomePlace(userId = 'demo'): Place | null {
    return readPlaces(userId).find(p => p.is_home) ?? null
  },
  addPlace(place: Place, userId = 'demo') {
    const places = readPlaces(userId)
    places.push(place)
    writePlaces(userId, places)
  },
  /** Returns the updated place, or null if no such id — and writes nothing on a miss. */
  updatePlace(id: string, updates: Partial<Place>, userId = 'demo'): Place | null {
    const places = readPlaces(userId)
    const idx = places.findIndex(p => p.id === id)
    if (idx === -1) return null
    places[idx] = { ...places[idx], ...updates, id, user_id: places[idx].user_id }
    writePlaces(userId, places)
    return places[idx]
  },
  /**
   * Removes the place AND every reference to it, because a `place_id` pointing at
   * nothing is worse than no place at all: the travel lookup would silently find
   * no entry and quietly stop reserving time, with nothing on screen to say so.
   */
  deletePlace(id: string, userId = 'demo'): boolean {
    const places = readPlaces(userId)
    const next = places.filter(p => p.id !== id)
    if (next.length === places.length) return false

    // Any OTHER place that declared a travel time from this one loses that pair.
    for (const p of next) {
      if (p.travel_from && id in p.travel_from) {
        const rest = { ...p.travel_from }
        delete rest[id]
        p.travel_from = rest
      }
    }
    writePlaces(userId, next)

    const events = readEvents(userId)
    let touched = false
    for (const e of events) {
      if (e.place_id === id) { delete e.place_id; touched = true }
    }
    if (touched) writeEvents(userId, events)
    return true
  },
}
