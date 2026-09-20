import type { PriceTable } from './types'

/**
 * Cost estimate for one model call.
 *
 * Prices are configured per workspace because every provider charges differently for the
 * same model name. An unpriced model contributes nothing rather than guessing.
 */
export function estimateCost(
  prices: PriceTable,
  providerName: string | null,
  model: string | null,
  tokensIn: number | null,
  tokensOut: number | null,
): number | null {
  if (!model) return null
  const price = prices[`${providerName}:${model}`] ?? prices[model]
  if (!price) return null

  const input = ((tokensIn ?? 0) / 1_000_000) * price.inputPerMillion
  const output = ((tokensOut ?? 0) / 1_000_000) * price.outputPerMillion
  return Number((input + output).toFixed(6))
}
