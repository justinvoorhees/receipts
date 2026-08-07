import { analyzeTransaction, enrichFeeSinkNames } from '@fabric-tca/core';
import { enrichLegRouters } from './legRouterEnrichment';
import type { ReceiptModel } from './receiptModel';
import type { Chain } from './chains';

/**
 * The single place the receipt route gets its data.
 *
 * Every call is a fresh analysis — roughly 40 RPC calls. Nothing is cached and
 * nothing is stored: a mined transaction plus fixed pricing code is a pure
 * function, and the receipt is its output, so there is no state to keep.
 *
 * That is a deliberate trade. It costs deduplication — a link that reaches
 * fifty people in two seconds fires fifty analyses — and the global hourly
 * ceiling on the /tx route is the only thing bounding the bill. See the
 * Deferred section of docs/superpowers/specs/2026-08-06-database-removal-design.md
 * for the caching options surveyed. Whichever is chosen lands in THIS function.
 *
 * The two enrichments below used to happen in two different places at two
 * different times — fee-sink names at persist time, leg routers at read time.
 * With nothing persisted there is one moment, and it is here.
 */
export async function loadReceipt(chain: Chain, hash: string): Promise<ReceiptModel | null> {
	const rpcUrl = process.env.TCA_RPC_URL;
	// Deliberately a throw, not a null. Null on this path is the answer to "is
	// this a decodable swap?", and an unset env var is not evidence about the
	// transaction — it would render a confident "not a swap" for every hash.
	if (!rpcUrl) throw new Error('TCA_RPC_URL is not set');

	const receipt = await analyzeTransaction(hash, chain.id, { rpcUrl });
	if (!receipt) return null;

	return {
		...receipt,
		feeSinks: await enrichFeeSinkNames(receipt.feeSinks),
		routeLegs: enrichLegRouters(receipt.routeLegs, receipt.routerAddress, receipt.aggregator),
	};
}
