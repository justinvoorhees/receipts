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
				poolKeys: [['0xpoolid', { currency0: '0x11', currency1: '0x22' }]],
				tokens: [['0xtok', { decimals: 6, symbol: 'USDC' }]],
				pools: [['0xpool', { token0: '0x11', token1: '0x22', feeBps: 30, factory: '0xfac' }]],
			},
			{ dataDir: dir, chain: 'base' },
		);
		expect(counts).toEqual({ poolKeys: 1, tokens: 1, pools: 1 });

		const back = await loadFactCacheEntries({ dataDir: dir, chain: 'base' });
		expect(back.poolKeys).toEqual([['0xpoolid', { currency0: '0x11', currency1: '0x22' }]]);
		expect(back.tokens).toEqual([['0xtok', { decimals: 6, symbol: 'USDC' }]]);
		expect(back.pools).toEqual([['0xpool', { token0: '0x11', token1: '0x22', feeBps: 30, factory: '0xfac' }]]);
	});

	it('preserves a null symbol through the round trip', async () => {
		await saveFactCacheEntries(
			{ ...EMPTY, tokens: [['0xa', { decimals: 18, symbol: null }]] },
			{ dataDir: dir, chain: 'base' },
		);
		const back = await loadFactCacheEntries({ dataDir: dir, chain: 'base' });
		expect(back.tokens).toEqual([['0xa', { decimals: 18, symbol: null }]]);
	});

	it('preserves partial pool facts without inventing fields', async () => {
		// An absent token0 must come back ABSENT, not as null — the same
		// "absent is not measured" rule the fee work already established.
		await saveFactCacheEntries(
			{ ...EMPTY, pools: [['0xa', { factory: '0xf' }]] },
			{ dataDir: dir, chain: 'base' },
		);
		const back = await loadFactCacheEntries({ dataDir: dir, chain: 'base' });
		expect(back.pools).toEqual([['0xa', { factory: '0xf' }]]);
	});

	it('a second save replaces the files rather than appending', async () => {
		await saveFactCacheEntries(
			{ ...EMPTY, tokens: [['0xa', { decimals: 18, symbol: 'A' }]] },
			{ dataDir: dir, chain: 'base' },
		);
		await saveFactCacheEntries(
			{ ...EMPTY, tokens: [['0xb', { decimals: 6, symbol: 'B' }]] },
			{ dataDir: dir, chain: 'base' },
		);
		const back = await loadFactCacheEntries({ dataDir: dir, chain: 'base' });
		expect(back.tokens.map(([k]) => k)).toEqual(['0xb']);
	});

	it('writes no file for an empty family, and still loads', async () => {
		const counts = await saveFactCacheEntries(
			{ ...EMPTY, tokens: [['0xa', { decimals: 18, symbol: 'A' }]] },
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
			{ ...EMPTY, tokens: [['0xa', { decimals: 18, symbol: '' }]] },
			{ dataDir: dir, chain: 'base' },
		);
		const back = await loadFactCacheEntries({ dataDir: dir, chain: 'base' });
		expect(back.tokens).toEqual([['0xa', { decimals: 18, symbol: '' }]]);
	});

	// Malformed rows below are written with writeRowsToParquet directly (bypassing
	// FactCacheEntries's own type safety) to simulate a corrupted/hand-edited cache
	// file — the on-disk boundary loadFactCacheEntries must defend even though the
	// in-process writer never produces such a row itself.
	describe('refuses a malformed cache row rather than coercing it into a fact', () => {
		it('throws on a NULL decimals rather than reading it back as a plausible 0', async () => {
			await writeRowsToParquet(
				[{ address: '0xa', decimals: null, symbol: 'USDC' }],
				{
					outPath: cacheFilePath({ dataDir: dir, name: 'tokens', chain: 'base' }),
					columnSpec: "{'address': 'VARCHAR', 'decimals': 'INTEGER', 'symbol': 'VARCHAR'}",
					orderBy: 'address',
				},
			);
			await expect(loadFactCacheEntries({ dataDir: dir, chain: 'base' })).rejects.toThrow(/decimals/);
		});

		it('throws on a NULL currency1 rather than reading it back as the string "null"', async () => {
			await writeRowsToParquet(
				[{ pool_id: '0xpoolid', currency0: '0x11', currency1: null }],
				{
					outPath: cacheFilePath({ dataDir: dir, name: 'v4_poolkeys', chain: 'base' }),
					columnSpec: "{'pool_id': 'VARCHAR', 'currency0': 'VARCHAR', 'currency1': 'VARCHAR'}",
					orderBy: 'pool_id',
				},
			);
			await expect(loadFactCacheEntries({ dataDir: dir, chain: 'base' })).rejects.toThrow(/currency1/);
		});

		it('throws on a NULL pool_id rather than coercing it into a usable key', async () => {
			await writeRowsToParquet(
				[{ pool_id: null, currency0: '0x11', currency1: '0x22' }],
				{
					outPath: cacheFilePath({ dataDir: dir, name: 'v4_poolkeys', chain: 'base' }),
					columnSpec: "{'pool_id': 'VARCHAR', 'currency0': 'VARCHAR', 'currency1': 'VARCHAR'}",
					orderBy: 'currency0',
				},
			);
			await expect(loadFactCacheEntries({ dataDir: dir, chain: 'base' })).rejects.toThrow(/pool_id/);
		});
	});

	it('imports only TYPES from @fabric-tca/core', async () => {
		// packages/core's package.json main is ./src/index.ts, so a VALUE import
		// here compiles and passes vitest, then dies at runtime under dist/ with
		// ERR_UNKNOWN_FILE_EXTENSION. Verified in-repo before this plan ran.
		//
		// Matched over the WHOLE source, not line-by-line: a formatter is free to
		// wrap a value import (`import {\n  Foo,\n} from '@fabric-tca/core';`)
		// across multiple lines, and a line-based filter only ever sees the
		// surviving `from '@fabric-tca/core'` line — which carries no `type`
		// keyword to fail on — so a wrapped value import escaped this guard
		// entirely. This is the one test able to catch a runtime-only failure
		// (ERR_UNKNOWN_FILE_EXTENSION under dist/), so it must be airtight.
		const { readFileSync } = await import('node:fs');
		const src = readFileSync(new URL('./factCacheStore.ts', import.meta.url), 'utf8');
		const valueImports = src.match(/import\s+(?!type\b)[\s\S]*?from\s*['"]@fabric-tca\/core['"]/g) ?? [];
		expect(valueImports).toEqual([]);
		expect(src).toMatch(/import type[\s\S]*?from\s*['"]@fabric-tca\/core['"]/);
	});
});
