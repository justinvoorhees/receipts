import type { Receipt } from '@fabric-tca/core';
import { describe, expect, it } from 'vitest';
import { RECEIPT_COLUMNS, LEG_COLUMNS } from './derivedSchema.js';
import { toFailureRow, toLegRows, toReceiptRow } from './receiptRows.js';

const RUN = {
	coreGitSha: 'abc1234',
	rpcSource: 'quicknode-base-mainnet',
	seedFile: 'traces.base.0050842630-0050842929.parquet',
	derivedAt: '2026-09-08T12:00:00.000Z',
};
const TX = { blockPosition: 6, blockTimestamp: '2026-09-03T22:30:07.000Z' };

function receipt(over: Partial<Receipt> = {}): Receipt {
	return {
		txHash: '0xa', chainId: 8453, blockNumber: 50842671,
		aggregator: 'kyberswap', routerAddress: '0xr', trader: '0xt', fillerAddress: null,
		direction: 'sell', inputToken: '0xin', outputToken: '0xout',
		inputSymbol: 'A', outputSymbol: 'B', inputAmount: 1, outputAmount: 2,
		notionalUsd: 100, realizedPrice: 2, marketMid: 2.1,
		marketMidBefore: null, marketMidAfter: null,
		allInCostBps: 47, pricingStatus: 'estimated', tier: 'estimated',
		methodology: 'Estimated: …', marketPriceFlags: ['X'],
		referenceDepthUsd: 1234, referencePoolAddress: '0xp',
		executionBps: 40, lpFeeBps: 5, aggFeeBps: 2, slippageBps: 0, gasCostUsd: 0.01,
		routePure: true, routeShape: 'single', hopCount: 1, routeLegs: [],
		routeReconstructed: true, reconResidualBps: 0, decompConfidence: 'high',
		feeRecipient: null, feeSinkSource: null, feeSinks: [],
		integratorFeeBps: null, fabricFeeBps: null,
		settlementEventName: null, settlementEventTopic0: null, settlementEventSeen: false,
		normalizeFlags: [], chainlinkPrice: null, chainlinkDevBps: null,
		poolDivergenceBps: null, manipulationFlag: false, offchainPrice: null,
		offchainDevBps: null, chainlinkStalenessSecs: null,
		...over,
	} as Receipt;
}

describe('toReceiptRow', () => {
	it('emits exactly the declared columns, in declared order', () => {
		expect(Object.keys(toReceiptRow(receipt(), TX, RUN))).toEqual(Object.keys(RECEIPT_COLUMNS));
	});

	it('labels price_confidence from pricing_status, matching the receipt page', () => {
		expect(toReceiptRow(receipt({ pricingStatus: 'full' }), TX, RUN).price_confidence).toBe('Verified');
		expect(toReceiptRow(receipt({ pricingStatus: 'estimated' }), TX, RUN).price_confidence).toBe('Estimated');
		expect(toReceiptRow(receipt({ pricingStatus: 'partial' }), TX, RUN).price_confidence).toBe('Unavailable');
	});

	it('keeps tier and pricing_status independent when they disagree', () => {
		// The real case: MAMO->cbBTC, a corroborated mid with no USD anchor.
		const row = toReceiptRow(receipt({ tier: 'full', pricingStatus: 'estimated' }), TX, RUN);
		expect(row.tier).toBe('full');
		expect(row.pricing_status).toBe('estimated');
		expect(row.price_confidence).toBe('Estimated');
	});

	it('leaves failure_reason null on a successful decode', () => {
		expect(toReceiptRow(receipt(), TX, RUN).failure_reason).toBeNull();
	});
});

describe('toFailureRow', () => {
	it('emits exactly the declared columns, in declared order', () => {
		const row = toFailureRow({ txHash: '0xa', chainId: 8453, blockNumber: 1, failureReason: 'no receipt' }, TX, RUN);
		expect(Object.keys(row)).toEqual(Object.keys(RECEIPT_COLUMNS));
	});

	it('is Unavailable with the reason recorded and the cost columns null', () => {
		const row = toFailureRow({ txHash: '0xa', chainId: 8453, blockNumber: 1, failureReason: 'not a clean 2-token swap' }, TX, RUN);
		expect(row.price_confidence).toBe('Unavailable');
		expect(row.failure_reason).toBe('not a clean 2-token swap');
		expect(row.all_in_cost_bps).toBeNull();
		expect(row.tier).toBeNull();
	});
});

describe('toLegRows', () => {
	it('emits exactly the declared columns, in declared order', () => {
		const rows = toLegRows(receipt({ routeLegs: [{
			venue: '0xp', type: 'univ3', tokenIn: '0xa', tokenOut: '0xb',
			feeTierBps: 30, notionalUsdc: 100, notionalApprox: false,
			lpFeeBps: 5, priceImpactBps: 2, amountInRaw: '1', amountOutRaw: '2',
		}] }));
		expect(rows).toHaveLength(1);
		expect(Object.keys(rows[0]!)).toEqual(Object.keys(LEG_COLUMNS));
	});

	it('numbers legs in route order', () => {
		const leg = (v: string) => ({ venue: v, type: 'univ3', tokenIn: '0xa', tokenOut: '0xb',
			feeTierBps: 30, notionalUsdc: 1, notionalApprox: false, lpFeeBps: null,
			priceImpactBps: null, amountInRaw: '1', amountOutRaw: '2' });
		const rows = toLegRows(receipt({ routeLegs: [leg('0x1'), leg('0x2')] }));
		expect(rows.map((r) => [r.leg_index, r.venue])).toEqual([[0, '0x1'], [1, '0x2']]);
	});

	it('returns no rows when routeLegs is null', () => {
		expect(toLegRows(receipt({ routeLegs: null }))).toEqual([]);
	});

	it('nulls an absent optional rather than stringifying undefined', () => {
		// fee_resolved and frame_chain are OMITTED by core when they do not
		// apply. String(undefined) would write the literal "undefined".
		const rows = toLegRows(receipt({ routeLegs: [{
			venue: '0xp', type: 'univ3', tokenIn: '0xa', tokenOut: '0xb',
			feeTierBps: 30, notionalUsdc: 1, notionalApprox: false,
			lpFeeBps: null, priceImpactBps: null, amountInRaw: '1', amountOutRaw: '2',
		}] }));
		expect(rows[0]!.fee_resolved).toBeNull();
		expect(rows[0]!.frame_chain).toBeNull();
		expect(rows[0]!.v4_emitter).toBeNull();
	});
});

describe('module discipline', () => {
	it('imports only TYPES from @fabric-tca/core', async () => {
		const { readFileSync } = await import('node:fs');
		const src = readFileSync(new URL('./receiptRows.ts', import.meta.url), 'utf8');
		expect(src.match(/import\s+(?!type\b)[\s\S]*?from\s*['"]@fabric-tca\/core['"]/g)).toBeNull();
		expect(src).toMatch(/import type .*@fabric-tca\/core/);
	});
});
