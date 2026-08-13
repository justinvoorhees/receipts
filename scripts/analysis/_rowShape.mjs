/**
 * A live Receipt in the snake_case row shape the analysis scripts inherited from
 * the DB dump.
 *
 * This exists so migrating off corpus.json is a loader swap rather than five
 * rewritten analyses: every column those scripts read has a direct counterpart
 * on the Receipt. Leg objects pass through UNTRANSLATED — corpus stored them
 * camelCase, identical to what the decoder emits, so touching them here would
 * introduce a difference that does not exist.
 *
 * `_receipt` carries the whole live receipt for anything this map omits; prefer
 * reading it over widening the map, which exists to serve the legacy shape and
 * should not grow.
 */
export function receiptToRow(receipt, corpusId) {
	return {
		id: corpusId,
		tx_hash: receipt.txHash,
		chain_id: receipt.chainId,
		block_number: receipt.blockNumber,
		aggregator: receipt.aggregator,
		notional_usd: receipt.notionalUsd,
		tier: receipt.tier,
		pricing_status: receipt.pricingStatus,
		all_in_cost_bps: receipt.allInCostBps,
		slippage_bps: receipt.slippageBps,
		recon_residual_bps: receipt.reconResidualBps,
		decomp_confidence: receipt.decompConfidence,
		route_shape: receipt.routeShape,
		normalize_flags: receipt.normalizeFlags,
		route_legs: receipt.routeLegs,
		_receipt: receipt,
	};
}
