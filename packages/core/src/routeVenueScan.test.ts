import { describe, expect, it } from 'vitest';
import { scanVenues } from './routeVenueScan.js';
import { INFINITY_SWAP_TOPIC } from './infinityLegs.js';
import { PANCAKE_INFINITY_VAULT } from './tradeDecoders.js';

// ⚠️ Fix-round coverage (2026-07-31): id 408 regressed because the Infinity
// vault's collapsed leg carried no poolId/fee even in the unambiguous
// single-pool case, so it could never price without the (correctly, per its
// own tests) un-fired rescue. These pin the fix: scanVenues now attaches
// infinityPoolId/infinityFeeRaw to the vault entry IFF exactly one distinct
// pool was touched.

const word = (v: bigint) => (v < 0n ? 2n ** 256n + v : v).toString(16).padStart(64, '0');

/** Builds a raw Infinity Swap log. Mirrors infinityLegs.test.ts's swapLog. */
const infinitySwapLog = (poolId: string, amount0: bigint, amount1: bigint, fee: bigint, protocolFee: bigint) => ({
	// collectInfinitySwaps (and scanVenues's own topic check) filter by TOPIC,
	// not emitter address, so any address works here.
	address: '0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b' as `0x${string}`,
	topics: [INFINITY_SWAP_TOPIC, poolId, `0x${'0'.repeat(64)}`] as unknown as readonly `0x${string}`[],
	data: `0x${word(amount0)}${word(amount1)}${word(12345678n)}${word(0n)}${word(0n)}${word(fee)}${word(protocolFee)}` as `0x${string}`,
});

const POOL_A = `0x${'aa'.repeat(32)}`;
const POOL_B = `0x${'bb'.repeat(32)}`;

describe('scanVenues — PancakeSwap Infinity pool identity', () => {
	it('attaches the pool identity when exactly one distinct pool was touched', () => {
		const venues = scanVenues([infinitySwapLog(POOL_A, 1_000n, -2_000n, 70n, 23n)] as never, false);
		const vault = venues.get(PANCAKE_INFINITY_VAULT);
		expect(vault?.type).toBe('pancake_infinity');
		expect(vault?.infinityPoolId).toBe(POOL_A);
		// LP-only, inverted out of swapFee=70/protocolFee=23 — same as infinityLpFeePips(70, 23).
		expect(vault?.infinityFeeRaw).toBeCloseTo(47.001, 2);
	});

	it('does NOT attach a pool identity when two distinct pools were touched — the lossy-collapse guard', () => {
		const venues = scanVenues(
			[
				infinitySwapLog(POOL_A, 1_000n, -2_000n, 70n, 23n),
				infinitySwapLog(POOL_B, 500n, -900n, 70n, 23n),
			] as never,
			false,
		);
		const vault = venues.get(PANCAKE_INFINITY_VAULT);
		expect(vault?.type).toBe('pancake_infinity');
		expect(vault?.infinityPoolId).toBeUndefined();
		expect(vault?.infinityFeeRaw).toBeUndefined();
	});

	it('still counts as one pool when two swaps share the SAME poolId — distinctness, not swap count', () => {
		const venues = scanVenues(
			[
				infinitySwapLog(POOL_A, 1_000n, -2_000n, 70n, 23n),
				infinitySwapLog(POOL_A, 300n, -550n, 70n, 23n),
			] as never,
			false,
		);
		const vault = venues.get(PANCAKE_INFINITY_VAULT);
		expect(vault?.type).toBe('pancake_infinity');
		expect(vault?.infinityPoolId).toBe(POOL_A);
		expect(vault?.infinityFeeRaw).toBeCloseTo(47.001, 2);
	});
});
