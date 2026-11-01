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
test('unknown model, missing cache-write price, free model and missing usage stay distinct', () => {
  assert.equal(calc(header(0, 'new-model'), message(1, { inputTokens: 100, outputTokens: 10 })).unpriced, 110)
  assert.equal(calc(header(0, 'deepseek-v4.1-flash-suffix'), message(1, { inputTokens: 100, outputTokens: 10 })).priced, 0)
  const partial = calc(header(0), message(1, { inputTokens: 100, outputTokens: 10, cacheWriteTokens: 30 }))
  assert.equal(partial.unpriced, 30)
  assert.match(partial.summary, /\+\?/)
  assert.equal(calc(header(0, 'beam-free', 'opencode'), message(1, { inputTokens: 100, outputTokens: 10 })).summary, 'Zen ≈$0')
  assert.match(calc(header(0), message(1)).text, /1 responses have no usable/)
  assert.match(calc(header(0), message(1, { inputTokens: NaN, outputTokens: 10 })).summary, /unpriced/)
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
