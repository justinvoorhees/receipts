import type { FactCacheEntries } from '@fabric-tca/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFactCacheEntries, saveFactCacheEntries } from './factCacheStore.js';

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

	it('imports only TYPES from @fabric-tca/core', async () => {
		// packages/core's package.json main is ./src/index.ts, so a VALUE import
		// here compiles and passes vitest, then dies at runtime under dist/ with
		// ERR_UNKNOWN_FILE_EXTENSION. Verified in-repo before this plan ran.
		const { readFileSync } = await import('node:fs');
		const src = readFileSync(new URL('./factCacheStore.ts', import.meta.url), 'utf8');
		const coreImports = src
			.split('\n')
			.filter((l) => /^\s*import\b[^\n]*'@fabric-tca\/core'/.test(l));
		expect(coreImports.length).toBeGreaterThan(0);
		for (const line of coreImports) expect(line).toMatch(/^import type /);
	});
});
