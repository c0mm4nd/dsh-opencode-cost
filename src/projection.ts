import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { TokenBucket } from './types.js'

const count = z.number().finite().nonnegative()
const bucketSchema = z.object({ input: count, output: count, cacheRead: count, cacheWrite: count })
const pairSchema = z.object({ peak: bucketSchema, idle: bucketSchema })
export const stateSchema = z.object({
  lastSeq: z.number().int(), inherited: count,
  provider: z.string(), model: z.string(), missingUsage: count,
  rows: z.array(z.object({
    provider: z.string(), model: z.string(), requests: count,
    buckets: pairSchema.extend({ byInputTokens: z.record(z.string(), pairSchema) }),
  })),
})
export type CostState = z.infer<typeof stateSchema>
export const KEY = 'opencodeCost'
declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap { opencodeCost: CostState }
}

export const emptyBucket = (): TokenBucket => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
const pair = () => ({ peak: emptyBucket(), idle: emptyBucket() })
export function initialState(inherited = 0): CostState {
  return { lastSeq: -1, inherited, provider: '', model: '', missingUsage: 0, rows: [] }
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
export function fold(state: CostState, event: SessionEvent): CostState {
  if (event.seq <= state.lastSeq) return state
  if (event.type === 'request/header') {
    return { ...state, lastSeq: event.seq,
      provider: event.data.header.config.provider, model: event.data.header.config.model }
  }
  if (event.type !== 'assistant/message' || event.seq < state.inherited) return state
  const usage = event.data.usage
  if (!usage) return { ...state, lastSeq: event.seq, missingUsage: state.missingUsage + 1 }
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
  if (![usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0].every(valid)) {
    return { ...state, lastSeq: event.seq, missingUsage: state.missingUsage + 1 }
  }
  const delta = { input: usage.inputTokens, output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens ?? 0, cacheWrite: usage.cacheWriteTokens ?? 0 }
  const window = isPeak(event.time) ? 'peak' : 'idle'
  const index = state.rows.findIndex(row => row.provider === state.provider && row.model === state.model)
  const previous = state.rows[index] ?? { provider: state.provider, model: state.model,
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
  return { ...state, lastSeq: event.seq, rows }
}
export const projection: ProjectionDefinition<typeof KEY> = {
  key: KEY, stateVersion: 1,
  // DSH rc.2/rc.3 types pin Zod 4.4 internals; the registry only calls parse().
  // Keep the plugin on patched Zod without replacing the host's dependency.
  stateSchema: stateSchema as unknown as ProjectionDefinition<typeof KEY>['stateSchema'],
  init: (_header, inherited) => initialState(inherited), apply: fold,
}
