import { describe, expect, it } from 'vitest';
import { createMemoryFactCache } from './factCache.js';
import { CACHEABLE_FEE_VENUES, cachedFeeReader, cachedPoolKeyReader, cachedV3FactoryReader } from './cachedReaders.js';

describe('cachedPoolKeyReader', () => {
	it('calls the inner reader once, then serves from cache', async () => {
		let calls = 0;
		const inner = async () => { calls++; return { currency0: '0x1', currency1: '0x2' }; };
		const cache = createMemoryFactCache();
		const reader = cachedPoolKeyReader(inner, cache);
		expect(await reader('0xPOOL')).toEqual({ currency0: '0x1', currency1: '0x2' });
		expect(await reader('0xpool')).toEqual({ currency0: '0x1', currency1: '0x2' });
		expect(calls).toBe(1);
	});

	it('serves a pre-seeded fact without calling the inner reader at all', async () => {
		// This is the win: ~25 serial extsload probes per poolId become zero.
		let calls = 0;
		const inner = async () => { calls++; return null; };
		const cache = createMemoryFactCache({ poolKeys: [['0xa', { currency0: '0x1', currency1: '0x2' }]] });
		expect(await cachedPoolKeyReader(inner, cache)('0xA')).toEqual({ currency0: '0x1', currency1: '0x2' });
		expect(calls).toBe(0);
	});

	it('NEVER caches a null, and retries on the next call', async () => {
		// A null means "no such pool" OR "the read failed" — indistinguishable.
		// Persisting one would make a transport blip permanent.
		let calls = 0;
		const inner = async () => { calls++; return null; };
		const cache = createMemoryFactCache();
		const reader = cachedPoolKeyReader(inner, cache);
		expect(await reader('0xa')).toBeNull();
		expect(await reader('0xa')).toBeNull();
		expect(calls).toBe(2);
		expect(cache.entries().poolKeys).toEqual([]);
	});
});

describe('cachedV3FactoryReader', () => {
	it('caches a positive factory answer', async () => {
		let calls = 0;
		const inner = async () => { calls++; return '0xfac'; };
		const cache = createMemoryFactCache();
		const reader = cachedV3FactoryReader(inner, cache);
		expect(await reader('0xP')).toBe('0xfac');
		expect(await reader('0xp')).toBe('0xfac');
		expect(calls).toBe(1);
		expect(cache.getPool('0xp')?.factory).toBe('0xfac');
	});

	it('never caches a null factory', async () => {
		let calls = 0;
		const inner = async () => { calls++; return null; };
		const cache = createMemoryFactCache();
		const reader = cachedV3FactoryReader(inner, cache);
		await reader('0xa');
		await reader('0xa');
		expect(calls).toBe(2);
		expect(cache.getPool('0xa')).toBeUndefined();
	});
});

describe('cachedFeeReader', () => {
	it('caches a resolved fee for a static-tier v3 venue', async () => {
		let calls = 0;
		const inner = async () => { calls++; return { bps: 30, defaulted: false }; };
		const cache = createMemoryFactCache();
		const reader = cachedFeeReader(inner, cache);
		expect(await reader('0xP', 'univ3')).toEqual({ bps: 30, defaulted: false });
		expect(await reader('0xp', 'univ3')).toEqual({ bps: 30, defaulted: false });
		expect(calls).toBe(1);
	});

	it('NEVER caches a dynamic-fee venue, even when the read succeeds', async () => {
		// hydrex and quickswapv4 are Algebra Integral: fee() returns the
		// CURRENTLY EFFECTIVE fee including a plugin override, so yesterday's
		// answer is not today's.
		for (const venue of ['hydrex', 'quickswapv4', 'univ4', 'pancake_infinity'] as const) {
			let calls = 0;
			const inner = async () => { calls++; return { bps: 30, defaulted: false }; };
			const cache = createMemoryFactCache();
			const reader = cachedFeeReader(inner, cache);
			await reader('0xp', venue);
			await reader('0xp', venue);
			expect(calls, `${venue} must not be cached`).toBe(2);
			expect(cache.getPool('0xp')?.feeBps, `${venue} must not be stored`).toBeUndefined();
		}
	});

	it('never caches a DEFAULTED fee', async () => {
		// defaulted:true means the read failed and a fallback was substituted —
		// exactly the "absent is not measured" trap the fee work already fixed once.
		let calls = 0;
		const inner = async () => { calls++; return { bps: 30, defaulted: true }; };
		const cache = createMemoryFactCache();
		const reader = cachedFeeReader(inner, cache);
		await reader('0xp', 'univ3');
		await reader('0xp', 'univ3');
		expect(calls).toBe(2);
		expect(cache.getPool('0xp')?.feeBps).toBeUndefined();
	});

	it('pins the allowlist to exactly the four static-tier v3 forks', () => {
		expect([...CACHEABLE_FEE_VENUES].sort()).toEqual(['baseswapv3', 'pancakev3', 'sushiv3', 'univ3']);
	});
});
