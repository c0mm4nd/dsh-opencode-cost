/** OpenCode published USD / million-token prices, snapshot 2026-10-31.
 * https://opencode.ai/v2/docs/console/models#pricing
 * https://opencode.ai/v2/docs/console/go#usage-limits
 * These estimate list-priced usage, NOT balance charges or Go allowance.
 * Exact model ids only: an unknown/new alias must remain unpriced.
 */
import type { CostTokenBuckets, TokenBucket } from './types.js'

export type OpenCodeProvider = 'opencode' | 'opencode-go'
type Rates = readonly [input: number, output: number, cacheRead?: number, cacheWrite?: number]
interface Price {
  rates: Rates
  offPeak?: Rates
  context?: { above: number; rates: Rates }
}
const flat = (rates: Rates): Price => ({ rates })
const tier = (above: number, rates: Rates, higher: Rates): Price => ({ rates, context: { above, rates: higher } })
const free = flat([0, 0, 0, 0])

const GO: Readonly<Record<string, Price>> = {
  'glm-5.3-flash': flat([0.15, 0.50, 0.03]),
  'glm-5.3': flat([1.40, 4.40, 0.26]),
  'glm-5.2': flat([1.40, 4.40, 0.26]),
  'kimi-k3.1-pro': flat([2, 10, 0.20, 2]),
  'kimi-k3': flat([3, 15, 0.30, 3]),
  'kimi-k2.7-code': flat([0.95, 4, 0.19]),
  'longcat-2.0': flat([0.30, 1.20, 0.006]),
  'step-5-preview': flat([1, 2.70, 0.10]),
  'beam-free': free,
  'iceman-contributor-free': free,
  'mimo-v2.6-flash': flat([0.14, 0.28, 0.0028]),
  'mimo-v2.6-pro': flat([0.435, 0.87, 0.003625]),
  'mimo-v2.5': flat([0.14, 0.28, 0.0028]),
  'mimo-v2.5-pro': flat([0.435, 0.87, 0.003625]),
  'minimax-m3.1-flash': flat([0.15, 0.60, 0.015]),
  'minimax-m3': tier(512_000, [0.30, 1.20, 0.06], [0.60, 2.40, 0.12]),
  'muse-spark-1.3-contributor': flat([0.10, 0.20, 0.002]),
  'muse-spark-1.2-contributor': flat([0.10, 0.20, 0.002]),
  'qwen3.8-max': flat([2, 6, 0.25, 2.50]),
  'qwen3.8-flash': flat([0.15, 0.47, 0.016, 0.20]),
  'qwen3.7-plus': tier(256_000, [0.40, 1.60, 0.04, 0.50], [1.20, 4.80, 0.12, 1.50]),
  'deepseek-v4.1-flash': { rates: [0.30, 1.20, 0.006], offPeak: [0.15, 0.60, 0.003] },
  'deepseek-v4-pro': { rates: [1.32, 3.96, 0.044], offPeak: [0.66, 1.98, 0.022] },
  'hy4-preview': flat([0.834, 2.501, 0.042]),
  'hy3': flat([0.14, 0.58, 0.035]),
  'grok-4.7': tier(200_000, [2, 6, 0.50], [4, 12, 1]),
  'gpt-6-luna': tier(272_000, [0.10, 0.50, 0.01, 0.125], [0.20, 0.75, 0.02, 0.25]),
  'gpt-5.6-luna': tier(272_000, [0.20, 1.20, 0.02, 0.25], [0.40, 1.80, 0.04, 0.50]),
  'claude-haiku-5-5': tier(100_000, [0.10, 0.50, 0.01, 0.125], [0.50, 2.50, 0.05, 0.625]),
  // Published 50% discount through 2026-11-30; this is a dated snapshot.
  'gemini-4-argon': flat([2, 10, 0.10]),
}

