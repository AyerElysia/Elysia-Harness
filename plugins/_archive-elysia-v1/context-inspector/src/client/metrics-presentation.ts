/** Display-only arithmetic and safety checks; API reports never calibrate the estimate. */
import type { ContextMetrics } from '../metrics-types.ts'

export function consistentEstimate(metrics: ContextMetrics): boolean {
  const estimate = metrics.estimate
  const numbers = [estimate.systemTokens, estimate.toolsTokens, estimate.messageTokens, estimate.totalTokens]
  return numbers.every(value => Number.isSafeInteger(value) && value >= 0)
    && estimate.totalTokens === estimate.systemTokens + estimate.toolsTokens + estimate.messageTokens
}

export function compactTokens(value: number): string {
  if (value < 1000) return value.toLocaleString()
  if (value < 1_000_000) return String(Math.round(value / 100) / 10) + 'K'
  return String(Math.round(value / 100_000) / 10) + 'M'
}
