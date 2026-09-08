import type { FactCacheEntries } from '@fabric-tca/core';
import { existsSync } from 'node:fs';
import { cacheFilePath } from './derivedPath.js';
import { sqlLiteral, withDuckDb, writeRowsToParquet } from './writeParquet.js';

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
 * ⚠️⚠️ EVERY import from `@fabric-tca/core` in this file is `import type`, and
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
	// withDuckDb (writeParquet.ts) nests its try/finally so instance.closeSync()
	// still runs when connect() itself throws — a flat try/finally here would
	// leak the DuckDB instance on exactly that failure.
	return withDuckDb(async (connection) => {
		const reader = await connection.runAndReadAll(`SELECT * FROM read_parquet(${sqlLiteral(path)})`);
		return reader.getRowObjects() as Record<string, unknown>[];
	});
}

/** `undefined` for an absent optional field — never `null`, which would be a
 *  stored fact. A genuinely empty string ("") is a VALUE, not an absence — a
 *  token whose `symbol()` really returns "" must round-trip as "", not be
 *  reclassified as "could not read" (see factCache.ts's "A NULL IS NEVER A
 *  FACT"). Only `undefined`/`null` count as absent. */
function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

/** Required string field read back from the cache Parquet. Throws, naming the
 *  offending field, rather than coercing a missing/null value to a
 *  plausible-looking string — the same posture as prefetched.ts's
 *  `requiredHex` on the Seed path. A poisoned pool key is worse than a
 *  poisoned log: `cachedPoolKeyReader` serves it as a fact FOREVER. */
function requiredString(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`Fact cache row has no usable ${field} (got ${JSON.stringify(value)})`);
	}
	return value;
}

/** Required numeric field. A NULL `decimals` must not silently become a
 *  plausible-looking 0 — see requiredString above for the same reasoning. */
function requiredNumber(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new Error(`Fact cache row has no usable ${field} (got ${JSON.stringify(value)})`);
	}
	return value;
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
			requiredString(r.pool_id, 'pool_id'),
			{
				currency0: requiredString(r.currency0, 'currency0'),
				currency1: requiredString(r.currency1, 'currency1'),
			},
		]),
		tokens: tokenRows.map((r) => [
			requiredString(r.address, 'address'),
			{ decimals: requiredNumber(r.decimals, 'decimals'), symbol: optionalString(r.symbol) ?? null },
		]),
		pools: poolRows.map((r) => {
			const token0 = optionalString(r.token0);
			const token1 = optionalString(r.token1);
			const factory = optionalString(r.factory);
			return [
				String(r.address),
				{
					...(token0 ? { token0 } : {}),
					...(token1 ? { token1 } : {}),
					...(r.fee_bps == null ? {} : { feeBps: Number(r.fee_bps) }),
					...(factory ? { factory } : {}),
				},
			];
		}),
	};
	return entries;
}

/**
 * ⚠️ REPLACES each family's file wholesale — it is not a merge. A caller that
 * builds `entries` without first `loadFactCacheEntries`-ing the existing file
 * and folding it in will silently truncate the accumulated on-disk cache down
 * to whatever it just built. Always compose as
 * `saveFactCacheEntries(mergeIntoExisting(await loadFactCacheEntries(...), newFacts), ...)`.
 */
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