const ZEN: Readonly<Record<string, Price>> = {
  'big-pickle': free,
  'glm-5.3-flash-free': free,
  'deepseek-v4.1-flash-free': free,
  'beam-free': free,
  'flint-40b-free': free,
  'mimo-v2.6-flash-free': free,
  'nemotron-3-ultra-free': free,
  'nemotron-3.5-lightning-free': free,
  'nemotron-3.5-super-vl-free': free,
  'minimax-m3': flat([0.30, 1.20, 0.06]),
  'minimax-m2.7': flat([0.30, 1.20, 0.06]),
  'minimax-m2.5': flat([0.30, 1.20, 0.06]),
  'glm-5.3-flash': GO['glm-5.3-flash']!,
  'glm-5.3': GO['glm-5.3']!,
  'glm-5.2': GO['glm-5.2']!,
  'glm-5.1': flat([1.40, 4.40, 0.26]),
  'glm-5': flat([1, 3.20, 0.20]),
  'kimi-k2.7-code': GO['kimi-k2.7-code']!,
  'kimi-k3': GO['kimi-k3']!,
  'kimi-k2.6': flat([0.95, 4, 0.16]),
  'kimi-k2.5': flat([0.60, 3, 0.10]),
  'mistral-large-4': flat([0.68, 2.09, 0.07]),
  'qwen3.8-max': GO['qwen3.8-max']!,
  'qwen3.8-flash': GO['qwen3.8-flash']!,
  'qwen3.6-plus': flat([0.50, 3, 0.05, 0.625]),
  'qwen3.5-plus': flat([0.20, 1.20, 0.02, 0.25]),
  'deepseek-v4.1-flash': flat([0.30, 1.20, 0.006]),
  'deepseek-v4-pro': flat([1.74, 3.48, 0.145]),
  'claude-fable-5-1': flat([10, 50, 0.25, 12.50]),
  'claude-fable-5': flat([10, 50, 1, 12.50]),
  'claude-opus-5-5': flat([4, 20, 0.20, 5]),
  'claude-opus-5': flat([5, 25, 0.50, 6.25]),
  'claude-opus-4-8': flat([5, 25, 0.50, 6.25]),
  'claude-opus-4-7': flat([5, 25, 0.50, 6.25]),
  'claude-opus-4-6': flat([5, 25, 0.50, 6.25]),
  'claude-opus-4-5': flat([5, 25, 0.50, 6.25]),
  'claude-sonnet-5-5': flat([2, 10, 0.20, 2.50]),
  'claude-sonnet-5': flat([2, 10, 0.20, 2.50]),
  'claude-sonnet-4-6': flat([3, 15, 0.30, 3.75]),
  'claude-sonnet-4-5': tier(200_000, [3, 15, 0.30, 3.75], [6, 22.50, 0.60, 7.50]),
  'claude-haiku-5-5': GO['claude-haiku-5-5']!,
  'claude-haiku-4-5': flat([1, 5, 0.10, 1.25]),
  'gemini-4-argon': GO['gemini-4-argon']!,
  'gemini-3.8-flash': flat([1.50, 7.50, 0.15]),
  'gemini-3.7-flash': flat([1.50, 7.50, 0.15]),
  'gemini-3.6-flash': flat([1.50, 7.50, 0.15]),
  'gemini-3.5-flash': flat([1.50, 9, 0.15]),
  'gemini-3.5-flash-lite': flat([0.30, 2.50, 0.03]),
  'gemini-3.1-pro': tier(200_000, [2, 12, 0.20], [4, 18, 0.40]),
  'gemini-3-flash': flat([0.50, 3, 0.05]),
  'grok-4.7': GO['grok-4.7']!,
  'grok-4.6': GO['grok-4.7']!,
  'grok-4.5': tier(200_000, [2, 6, 0.30], [4, 12, 0.60]),
  'grok-build-0.1': flat([1, 2, 0.20]),
  'muse-wonder-1.0': flat([4, 20, 0.20]),
  'muse-spark-1.3': flat([1.25, 4.25, 0.15]),
  'muse-spark-1.2': flat([1.25, 4.25, 0.15]),
  'gpt-6-astra': tier(272_000, [10, 50, 1, 12.50], [20, 75, 2, 25]),
  'gpt-6-sol': tier(272_000, [2, 10, 0.20, 2.50], [4, 15, 0.40, 5]),
  'gpt-6.1-sol': tier(272_000, [2, 10, 0.10, 2.50], [4, 15, 0.20, 5]),
  'gpt-6-luna': GO['gpt-6-luna']!,
  'gpt-5.6-sol': tier(272_000, [4, 20, 0.40, 5], [8, 30, 0.80, 10]),
  'gpt-5.6-terra': tier(272_000, [2, 12, 0.20, 2.50], [4, 18, 0.40, 5]),
  'gpt-5.6-luna': GO['gpt-5.6-luna']!,
  'gpt-5.5': tier(272_000, [5, 30, 0.50], [10, 45, 1]),
  'gpt-5.5-pro': flat([30, 180, 30]),
  'gpt-5.4': tier(272_000, [2.50, 15, 0.25], [5, 22.50, 0.50]),
  'gpt-5.4-pro': flat([30, 180, 30]),
  'gpt-5.4-mini': flat([0.75, 4.50, 0.075]),
  'gpt-5.4-nano': flat([0.20, 1.25, 0.02]),
  'gpt-5.3-codex-spark': flat([1.75, 14, 0.175]),
  'gpt-5.3-codex': flat([1.75, 14, 0.175]),
  'gpt-5.2': flat([1.75, 14, 0.175]),
  'gpt-5.2-codex': flat([1.75, 14, 0.175]),
  'gpt-5.1': flat([1.07, 8.50, 0.107]),
  'gpt-5.1-codex': flat([1.07, 8.50, 0.107]),
  'gpt-5.1-codex-max': flat([1.25, 10, 0.125]),
  'gpt-5.1-codex-mini': flat([0.25, 2, 0.025]),
  'gpt-5': flat([1.07, 8.50, 0.107]),
  'gpt-5-codex': flat([1.07, 8.50, 0.107]),
  'gpt-5-nano': flat([0.05, 0.40, 0.005]),
}

