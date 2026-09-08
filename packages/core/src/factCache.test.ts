import { describe, expect, it } from 'vitest';
import { createMemoryFactCache } from './factCache.js';

describe('createMemoryFactCache', () => {
	it('round-trips a pool key, lowercasing the id', () => {
		const cache = createMemoryFactCache();
		cache.setPoolKey(8453, '0xABC', { currency0: '0x11', currency1: '0x22', protocol: 'v4' });
		expect(cache.getPoolKey(8453, '0xabc')).toEqual({ currency0: '0x11', currency1: '0x22', protocol: 'v4' });
		expect(cache.getPoolKey(8453, '0xABC')).toEqual({ currency0: '0x11', currency1: '0x22', protocol: 'v4' });
	});

	it('returns undefined for an unknown key, distinct from a stored value', () => {
		const cache = createMemoryFactCache();
		expect(cache.getPoolKey(8453, '0xmissing')).toBeUndefined();
		expect(cache.getToken(8453, '0xmissing')).toBeUndefined();
		expect(cache.getPool(8453, '0xmissing')).toBeUndefined();
	});

	it('round-trips token metadata including a null symbol', () => {
		const cache = createMemoryFactCache();
		cache.setToken(8453, '0xTok', { decimals: 6, symbol: null });
		expect(cache.getToken(8453, '0xtok')).toEqual({ decimals: 6, symbol: null });
	});

	it('merges pool facts rather than replacing them', () => {
		// factory and fee are learned by two different readers at different times.
		const cache = createMemoryFactCache();
		cache.setPool(8453, '0xP', { factory: '0xf' });
		cache.setPool(8453, '0xP', { feeBps: 30 });
		expect(cache.getPool(8453, '0xp')).toEqual({ factory: '0xf', feeBps: 30 });
	});

	it('seeds from existing entries', () => {
		const cache = createMemoryFactCache({
			poolKeys: [[8453, '0xa', { currency0: '0x1', currency1: '0x2', protocol: 'v4' }]],
			tokens: [[8453, '0xb', { decimals: 18, symbol: 'WETH' }]],
			pools: [[8453, '0xc', { factory: '0xf' }]],
		});
		expect(cache.getPoolKey(8453, '0xa')).toEqual({ currency0: '0x1', currency1: '0x2', protocol: 'v4' });
		expect(cache.getToken(8453, '0xb')?.symbol).toBe('WETH');
		expect(cache.getPool(8453, '0xc')?.factory).toBe('0xf');
	});

	it('exposes its entries for persistence, lowercased', () => {
		const cache = createMemoryFactCache();
		cache.setPoolKey(8453, '0xA', { currency0: '0x1', currency1: '0x2', protocol: 'v4' });
		cache.setToken(8453, '0xB', { decimals: 18, symbol: 'W' });
		cache.setPool(8453, '0xC', { factory: '0xf' });
		const e = cache.entries();
		expect(e.poolKeys.map(([, k]) => k)).toEqual(['0xa']);
		expect(e.tokens.map(([, k]) => k)).toEqual(['0xb']);
		expect(e.pools.map(([, k]) => k)).toEqual(['0xc']);
	});

	it('stores a token fact whole, decimals and symbol together', () => {
		// ⚠️ Nothing in v0.2b-1 writes this family — see the module docstring for
		// why a decimals-only writer would be actively wrong. This test pins the
		// shape v0.2b-2 must supply: both fields, from one resolution.
		const cache = createMemoryFactCache();
		cache.setToken(8453, '0xa', { decimals: 6, symbol: 'USDC' });
		expect(cache.getToken(8453, '0xa')).toEqual({ decimals: 6, symbol: 'USDC' });
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

describe('FactCache chain scoping', () => {
	it('keeps the same pool address separate per chain', () => {
		// Pool addresses are NOT unique across chains. Without this, one process
		// serving two chains would serve Base's answer for a mainnet pool.
		const cache = createMemoryFactCache();
		cache.setPool(8453, '0xP', { factory: '0xbase' });
		cache.setPool(1, '0xP', { factory: '0xmainnet' });
		expect(cache.getPool(8453, '0xp')?.factory).toBe('0xbase');
		expect(cache.getPool(1, '0xp')?.factory).toBe('0xmainnet');
	});

	it('keeps pool keys and tokens separate per chain too', () => {
		const cache = createMemoryFactCache();
		cache.setPoolKey(8453, '0xID', { currency0: '0x1', currency1: '0x2', protocol: 'v4' });
		expect(cache.getPoolKey(1, '0xID')).toBeUndefined();
		cache.setToken(8453, '0xT', { decimals: 6, symbol: 'USDC' });
		expect(cache.getToken(1, '0xT')).toBeUndefined();
	});

	it('records which protocol produced a pool key', () => {
		// v4 and Infinity share one keyspace; without this the table cannot say
		// which reader wrote a row.
		const cache = createMemoryFactCache();
		cache.setPoolKey(8453, '0xa', { currency0: '0x1', currency1: '0x2', protocol: 'v4' });
		cache.setPoolKey(8453, '0xb', { currency0: '0x3', currency1: '0x4', protocol: 'infinity' });
		expect(cache.getPoolKey(8453, '0xa')?.protocol).toBe('v4');
		expect(cache.getPoolKey(8453, '0xb')?.protocol).toBe('infinity');
	});

	it('carries chainId through entries() for persistence', () => {
		const cache = createMemoryFactCache();
		cache.setPool(8453, '0xP', { factory: '0xf' });
		expect(cache.entries().pools).toEqual([[8453, '0xp', { factory: '0xf' }]]);
	});
});
