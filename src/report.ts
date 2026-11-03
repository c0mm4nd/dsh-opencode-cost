import { mergeStates } from './aggregate.js'
import { estimateOpenCodeCost, tokenTotal, type OpenCodeProvider } from './pricing.js'
import type { CostState } from './projection.js'

export type ProviderMap = Record<string, OpenCodeProvider>
export function providerFor(provider: string, mapping: ProviderMap): OpenCodeProvider | undefined {
  if (Object.hasOwn(mapping, provider)) return mapping[provider]
  if (provider === 'opencode-go') return 'opencode-go'
  if (provider === 'opencode' || provider === 'opencode-zen') return 'opencode'
  return undefined
}
const money = (amount: number) => amount === 0 ? '0' : amount < 0.0001 ? amount.toExponential(2) : amount.toFixed(4)
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`
export interface ReportOptions {
  /** Nested subagent sessions folded into the total. */
  readonly subagents?: number
  /** How many of those subagents are still running. */
  readonly running?: number
}
export function report(states: CostState | readonly CostState[], providers: ProviderMap, options: ReportOptions = {}) {
  const state = mergeStates(Array.isArray(states) ? states : [states])
  if (state === undefined) {
    return { amount: 0, unpriced: 0, priced: 0, cacheAmount: 0, nonCacheAmount: 0,
      summary: '—', subagents: 0,
      text: 'OpenCode cost projection is unavailable.' }
  }
  const subagents = options.subagents ?? 0
  const running = options.running ?? 0
  let amount = 0, unpriced = 0, priced = 0, cacheAmount = 0, nonCacheAmount = 0
  const labels = new Set<string>()
  const lines: string[] = []
  for (const row of state.rows) {
    const provider = providerFor(row.provider, providers)
    const estimate = provider ? estimateOpenCodeCost(provider, row.model, row.buckets)
      : { amount: 0, pricedTokens: 0, unpricedTokens: tokenTotal(row.buckets.peak) + tokenTotal(row.buckets.idle),
        cacheAmount: 0, nonCacheAmount: 0 }
    amount += estimate.amount
    unpriced += estimate.unpricedTokens
    priced += estimate.pricedTokens
    cacheAmount += estimate.cacheAmount
    nonCacheAmount += estimate.nonCacheAmount
    if (provider) labels.add(provider === 'opencode-go' ? 'Go' : 'Zen')
    const split = estimate.pricedTokens > 0
      ? `; cache ≈$${money(estimate.cacheAmount)}, non-cache ≈$${money(estimate.nonCacheAmount)}`
      : ''
    lines.push(`${row.provider || '?'} / ${row.model || '?'}: ${estimate.pricedTokens > 0 ? `≈$${money(estimate.amount)}` : 'unpriced'}; ${row.requests} requests${split}${estimate.unpricedTokens ? `; ${estimate.unpricedTokens} unpriced tokens` : ''}`)
  }
  const active = providerFor(state.provider, providers)
  if (!labels.size && active) labels.add(active === 'opencode-go' ? 'Go' : 'Zen')
  const label = labels.size === 1 ? [...labels][0] : 'OC'
  const summary = `${label} ${priced > 0 ? `≈$${money(amount)}` : state.rows.length ? 'unpriced' : '—'}`
  return { amount, unpriced, priced, cacheAmount, nonCacheAmount, summary, subagents,
    text: [
      `OpenCode Zen / Go — current session${subagents > 0 ? ` + ${plural(subagents, 'subagent session')}` : ''} (USD estimate)`,
      ...lines,
      `Total: ${priced > 0 ? `≈$${money(amount)} (cache ≈$${money(cacheAmount)}, non-cache ≈$${money(nonCacheAmount)})` : 'no priced usage'}${unpriced ? `; ${unpriced} unpriced tokens` : ''}`,
      ...(subagents > 0
        ? [`Includes ${plural(subagents, 'subagent session')} (${running} running, ${subagents - running} finished).`]
        : []),
      'Prices: 2026-10-31 snapshot. Fork-inherited usage is excluded so seeded prefixes are not double-counted.',
      'This is list-priced token usage, not aggregator charges, Go quota usage or remaining allowance.',
    ].join('\n') }
}
