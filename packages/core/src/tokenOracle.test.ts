import { describe, expect, it } from 'vitest';
import { usdFeedFor, chainlinkAnswerToUsd, readTokenUsd } from './tokenOracle.js';

const WBTC = '0x0555e30da8f98308edb960aa94c0db47230d2b9c';

// Minimal fake PublicClient: a round (answer/updatedAt) + a block timestamp.
function fakeClient(answer: bigint, updatedAt: bigint, blockTs: bigint) {
	return {
		readContract: async () => [0n, answer, 0n, updatedAt, 0n] as const,
		getBlock: async () => ({ timestamp: blockTs }),
	} as never;
}

describe('usdFeedFor', () => {
	it('maps WBTC (any case) to the BTC/USD feed', () => {
		expect(usdFeedFor(WBTC)?.label).toBe('BTC/USD');
		expect(usdFeedFor(WBTC.toUpperCase())?.label).toBe('BTC/USD');
	});
	it('returns null for an unmapped token', () => {
		expect(usdFeedFor('0xdeadbeef00000000000000000000000000000000')).toBeNull();
	});
});

describe('chainlinkAnswerToUsd', () => {
	it('scales an 8-decimal answer', () => {
		expect(chainlinkAnswerToUsd(6477860909255n)).toBeCloseTo(64778.609, 3);
	});
});

describe('readTokenUsd', () => {
	it('returns the USD price for a mapped token with a fresh round', async () => {
		// round updated 60s before the block → fresh
		const price = await readTokenUsd(WBTC, 100n, 'x', fakeClient(6477860909255n, 1000n, 1060n));
		expect(price).toBeCloseTo(64778.609, 3);
	});
	it('returns null for a mapped token whose round is stale', async () => {
		// updated 2000s before block > 1200s tolerance → stale
		const price = await readTokenUsd(WBTC, 100n, 'x', fakeClient(6477860909255n, 1000n, 3000n));
		expect(price).toBeNull();
	});
	it('returns null (no read) for an unmapped token', async () => {
		const price = await readTokenUsd('0xdeadbeef00000000000000000000000000000000', 100n, 'x');
		expect(price).toBeNull();
	});
});
