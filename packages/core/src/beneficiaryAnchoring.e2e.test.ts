import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import { analyzeTransaction } from './analyzeTransaction.js';

const RPC = process.env.TCA_RPC_URL;
const d = RPC ? describe : describe.skip;
const CHAIN = 8453;

d('beneficiary-anchored decoding e2e', () => {
	it('decodes the Relay relayer trade anchored on its EOA beneficiary', async () => {
		const r = await analyzeTransaction('0xd6bb5ae0ec9017de395fb9b0435fe18c1859c6fbf7830052bab20f36e496bc0f', CHAIN, { rpcUrl: RPC! });
		expect(r).not.toBeNull();
		expect(r!.trader.toLowerCase()).toBe('0xf70da97812cb96acdf810712aa562db8dfa3dbef');
		expect(r!.inputSymbol).toBe('USDC');
		expect(r!.outputSymbol).toBe('ETH');
		expect(r!.normalizeFlags.some((f) => f.startsWith('BENEFICIARY_ANCHORED'))).toBe(true);
		// Net-flow anchoring, not UniswapX — no filler concept applies.
		expect(r!.fillerAddress).toBeNull();
	}, 60000);

	it('decodes a UniswapX single fill anchored on the swapper', async () => {
		const UNISWAPX_FILL_HASH = '0x97a73ba891215ca32d239bbeb2b0e27dea5720890c907940ccfd758dbb691a73';
		const r = await analyzeTransaction(UNISWAPX_FILL_HASH, CHAIN, { rpcUrl: RPC! });
		expect(r).not.toBeNull();
		expect(r!.normalizeFlags.some((f) => f.startsWith('ANCHOR_VIA_UNISWAPX'))).toBe(true);
		expect(r!.trader.length).toBe(42); // a resolved swapper address
		expect(r!.fillerAddress).not.toBeNull();
		expect(r!.fillerAddress!.length).toBe(42); // a resolved filler EOA
	}, 60000);
});