export function tokenTotal(bucket: TokenBucket): number {
  return bucket.input + bucket.output + bucket.cacheRead + bucket.cacheWrite
}

/** Missing cache prices or missing request sizes stay visibly unpriced. */
export function estimateOpenCodeCost(provider: OpenCodeProvider, model: string, buckets: CostTokenBuckets): {
  amount: number; pricedTokens: number; unpricedTokens: number
  /** Priced spend on cache reads plus cache writes. */
  cacheAmount: number
  /** Priced spend on uncached input plus output. */
  nonCacheAmount: number
} {
  const table = provider === 'opencode-go' ? GO : ZEN
  const price = Object.hasOwn(table, model) ? table[model] : undefined
  let amount = 0
  let pricedTokens = 0
  let cacheAmount = 0
  let nonCacheAmount = 0
  const total = tokenTotal(buckets.peak) + tokenTotal(buckets.idle)
  if (price !== undefined) {
    const parts = price.context === undefined
      ? [['0', buckets] as const]
      : Object.entries(buckets.byInputTokens ?? {})
    for (const [input, part] of parts) {
      for (const window of ['peak', 'idle'] as const) {
        const rates = price.context !== undefined && Number(input) > price.context.above
          ? price.context.rates
          : window === 'idle' ? price.offPeak ?? price.rates : price.rates
        const bucket = part[window]
        const tokens = [bucket.input, bucket.output, bucket.cacheRead, bucket.cacheWrite]
        tokens.forEach((count, index) => {
          const rate = rates[index]
          if (rate !== undefined) {
            const cost = count * rate / 1_000_000
            amount += cost
            if (index === 2 || index === 3) cacheAmount += cost
            else nonCacheAmount += cost
            pricedTokens += count
          }
        })
      }
    }
  }
  return { amount, pricedTokens, unpricedTokens: Math.max(0, total - pricedTokens),
    cacheAmount, nonCacheAmount }
}
