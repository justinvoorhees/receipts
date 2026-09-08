import { DuckDBInstance } from '@duckdb/node-api';
import type { FactCacheEntries } from '@fabric-tca/core';
import { existsSync } from 'node:fs';
import { cacheFilePath } from './derivedPath.js';
import { sqlLiteral, writeRowsToParquet } from './writeParquet.js';

/**
 * factCacheStore.ts — the FactCache on disk.
 *
 * Three Parquet files under `data/cache/`, deliberately OUTSIDE any build
 * directory: a cache holds facts about the chain, not about a build, and
 * discarding it with a bad build would throw away work that is still correct.
 *
 * ⚠️ `packages/core` must never import this file. It owns the FactCache
 * INTERFACE; DuckDB ships a native binary that must stay out of the dashboard's
 * Railway build, so the Parquet implementation lives here.
 *
 * ⚠️⚠️ EVERY import from packages/core in this file is `import type`, and
 * that is load-bearing, not style. core's package.json sets
 * `"main": "./src/index.ts"`, so a VALUE import from etl typechecks, compiles,
 * and passes vitest (which transpiles) — then dies at runtime under `dist/`
 * with ERR_UNKNOWN_FILE_EXTENSION, because node cannot load a .ts file. A test
 * in factCacheStore.test.ts pins this.
 *
 * That is also why this module trades in plain FactCacheEntries rather than
 * building a FactCache: `createMemoryFactCache` is a runtime value. Callers
 * compose `createMemoryFactCache(await loadFactCacheEntries(...))`.
 *
 * A missing file is a first run, not an error.
 */

const POOL_KEY_COLUMNS = "{'pool_id': 'VARCHAR', 'currency0': 'VARCHAR', 'currency1': 'VARCHAR'}";
const TOKEN_COLUMNS = "{'address': 'VARCHAR', 'decimals': 'INTEGER', 'symbol': 'VARCHAR'}";
const POOL_COLUMNS =
	"{'address': 'VARCHAR', 'token0': 'VARCHAR', 'token1': 'VARCHAR', 'fee_bps': 'DOUBLE', 'factory': 'VARCHAR'}";

async function readRows(path: string): Promise<Record<string, unknown>[]> {
	if (!existsSync(path)) return [];
	const instance = await DuckDBInstance.create(':memory:');
	const connection = await instance.connect();
	try {
		const reader = await connection.runAndReadAll(`SELECT * FROM read_parquet(${sqlLiteral(path)})`);
		return reader.getRowObjects() as Record<string, unknown>[];
	} finally {
		connection.closeSync();
		instance.closeSync();
	}
}

/** `undefined` for an absent optional field — never `null`, which would be a stored fact. */
function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export async function loadFactCacheEntries(opts: {
	dataDir: string;
	chain: string;
}): Promise<FactCacheEntries> {
	const [poolKeyRows, tokenRows, poolRows] = await Promise.all([
		readRows(cacheFilePath({ dataDir: opts.dataDir, name: 'v4_poolkeys', chain: opts.chain })),
		readRows(cacheFilePath({ dataDir: opts.dataDir, name: 'tokens', chain: opts.chain })),
		readRows(cacheFilePath({ dataDir: opts.dataDir, name: 'pools', chain: opts.chain })),
	]);

	const entries: FactCacheEntries = {
		poolKeys: poolKeyRows.map((r) => [
			String(r.pool_id),
			{ currency0: String(r.currency0), currency1: String(r.currency1) },
		]),
		tokens: tokenRows.map((r) => [
			String(r.address),
			{ decimals: Number(r.decimals), symbol: optionalString(r.symbol) ?? null },
		]),
		pools: poolRows.map((r) => [
			String(r.address),
			{
				...(optionalString(r.token0) ? { token0: String(r.token0) } : {}),
				...(optionalString(r.token1) ? { token1: String(r.token1) } : {}),
				...(r.fee_bps == null ? {} : { feeBps: Number(r.fee_bps) }),
				...(optionalString(r.factory) ? { factory: String(r.factory) } : {}),
			},
		]),
	};
	return entries;
}

export async function saveFactCacheEntries(
	entries: FactCacheEntries,
	opts: { dataDir: string; chain: string },
): Promise<{ poolKeys: number; tokens: number; pools: number }> {
	const e = entries;

	// writeRowsToParquet refuses an empty row set (an empty file is never
	// correct), so an empty family is simply not written. Its absence loads as
	// empty on the next run, which is the same thing.
	if (e.poolKeys.length > 0) {
		await writeRowsToParquet(
			e.poolKeys.map(([pool_id, f]) => ({ pool_id, currency0: f.currency0, currency1: f.currency1 })),
			{
				outPath: cacheFilePath({ dataDir: opts.dataDir, name: 'v4_poolkeys', chain: opts.chain }),
				columnSpec: POOL_KEY_COLUMNS,
				orderBy: 'pool_id',
			},
		);
	}
	if (e.tokens.length > 0) {
		await writeRowsToParquet(
			e.tokens.map(([address, f]) => ({ address, decimals: f.decimals, symbol: f.symbol })),
			{
				outPath: cacheFilePath({ dataDir: opts.dataDir, name: 'tokens', chain: opts.chain }),
				columnSpec: TOKEN_COLUMNS,
				orderBy: 'address',
			},
		);
	}
	if (e.pools.length > 0) {
		await writeRowsToParquet(
			e.pools.map(([address, f]) => ({
				address,
				token0: f.token0 ?? null,
				token1: f.token1 ?? null,
				fee_bps: f.feeBps ?? null,
				factory: f.factory ?? null,
			})),
			{
				outPath: cacheFilePath({ dataDir: opts.dataDir, name: 'pools', chain: opts.chain }),
				columnSpec: POOL_COLUMNS,
				orderBy: 'address',
			},
		);
	}

	return { poolKeys: e.poolKeys.length, tokens: e.tokens.length, pools: e.pools.length };
}
