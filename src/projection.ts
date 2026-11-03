import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { TokenBucket } from './types.js'

const count = z.number().finite().nonnegative()
const bucketSchema = z.object({ input: count, output: count, cacheRead: count, cacheWrite: count })
const pairSchema = z.object({ peak: bucketSchema, idle: bucketSchema })
export const stateSchema = z.object({
  lastSeq: z.number().int(), inherited: count,
  provider: z.string(), model: z.string(),
  rows: z.array(z.object({
    provider: z.string(), model: z.string(), requests: count,
    buckets: pairSchema.extend({ byInputTokens: z.record(z.string(), pairSchema) }),
  })),
})
export type CostState = z.infer<typeof stateSchema>
export const KEY = 'opencodeCost'
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { opencodeCost: CostState }
}

export const emptyBucket = (): TokenBucket => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
const pair = () => ({ peak: emptyBucket(), idle: emptyBucket() })
export function initialState(inherited = 0): CostState {
  return { lastSeq: -1, inherited, provider: '', model: '', rows: [] }
}
export function isPeak(time: number): boolean {
  const date = new Date(time + 8 * 3_600_000)
  const day = date.getUTCDay(), hour = date.getUTCHours()
  return day >= 1 && day <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18))
}
function add(a: TokenBucket, b: TokenBucket): TokenBucket {
  return { input: a.input + b.input, output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite }
}
// Only the price-table context boundaries matter. A fixed histogram avoids
// retaining one bucket for every distinct request size in a long conversation.
function sizeBand(input: number): number {
  let band = 0
  for (const limit of [100_000, 200_000, 256_000, 272_000, 512_000]) {
    if (input > limit) band = limit + 1
  }
  return band
}
interface Usage {
  readonly inputTokens?: unknown
  readonly outputTokens?: unknown
  readonly cacheReadTokens?: unknown
  readonly cacheWriteTokens?: unknown
}
const validCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
/** Normalize one durable assistant-message sample, rejecting unusable counters. */
function usable(usage: Usage | undefined): TokenBucket | undefined {
  if (usage === undefined || usage === null) return undefined
  if (!validCount(usage.inputTokens) || !validCount(usage.outputTokens)) return undefined
  if (usage.cacheReadTokens !== undefined && !validCount(usage.cacheReadTokens)) return undefined
  if (usage.cacheWriteTokens !== undefined && !validCount(usage.cacheWriteTokens)) return undefined
  return { input: usage.inputTokens, output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens ?? 0, cacheWrite: usage.cacheWriteTokens ?? 0 }
}
function record(state: CostState, provider: string, model: string, delta: TokenBucket, time: number): CostState {
  const window = isPeak(time) ? 'peak' : 'idle'
  const index = state.rows.findIndex(row => row.provider === provider && row.model === model)
  const previous = state.rows[index] ?? { provider, model,
    requests: 0, buckets: { ...pair(), byInputTokens: {} } }
  const key = String(sizeBand(delta.input + delta.cacheRead + delta.cacheWrite))
  const size = previous.buckets.byInputTokens[key] ?? pair()
  const next = { ...previous, requests: previous.requests + 1, buckets: {
    ...previous.buckets, [window]: add(previous.buckets[window], delta),
    byInputTokens: { ...previous.buckets.byInputTokens, [key]: { ...size, [window]: add(size[window], delta) } },
  } }
  const rows = [...state.rows]
  if (index < 0) rows.push(next)
  else rows[index] = next
  return { ...state, rows }
}
// DSH's native cost folds durable `assistant/message.usage` only: one books
// exactly one request. Failed attempts (`assistant/attempt`), compaction
// summaries, title generation and fork branches are outside that contract, so
// this projection deliberately does not widen the count.
export function fold(state: CostState, event: SessionEvent): CostState {
  if (event.seq <= state.lastSeq) return state
  if (event.type === 'request/header') {
    return { ...state, lastSeq: event.seq,
      provider: event.data.header.config.provider, model: event.data.header.config.model }
  }
  if (event.type !== 'assistant/message' || event.seq < state.inherited) return state
  const delta = usable(event.data.usage)
  // Messages whose adapter reported no usable usage are dropped: there is no
  // amount to attribute, and a cryptic partial marker made the field harder to
  // read than the omission it described.
  if (delta === undefined) return { ...state, lastSeq: event.seq }
  return record({ ...state, lastSeq: event.seq }, state.provider, state.model, delta, event.time)
}
export const projection: ProjectionDefinition<typeof KEY> = {
  key: KEY, stateVersion: 2,
  // DSH rc.2/rc.3 types pin Zod 4.4 internals; the registry only calls parse().
  // Keep the plugin on patched Zod without replacing the host's dependency.
  stateSchema: stateSchema as unknown as ProjectionDefinition<typeof KEY>['stateSchema'],
  init: (_header, inherited) => initialState(inherited), apply: fold,
}
