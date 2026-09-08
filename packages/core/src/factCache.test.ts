import { describe, expect, it } from 'vitest';
import { createMemoryFactCache } from './factCache.js';

describe('createMemoryFactCache', () => {
	it('round-trips a pool key, lowercasing the id', () => {
		const cache = createMemoryFactCache();
		cache.setPoolKey('0xABC', { currency0: '0x11', currency1: '0x22' });
		expect(cache.getPoolKey('0xabc')).toEqual({ currency0: '0x11', currency1: '0x22' });
		expect(cache.getPoolKey('0xABC')).toEqual({ currency0: '0x11', currency1: '0x22' });
	});

	it('returns undefined for an unknown key, distinct from a stored value', () => {
		const cache = createMemoryFactCache();
		expect(cache.getPoolKey('0xmissing')).toBeUndefined();
		expect(cache.getToken('0xmissing')).toBeUndefined();
		expect(cache.getPool('0xmissing')).toBeUndefined();
	});

	it('round-trips token metadata including a null symbol', () => {
		const cache = createMemoryFactCache();
		cache.setToken('0xTok', { decimals: 6, symbol: null });
		expect(cache.getToken('0xtok')).toEqual({ decimals: 6, symbol: null });
	});

	it('merges pool facts rather than replacing them', () => {
		// factory and fee are learned by two different readers at different times.
		const cache = createMemoryFactCache();
		cache.setPool('0xP', { factory: '0xf' });
		cache.setPool('0xP', { feeBps: 30 });
		expect(cache.getPool('0xp')).toEqual({ factory: '0xf', feeBps: 30 });
	});

	it('seeds from existing entries', () => {
		const cache = createMemoryFactCache({
			poolKeys: [['0xa', { currency0: '0x1', currency1: '0x2' }]],
			tokens: [['0xb', { decimals: 18, symbol: 'WETH' }]],
			pools: [['0xc', { factory: '0xf' }]],
		});
		expect(cache.getPoolKey('0xa')).toEqual({ currency0: '0x1', currency1: '0x2' });
		expect(cache.getToken('0xb')?.symbol).toBe('WETH');
		expect(cache.getPool('0xc')?.factory).toBe('0xf');
	});

	it('exposes its entries for persistence, lowercased', () => {
		const cache = createMemoryFactCache();
		cache.setPoolKey('0xA', { currency0: '0x1', currency1: '0x2' });
		cache.setToken('0xB', { decimals: 18, symbol: 'W' });
		cache.setPool('0xC', { factory: '0xf' });
		const e = cache.entries();
		expect(e.poolKeys.map(([k]) => k)).toEqual(['0xa']);
		expect(e.tokens.map(([k]) => k)).toEqual(['0xb']);
		expect(e.pools.map(([k]) => k)).toEqual(['0xc']);
	});

	it('stores a token fact whole, decimals and symbol together', () => {
		// ⚠️ Nothing in v0.2b-1 writes this family — see the module docstring for
		// why a decimals-only writer would be actively wrong. This test pins the
		// shape v0.2b-2 must supply: both fields, from one resolution.
		const cache = createMemoryFactCache();
		cache.setToken('0xa', { decimals: 6, symbol: 'USDC' });
		expect(cache.getToken('0xa')).toEqual({ decimals: 6, symbol: 'USDC' });
	});

	it('has no way to store a getPool factory lookup', () => {
		// getPool reads a factory at the `latest` tag and its answer CHANGES when a
		// new fee tier is deployed (rpcMemo.ts's header warning). If this ever
		// compiles, the cache has grown a way to make a mutable answer permanent.
		const cache = createMemoryFactCache() as unknown as Record<string, unknown>;
		expect(cache.setGetPool).toBeUndefined();
		expect(cache.getGetPool).toBeUndefined();
	});
});
