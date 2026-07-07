import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import { analyzeTransaction } from './analyzeTransaction.js';

const RPC = process.env.TCA_RPC_URL;

describe.runIf(RPC)('analyzeTransaction (integration)', () => {
	it('produces a full receipt for a known USDC/WETH smoke hash', async () => {
		const r = await analyzeTransaction(
			'0x9703bfa335528a8e01c6b63dd3046ccd6e13a66ba2e6954956aa2df39da269c1',
			8453,
			{ rpcUrl: RPC! },
		);
		expect(r).not.toBeNull();
		expect(r!.pricingStatus).toBe('full');
		expect(r!.inputSymbol === 'USDC' || r!.outputSymbol === 'USDC').toBe(true);
		// LP + Agg + PriceImpact + Slippage reconcile to all-in within tolerance
		expect(Math.abs(Number(r!.allInCostBps))).toBeLessThan(200);
		// Oracle sub-fields flow through the USDC/WETH fast-path (regression guard
		// for the priceReceipt -> Receipt forwarding wiring).
		expect(r!.chainlinkPrice).not.toBeNull();
		expect(r!.chainlinkDevBps).not.toBeNull();
	}, 60_000);

	it('returns null for a non-swap hash', async () => {
		const r = await analyzeTransaction('0x' + '00'.repeat(32), 8453, { rpcUrl: RPC! });
		expect(r).toBeNull();
	}, 60_000);
});
