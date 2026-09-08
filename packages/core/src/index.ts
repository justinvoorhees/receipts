/**
 * @tca/core — public surface.
 *
 * The single on-demand entry point for the receipts tool: paste a tx hash,
 * get a `Receipt` (or `null`).
 */
export { analyzeTransaction, type Receipt } from './analyzeTransaction.js';
export { resolveContractName, enrichFeeSinkNames, type FeeSinkNamed, type NameResolverDeps } from './contractNames.js';
export { buildFeeSinks, type FeeSinkOut } from './decomposeRoute.js';
export { classifyTransaction } from './classifyTransaction.js';
export type { AnalyzeFailure, RelayerDetail, FailureReason } from './endpoints.js';
export { resolveAggregator, type AggregatorResolution, type DetectedVia } from './resolveAggregator.js';
export { loadSettlerRegistry, parseDeployerTransfers, type SettlerEntry, type SettlerRegistry } from './settlerRegistry.js';
export { computeMarketPrice, getMarketPriceForPair } from './marketPrice.js';
export type { MarketPriceTier, MarketPriceResult, Estimator } from './marketPrice.js';
// Pure receipt helpers — the ONE definition (also the @fabric-tca/core/pure subpath).
export { anchorsToUsd, baseIsOutputLeg, reconciledResult } from './receiptPure.js';
export { extractFrameChains } from './legFrameChains.js';
export { resolveLegRouter, type ResolvedLegRouter } from './resolveLegRouter.js';
export {
	createMemoryFactCache,
	type FactCache,
	type FactCacheEntries,
	type PoolFact,
	type PoolKeyFact,
	type TokenFact,
} from './factCache.js';
