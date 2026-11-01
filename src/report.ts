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
export function report(state: CostState, providers: ProviderMap) {
  let amount = 0, unpriced = 0, priced = 0
  const labels = new Set<string>()
  const lines: string[] = []
  for (const row of state.rows) {
    const provider = providerFor(row.provider, providers)
    const estimate = provider ? estimateOpenCodeCost(provider, row.model, row.buckets)
      : { amount: 0, pricedTokens: 0, unpricedTokens: tokenTotal(row.buckets.peak) + tokenTotal(row.buckets.idle) }
    amount += estimate.amount
    unpriced += estimate.unpricedTokens
    priced += estimate.pricedTokens
    if (provider) labels.add(provider === 'opencode-go' ? 'Go' : 'Zen')
    lines.push(`${row.provider || '?'} / ${row.model || '?'}: ${estimate.pricedTokens > 0 ? `≈$${money(estimate.amount)}` : 'unpriced'}; ${row.requests} requests${estimate.unpricedTokens ? `; ${estimate.unpricedTokens} unpriced tokens` : ''}`)
  }
  const active = providerFor(state.provider, providers)
  if (!labels.size && active) labels.add(active === 'opencode-go' ? 'Go' : 'Zen')
  const label = labels.size === 1 ? [...labels][0] : 'OC'
  const incomplete = unpriced > 0 || state.missingUsage > 0
  const summary = `${label} ${priced > 0 ? `≈$${money(amount)}` : state.rows.length || state.missingUsage ? 'unpriced' : '—'}${incomplete && priced > 0 ? ' +?' : ''}`
  return { amount, unpriced, priced, summary, incomplete,
    text: [
      'OpenCode Zen / Go — current session only (USD estimate)',
      ...lines,
      `Total: ${priced > 0 ? `≈$${money(amount)}` : 'no priced usage'}${unpriced ? `; ${unpriced} unpriced tokens` : ''}`,
      ...(state.missingUsage ? [`${state.missingUsage} responses have no usable token usage.`] : []),
      'Prices: 2026-10-31 snapshot. Excludes subagent sessions and fork-inherited usage.',
      'This is list-priced token usage, not aggregator charges, Go quota usage or remaining allowance.',
    ].join('\n') }
}
