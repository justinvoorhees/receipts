import { describe, it, expect } from 'vitest';
import { receiptToRow } from './_rowShape.mjs';

describe('receiptToRow', () => {
	// The five column-reading scripts index rows by snake_case names inherited
	// from the DB dump. This mapping is the whole reason they need no rewrite.
	it('maps every column the analysis scripts read', () => {
		const receipt = {
			txHash: '0xabc', blockNumber: 123, aggregator: 'kyberswap',
			notionalUsd: 1000, tier: 'full', pricingStatus: 'full',
			allInCostBps: -12.5, slippageBps: -3.25, reconResidualBps: 0.5,
			decompConfidence: 'high', routeShape: 'single',
			normalizeFlags: ['A'], routeLegs: [{ type: 'v3', venue: '0xpool' }],
		};
		const row = receiptToRow(receipt, 485);
		expect(row.id).toBe(485);
		expect(row.tx_hash).toBe('0xabc');
		expect(row.block_number).toBe(123);
		expect(row.aggregator).toBe('kyberswap');
		expect(row.notional_usd).toBe(1000);
		expect(row.tier).toBe('full');
		expect(row.pricing_status).toBe('full');
		expect(row.all_in_cost_bps).toBe(-12.5);
		expect(row.slippage_bps).toBe(-3.25);
		expect(row.recon_residual_bps).toBe(0.5);
		expect(row.decomp_confidence).toBe('high');
		expect(row.route_shape).toBe('single');
		expect(row.normalize_flags).toEqual(['A']);
	});

	// Legs pass through untouched: corpus stored them camelCase, identical to
	// what the decoder emits. A translation layer here would be a bug.
	it('passes route legs through without translating them', () => {
		const legs = [{ type: 'v3', venue: '0xp', notionalUsdc: 5, priceImpactBps: 1.5, feeResolved: true }];
		const row = receiptToRow({ routeLegs: legs }, 1);
		expect(row.route_legs).toBe(legs);
	});

	// A failed decode must not masquerade as a decoded receipt with null columns —
	// every script filtering on `route_legs != null` would silently drop it and
	// report a smaller sample with no indication anything was missing.
	it('keeps the receipt reachable for fields the map does not cover', () => {
		const receipt = { routeLegs: [], marketMid: 1800, referenceDepthUsd: 42 };
		const row = receiptToRow(receipt, 1);
		expect(row._receipt.marketMid).toBe(1800);
		expect(row._receipt.referenceDepthUsd).toBe(42);
	});
});
