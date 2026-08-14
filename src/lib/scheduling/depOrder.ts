/**
 * depOrder.ts — dependency-aware ordering for a batch of placement requests.
 *
 * `PlacementRequest.dependsOn` has existed since the engine was written, with the
 * comment "Reserved for projects: ids of requests that must be placed before this
 * one" — and until now nothing read it. This file reads it.
 *
 * Addressing: `dependsOn` holds `ref.id` values, matched against the `ref.id` of
 * other requests in the SAME batch. An id that is not in the batch — work in
 * another project, or a prerequisite already finished — is ignored rather than
 * treated as unsatisfiable. Finished work imposes no ordering.
 *
 * Kahn's algorithm, not DFS post-order, and the difference is load-bearing: DFS
 * would let a long dependency chain jump ahead of a tight deadline that has no
 * dependencies at all. Kahn keeps the engine's existing most-constrained-first
 * rule deciding among everything currently unblocked, which is the behaviour
 * orderRequests already promises.
 */

import { PlacementRequest } from './types'

export interface TopoResult {
  /** Every index exactly once — a total order, cycles included. */
  order: number[]
  /** Indices caught in a dependency cycle. Empty when the graph is a DAG. */
  cycle: number[]
}

/**
 * Orders `preferred` (already sorted by the caller's own comparator) so that every
 * request appears after the requests it depends on.
 *
 * Returns `preferred` untouched — the same values in the same positions — when no
 * request has a dependency that resolves inside the batch. That identity is what
 * makes this safe to drop into the engine's hot path: with today's inputs, which
 * never carry `dependsOn`, the output cannot differ.
 */
export function topoOrder(requests: PlacementRequest[], preferred: number[]): TopoResult {
  // ref.id -> index. A duplicate id would make "depends on X" ambiguous, so the
  // FIRST wins deterministically rather than the last silently overwriting.
  const indexByRefId = new Map<string, number>()
  for (let i = 0; i < requests.length; i++) {
    const id = requests[i]?.ref?.id
    if (id && !indexByRefId.has(id)) indexByRefId.set(id, i)
  }

  // Edges that actually resolve inside this batch. Self-dependencies are dropped:
  // they are always a data bug and would otherwise deadlock the whole graph.
  const prerequisites: number[][] = requests.map(() => [])
  let edgeCount = 0
  for (let i = 0; i < requests.length; i++) {
    for (const depId of requests[i]?.dependsOn ?? []) {
      const from = indexByRefId.get(depId)
      if (from === undefined || from === i) continue
      prerequisites[i].push(from)
      edgeCount++
    }
  }

  if (edgeCount === 0) return { order: preferred, cycle: [] }

  const remaining = prerequisites.map(list => new Set(list))
  const dependents: number[][] = requests.map(() => [])
  for (let i = 0; i < requests.length; i++) {
    for (const from of remaining[i]) dependents[from].push(i)
  }

  const order: number[] = []
  const placed = new Set<number>()

  // Walking `preferred` on each pass keeps the comparator in charge of which of
  // several ready requests goes first, which is the whole point of the algorithm
  // choice above. O(n^2) on the batch size, and a batch is a project's task list.
  let progressed = true
  while (progressed && order.length < preferred.length) {
    progressed = false
    for (const idx of preferred) {
      if (placed.has(idx) || remaining[idx].size > 0) continue
      placed.add(idx)
      order.push(idx)
      for (const dependent of dependents[idx]) remaining[dependent].delete(idx)
      progressed = true
    }
  }

  if (order.length === preferred.length) return { order, cycle: [] }

  // Whatever is left is in (or downstream of) a cycle. The engine must stay total,
  // so those are appended in comparator order with their dependencies ignored, and
  // reported. Refusing a cycle is the caller's job — that is where there is a user
  // to tell which two tasks point at each other.
  const cycle = preferred.filter(idx => !placed.has(idx))
  return { order: [...order, ...cycle], cycle }
}
