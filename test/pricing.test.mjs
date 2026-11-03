import test from 'node:test'
import assert from 'node:assert/strict'
import { fold, initialState, isPeak, stateSchema } from '../lib/projection.js'
import { report, providerFor } from '../lib/report.js'

const off = Date.parse('2026-10-31T00:00:00Z')
const peak = Date.parse('2026-10-30T02:00:00Z')
const header = (seq, model = 'deepseek-v4.1-flash', provider = 'my-provider') => ({
  seq, time: off, type: 'request/header', data: { header: { config: { provider, model } } },
})
const message = (seq, usage, time = off) => ({ seq, time, type: 'assistant/message', data: { usage } })
const mapping = { 'my-provider': 'opencode-go' }
const calc = (...events) => report(events.reduce(fold, initialState()), mapping)
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`)

test('aggregator must be explicitly mapped; no guessed aliases', () => {
  assert.equal(providerFor('my-provider', {}), undefined)
  assert.equal(providerFor('my-provider', mapping), 'opencode-go')
  assert.equal(providerFor('opencode-zen', {}), 'opencode')
  assert.equal(providerFor('toString', {}), undefined)
})
test('Go peak/off-peak and Zen rates remain distinct; caches are disjoint', () => {
  const usage = { inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 200_000 }
  close(calc(header(0), message(1, usage)).amount, 0.0216)
  close(calc(header(0), message(1, usage, peak)).amount, 0.0432)
  close(calc(header(0, 'deepseek-v4.1-flash', 'opencode'), message(1, usage)).amount, 0.0432)
  assert.equal(isPeak(Date.parse('2026-10-30T04:00:00Z')), false)
  assert.equal(isPeak(Date.parse('2026-10-30T06:00:00Z')), true)
  assert.equal(isPeak(Date.parse('2026-10-30T10:00:00Z')), false)
  assert.equal(isPeak(Date.parse('2026-10-31T02:00:00Z')), false)
})
test('context tiers use each request including caches, never session totals', () => {
  const h = header(0, 'gpt-6-luna', 'opencode-go')
  const u = { inputTokens: 200_000, outputTokens: 1_000 }
  close(calc(h, message(1, u), message(2, u)).amount, 0.041)
  close(calc(h, message(1, { inputTokens: 272_000, outputTokens: 1_000 })).amount, 0.0277)
  close(calc(h, message(1, { inputTokens: 272_001, outputTokens: 1_000 })).amount, 0.0551502)
  close(calc(h, message(1, { inputTokens: 100_000, cacheReadTokens: 200_000, outputTokens: 1_000 })).amount, 0.02475)
})
test('unknown model, missing cache-write price, free model and unusable usage stay distinct', () => {
  assert.equal(calc(header(0, 'new-model'), message(1, { inputTokens: 100, outputTokens: 10 })).unpriced, 110)
  assert.equal(calc(header(0, 'deepseek-v4.1-flash-suffix'), message(1, { inputTokens: 100, outputTokens: 10 })).priced, 0)
  const partial = calc(header(0), message(1, { inputTokens: 100, outputTokens: 10, cacheWriteTokens: 30 }))
  assert.equal(partial.unpriced, 30)
  // Unpriceable tokens lower the estimate silently; no cryptic partial marker.
  assert.doesNotMatch(partial.summary, /\+\?/)
  assert.match(partial.text, /30 unpriced tokens/)
  assert.equal(calc(header(0, 'beam-free', 'opencode'), message(1, { inputTokens: 100, outputTokens: 10 })).summary, 'Zen ≈$0')
  // A message with no usable usage contributes nothing and is not reported.
  assert.equal(calc(header(0), message(1)).summary, 'Go —')
  assert.doesNotMatch(calc(header(0), message(1)).text, /no usable/)
  assert.equal(calc(header(0), message(1, { inputTokens: NaN, outputTokens: 10 })).summary, 'Go —')
})
test('replay deduplicates, attributes model changes, ignores inherited fork usage and stays JSON safe', () => {
  const events = [header(0), message(1, { inputTokens: 100_000, outputTokens: 0 }),
    header(2, 'gpt-6-luna', 'opencode'), message(3, { inputTokens: 100_000, outputTokens: 0 })]
  const state = events.reduce(fold, initialState())
  assert.deepEqual(events.reduce(fold, state), state)
  close(report(state, mapping).amount, 0.025)
  assert.deepEqual(stateSchema.parse(JSON.parse(JSON.stringify(state))), state)
  close(report(events.reduce(fold, initialState(2)), mapping).amount, 0.01)
  assert.equal(fold(state, { seq: 4, type: 'user/message', data: {} }), state)
})
test('histogram stays bounded for long sessions with different request sizes', () => {
  let state = fold(initialState(), header(0, 'gpt-6-luna', 'opencode'))
  for (let i = 1; i <= 10_000; i++) state = fold(state, message(i, { inputTokens: i * 60, outputTokens: 1 }))
  assert.equal(state.rows[0].requests, 10_000)
  assert.equal(Object.keys(state.rows[0].buckets.byInputTokens).length, 6)
})
const attempt = (seq, usage, time = off) => ({ seq, time, type: 'assistant/attempt',
  data: { turn: 1, step: 1, stream: usage === undefined ? [] : [{ type: 'chunk', time, chunk: { type: 'usage', usage } }] } })
const compaction = (seq, usage, time = off) => ({ seq, time, type: 'compaction/summary',
  data: { compactionId: 'c1', summary: [], shadowedRange: { start: 0, end: 1 }, shadowedSeqs: [], shadowedTokenCount: 0,
    provider: 'my-provider', model: 'deepseek-v4.1-flash', usage } })
// DSH's native cost books durable assistant-message usage only. Attempts,
// compaction summaries and stream-only samples stay outside the count.
test('scope matches the native DSH cost fold', () => {
  const usage = { inputTokens: 100_000, outputTokens: 10_000 }
  const scoped = calc(header(0),
    attempt(1, { inputTokens: 1_000_000, outputTokens: 0 }),
    message(2, usage),
    compaction(3, { inputTokens: 500_000, outputTokens: 0 }))
  close(scoped.amount, 0.021)
  assert.equal(scoped.priced, 110_000)
  assert.match(scoped.text, /; 1 requests/)
})
test('splits the estimate into cache and non-cache spend', () => {
  const usage = { inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 200_000 }
  const r = calc(header(0), message(1, usage))
  close(r.cacheAmount, 0.0006)
  close(r.nonCacheAmount, 0.021)
  assert.match(r.text, /cache ≈\$0\.0006, non-cache ≈\$0\.0210/)
  assert.match(r.text, /Total: ≈\$0\.0216 \(cache ≈\$0\.0006, non-cache ≈\$0\.0210\)/)
  // Cache writes are cache spend even though they price at the miss rate.
  const write = calc(header(0, 'kimi-k3'),
    message(1, { inputTokens: 1_000, outputTokens: 0, cacheWriteTokens: 1_000_000 }))
  close(write.cacheAmount, 3)
  close(write.nonCacheAmount, 0.003)
})
