export interface TokenBucket {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}
export interface CostTokenBuckets {
  peak: TokenBucket
  idle: TokenBucket
  byInputTokens?: Record<string, { peak: TokenBucket; idle: TokenBucket }>
}
