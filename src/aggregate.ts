import type { Session } from '@deepseek-ai/dsh-session'
import type { CostState } from './projection.js'

/** A subagent session that already left the store, with the final projection
 * snapshot captured before its disposal. */
export interface Retained {
  readonly parent: string
  readonly state: CostState
}

export interface DescendantStates {
  readonly entries: readonly { id: string; state: CostState }[]
  readonly agents: number
  readonly running: number
}

/** The direct parent a session records only when DSH classified it as a subagent. */
export function subagentParent(session: Session): string | undefined {
  return session.header.origin === 'subagent' && session.header.parentSession !== undefined
    ? String(session.header.parentSession)
    : undefined
}

/** Walk durable parent links to the top-level conversation. */
export function rootIdOf(id: string, parentOf: (id: string) => string | undefined): string {
  let current = id
  // A malformed cycle would otherwise hang the footer; delegation depth is bounded upstream.
  for (let guard = 0; guard < 64; guard++) {
    const parent = parentOf(current)
    if (parent === undefined) return current
    current = parent
  }
  return current
}

/**
 * Collect every nested subagent session under `root`.
 *
 * Live sessions contribute their materialized projection. A finished subagent
 * session is detached from the store, so its last captured state comes from
 * `retained`; both halves are needed for a total that never goes backwards
 * when a child completes.
 */
export function descendantStates(
  root: Session,
  sessions: readonly Session[],
  retained: ReadonlyMap<string, Retained>,
  stateOf: (session: Session) => CostState | undefined,
): DescendantStates {
  const children = new Map<string, Session[]>()
  const parentOf = new Map<string, string>()
  for (const session of sessions) {
    const parent = subagentParent(session)
    if (parent === undefined) continue
    parentOf.set(String(session.id), parent)
    const siblings = children.get(parent) ?? []
    siblings.push(session)
    children.set(parent, siblings)
  }
  const entries: { id: string; state: CostState }[] = []
  const live = new Set<string>()
  const queue = [String(root.id)]
  while (queue.length > 0) {
    const parent = queue.shift()!
    for (const child of children.get(parent) ?? []) {
      const id = String(child.id)
      if (live.has(id)) continue
      live.add(id)
      const state = stateOf(child)
      if (state !== undefined) entries.push({ id, state })
      queue.push(id)
    }
  }
  for (const [id, entry] of retained) {
    if (live.has(id)) continue
    parentOf.set(id, entry.parent)
  }
  const resolve = (id: string) => parentOf.get(id)
  for (const [id, entry] of retained) {
    // Live and retained sets never overlap (creation clears the retained slot),
    // but a resumed id must not be counted twice if that ever changes.
    if (live.has(id)) continue
    if (rootIdOf(id, resolve) !== String(root.id)) continue
    entries.push({ id, state: entry.state })
  }
  const agents = entries.length
  const running = entries.filter(entry => live.has(entry.id)).length
  return { entries, agents, running }
}

function addInto(target: { input: number; output: number; cacheRead: number; cacheWrite: number },
  source: { input: number; output: number; cacheRead: number; cacheWrite: number }) {
  target.input += source.input
  target.output += source.output
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
}

function clonePair(pair: CostState['rows'][number]['buckets']['peak']) {
  return {
    input: pair.input, output: pair.output, cacheRead: pair.cacheRead, cacheWrite: pair.cacheWrite,
  }
}

/** Fold per-session projections into one report-shaped state, keyed by provider and model. */
export function mergeStates(states: readonly CostState[]): CostState | undefined {
  if (states.length === 0) return undefined
  const [first] = states
  if (states.length === 1) return first
  const rows = new Map<string, CostState['rows'][number]>()
  for (const state of states) {
    for (const row of state.rows) {
      const key = `${row.provider}\u0000${row.model}`
      const existing = rows.get(key)
      if (existing === undefined) {
        rows.set(key, {
          provider: row.provider, model: row.model, requests: row.requests,
          buckets: {
            peak: clonePair(row.buckets.peak), idle: clonePair(row.buckets.idle),
            byInputTokens: Object.fromEntries(Object.entries(row.buckets.byInputTokens)
              .map(([band, pair]) => [band, { peak: clonePair(pair.peak), idle: clonePair(pair.idle) }])),
          },
        })
        continue
      }
      existing.requests += row.requests
      addInto(existing.buckets.peak, row.buckets.peak)
      addInto(existing.buckets.idle, row.buckets.idle)
      for (const [band, pair] of Object.entries(row.buckets.byInputTokens)) {
        const target = existing.buckets.byInputTokens[band]
        if (target === undefined) {
          existing.buckets.byInputTokens[band] = { peak: clonePair(pair.peak), idle: clonePair(pair.idle) }
        } else {
          addInto(target.peak, pair.peak)
          addInto(target.idle, pair.idle)
        }
      }
    }
  }
  return { ...first, rows: [...rows.values()] }
}
