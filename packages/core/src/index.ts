/**
 * @tca/core — public surface.
 *
 * The single on-demand entry point for the receipts tool: paste a tx hash,
 * get a `Receipt` (or `null`).
 */
export { analyzeTransaction, type Receipt } from './analyzeTransaction.js';
export { classifyTransaction } from './classifyTransaction.js';
export type { AnalyzeFailure, RelayerDetail, FailureReason } from './endpoints.js';
export { resolveAggregator, type AggregatorResolution, type DetectedVia } from './resolveAggregator.js';
export { loadSettlerRegistry, parseDeployerTransfers, type SettlerEntry, type SettlerRegistry } from './settlerRegistry.js';
export { reconciledResult, computeMarketPrice, getMarketPriceForPair } from './marketPrice.js';
export type { MarketPriceTier, MarketPriceResult, Estimator } from './marketPrice.js';
export { anchorsToUsd } from './pricing.js';
export { baseIsOutputLeg } from './analyzeTransaction.js';
