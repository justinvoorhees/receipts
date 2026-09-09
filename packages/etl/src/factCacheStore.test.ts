import type { FactCacheEntries } from '@fabric-tca/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cacheFilePath } from './derivedPath.js';
import { loadFactCacheEntries, saveFactCacheEntries } from './factCacheStore.js';
import { writeRowsToParquet } from './writeParquet.js';

const EMPTY: FactCacheEntries = { poolKeys: [], tokens: [], pools: [] };

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'factCacheStore-'));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('loadFactCacheEntries', () => {
	it('returns empty families when no files exist yet', async () => {
		expect(await loadFactCacheEntries({ dataDir: dir, chain: 'base' })).toEqual(EMPTY);
	});
});

describe('saveFactCacheEntries / loadFactCacheEntries', () => {
	it('round-trips all three families', async () => {
		const counts = await saveFactCacheEntries(
			{
				poolKeys: [[8453, '0xpoolid', { currency0: '0x11', currency1: '0x22', protocol: 'v4' }]],
				tokens: [[8453, '0xtok', { decimals: 6, symbol: 'USDC' }]],
				pools: [[8453, '0xpool', { token0: '0x11', token1: '0x22', feeBps: 30, factory: '0xfac' }]],
			},
			{ dataDir: dir, chain: 'base' },
		);
		expect(counts).toEqual({ poolKeys: 1, tokens: 1, pools: 1 });

		const back = await loadFactCacheEntries({ dataDir: dir, chain: 'base' });
		expect(back.poolKeys).toEqual([[8453, '0xpoolid', { currency0: '0x11', currency1: '0x22', protocol: 'v4' }]]);
		expect(back.tokens).toEqual([[8453, '0xtok', { decimals: 6, symbol: 'USDC' }]]);
		expect(back.pools).toEqual([
			[8453, '0xpool', { token0: '0x11', token1: '0x22', feeBps: 30, factory: '0xfac' }],
		]);
	});

	it('preserves a null symbol through the round trip', async () => {
		await saveFactCacheEntries(
			{ ...EMPTY, tokens: [[8453, '0xa', { decimals: 18, symbol: null }]] },
			{ dataDir: dir, chain: 'base' },
		);
		const back = await loadFactCacheEntries({ dataDir: dir, chain: 'base' });
		expect(back.tokens).toEqual([[8453, '0xa', { decimals: 18, symbol: null }]]);
	});

	it('preserves partial pool facts without inventing fields', async () => {
		// An absent token0 must come back ABSENT, not as null — the same
		// "absent is not measured" rule the fee work already established.
		await saveFactCacheEntries(
			{ ...EMPTY, pools: [[8453, '0xa', { factory: '0xf' }]] },
			{ dataDir: dir, chain: 'base' },
		);
		const back = await loadFactCacheEntries({ dataDir: dir, chain: 'base' });
		expect(back.pools).toEqual([[8453, '0xa', { factory: '0xf' }]]);
	});

	it('a second save replaces the files rather than appending', async () => {
		await saveFactCacheEntries(
			{ ...EMPTY, tokens: [[8453, '0xa', { decimals: 18, symbol: 'A' }]] },
			{ dataDir: dir, chain: 'base' },
		);
		await saveFactCacheEntries(
			{ ...EMPTY, tokens: [[8453, '0xb', { decimals: 6, symbol: 'B' }]] },
			{ dataDir: dir, chain: 'base' },
		);
		const back = await loadFactCacheEntries({ dataDir: dir, chain: 'base' });
		expect(back.tokens.map(([, k]) => k)).toEqual(['0xb']);
	});

	it('writes no file for an empty family, and still loads', async () => {
		const counts = await saveFactCacheEntries(
			{ ...EMPTY, tokens: [[8453, '0xa', { decimals: 18, symbol: 'A' }]] },
			{ dataDir: dir, chain: 'base' },
		);
		expect(counts).toEqual({ poolKeys: 0, tokens: 1, pools: 0 });
		const back = await loadFactCacheEntries({ dataDir: dir, chain: 'base' });
		expect(back.tokens).toHaveLength(1);
		expect(back.poolKeys).toEqual([]);
	});

	it('preserves a genuinely empty symbol as "" rather than reclassifying it as null', async () => {
		// A token whose symbol() really returns "" is a READ, not an absence — see
		// factCache.ts's "A NULL IS NEVER A FACT". Round-tripping "" to null would
		// make a later reader treat "could not read" and "read empty" the same.
		await saveFactCacheEntries(
			{ ...EMPTY, tokens: [[8453, '0xa', { decimals: 18, symbol: '' }]] },
			{ dataDir: dir, chain: 'base' },
		);
		const back = await loadFactCacheEntries({ dataDir: dir, chain: 'base' });
		expect(back.tokens).toEqual([[8453, '0xa', { decimals: 18, symbol: '' }]]);
	});

	// Malformed rows below are written with writeRowsToParquet directly (bypassing
	// FactCacheEntries's own type safety) to simulate a corrupted/hand-edited cache
	// file — the on-disk boundary loadFactCacheEntries must defend even though the
	// in-process writer never produces such a row itself.
	describe('refuses a malformed cache row rather than coercing it into a fact', () => {
		it('throws on a NULL decimals rather than reading it back as a plausible 0', async () => {
			await writeRowsToParquet(
				[{ chain_id: 8453, address: '0xa', decimals: null, symbol: 'USDC' }],
				{
					outPath: cacheFilePath({ dataDir: dir, name: 'tokens', chain: 'base' }),
					columnSpec:
						"{'chain_id': 'INTEGER', 'address': 'VARCHAR', 'decimals': 'INTEGER', 'symbol': 'VARCHAR'}",
					orderBy: 'chain_id, address',
				},
			);
			await expect(loadFactCacheEntries({ dataDir: dir, chain: 'base' })).rejects.toThrow(/decimals/);
		});

		it('throws on a NULL currency1 rather than reading it back as the string "null"', async () => {
			await writeRowsToParquet(
				[{ chain_id: 8453, pool_id: '0xpoolid', currency0: '0x11', currency1: null, protocol: 'v4' }],
				{
					outPath: cacheFilePath({ dataDir: dir, name: 'v4_poolkeys', chain: 'base' }),
					columnSpec:
						"{'chain_id': 'INTEGER', 'pool_id': 'VARCHAR', 'currency0': 'VARCHAR', 'currency1': 'VARCHAR', 'protocol': 'VARCHAR'}",
					orderBy: 'chain_id, pool_id',
				},
			);
			await expect(loadFactCacheEntries({ dataDir: dir, chain: 'base' })).rejects.toThrow(/currency1/);
		});

		it('throws on a NULL pool_id rather than coercing it into a usable key', async () => {
			await writeRowsToParquet(
				[{ chain_id: 8453, pool_id: null, currency0: '0x11', currency1: '0x22', protocol: 'v4' }],
				{
					outPath: cacheFilePath({ dataDir: dir, name: 'v4_poolkeys', chain: 'base' }),
					columnSpec:
						"{'chain_id': 'INTEGER', 'pool_id': 'VARCHAR', 'currency0': 'VARCHAR', 'currency1': 'VARCHAR', 'protocol': 'VARCHAR'}",
					orderBy: 'chain_id, currency0',
				},
			);
			await expect(loadFactCacheEntries({ dataDir: dir, chain: 'base' })).rejects.toThrow(/pool_id/);
		});
	});

	// The per-file "imports only types from @fabric-tca/core" guard that used
	// to live here has been replaced by one shared test that covers every
	// module in this package and every subpath, not just the bare specifier:
	// see coreImportDiscipline.test.ts.
});

