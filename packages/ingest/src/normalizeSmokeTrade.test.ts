import { describe, expect, it } from 'vitest';
import { buildSmokeRow } from './normalizeSmokeTrade.js';

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const trader = '0x000000000000000000000000000000000000d00d';
const pad = (a: string) => '0x' + a.slice(2).padStart(64, '0');
const hex = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');

// Synthetic trace: trader sends 2.00 USDC, receives 0.001 WETH (buy_weth).
const trace = {
	logs: [
		{ address: USDC, topics: [TRANSFER, pad(trader), pad('0x0000000000000000000000000000000000aa1111')], data: hex(2_000_000n) },
		{ address: WETH, topics: [TRANSFER, pad('0x0000000000000000000000000000000000aa1111'), pad(trader)], data: hex(1_000_000_000_000_000n) },
	],
	calls: [],
};

describe('buildSmokeRow', () => {
	it('normalizes a known-trader buy_weth into v2 fields with Accuracy vs market mid', () => {
		const r = buildSmokeRow({
			candidate: {
				txHash: '0xabc', aggregator: 'odos', trader,
				experimentSlug: 'smoke-9', runId: 'run-1', v1Status: 'success',
				v1QuoteAmountUsd: 2, v1RealizedAmountUsd: 1.99,
			},
			trace,
			receiptLogs: trace.logs,
			gasUsed: 200000n,
			effectiveGasPriceWei: 50000000n, // 0.05 gwei
			marketMid: 2100, // USDC per WETH
			blockNumber: 12345,
			// decomposition is exercised in the async path; here pass a stub
			decomposition: { lpFeeBps: 5, aggFeeBps: 0, slippageBps: 1, executionBps: 6, gasBps: 0, flags: [] },
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.row.direction).toBe('buy_weth');
		expect(r.row.usdcAmount).toBeCloseTo(2.0, 6);
		expect(r.row.wethAmount).toBeCloseTo(0.001, 9);
		expect(r.row.realizedPrice).toBeCloseTo(2000, 6);
		// buy_weth, realized 2000 vs mid 2100 -> negative cost (got it cheaper)
		expect(r.row.allInCostBps).toBeLessThan(0);
		expect(r.row.settledIn).toBe('WETH');
		expect(r.row.gasCostUsd).toBeGreaterThan(0);
	});
});