describe('chain and protocol columns', () => {
	it('round-trips chain_id and protocol', async () => {
		await saveFactCacheEntries(
			{
				poolKeys: [[8453, '0xid', { currency0: '0x1', currency1: '0x2', protocol: 'infinity' }]],
				tokens: [[8453, '0xt', { decimals: 6, symbol: 'USDC' }]],
				pools: [[8453, '0xp', { factory: '0xf' }]],
			},
			{ dataDir: dir, chain: 'base' },
		);
		const back = await loadFactCacheEntries({ dataDir: dir, chain: 'base' });
		expect(back.poolKeys).toEqual([[8453, '0xid', { currency0: '0x1', currency1: '0x2', protocol: 'infinity' }]]);
		expect(back.pools).toEqual([[8453, '0xp', { factory: '0xf' }]]);
		expect(back.tokens).toEqual([[8453, '0xt', { decimals: 6, symbol: 'USDC' }]]);
	});

	it('refuses a pool key row with an unknown protocol rather than guessing', async () => {
		// A protocol we cannot name is a provenance hole, and this table is
		// supposed to close one.
		await expect(
			saveFactCacheEntries(
				{
					poolKeys: [[8453, '0xid', { currency0: '0x1', currency1: '0x2', protocol: 'nope' as never }]],
					tokens: [],
					pools: [],
				},
				{ dataDir: dir, chain: 'base' },
			),
		).rejects.toThrow(/protocol/);
	});
});
