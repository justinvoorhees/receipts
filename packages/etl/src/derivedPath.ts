import { join } from 'node:path';

/**
 * derivedPath.ts — where a Derived file lives, and what it is called.
 *
 * Mirrors seedPath.ts deliberately, because one convention is load-bearing
 * across both layers: block bounds are zero-padded to ten digits so LEXICAL
 * sort equals NUMERIC sort, and a DuckDB glob therefore returns files in block
 * order for free.
 *
 * ⚠️ The family name comes FIRST, before anything that varies. A build tag or
 * timestamp placed ahead of it would sort files by build rather than by block
 * and interleave unrelated ranges.
 *
 * Two directories, with different lifetimes:
 *
 *   data/derived/<build>/   disposable. A bad build is one `rm -rf`.
 *   data/cache/             durable. Immutable chain facts whose entire value
 *                           is surviving rebuilds, so they are NOT under a
 *                           build directory.
 */

export type DerivedFamily = 'candidates' | 'receipts' | 'legs' | 'pool_state';
export type CacheName = 'pools' | 'tokens' | 'v4_poolkeys';

const PAD = 10;
const NAME_PATTERN = /^[a-z0-9_-]+$/;

function validateChain(chain: string): void {
	if (!NAME_PATTERN.test(chain)) {
		throw new Error(`Chain name must match [a-z0-9_-]+, got "${chain}"`);
	}
}

function validateBuild(build: string): void {
	if (!NAME_PATTERN.test(build)) {
		throw new Error(`Build tag must match [a-z0-9_-]+, got "${build}"`);
	}
}

function pad(block: number): string {
	if (!Number.isInteger(block) || block < 0) {
		throw new Error(`Block number must be a non-negative integer, got ${block}`);
	}
	const text = String(block);
	if (!/^\d+$/.test(text) || text.length > PAD) {
		throw new Error(`Block ${block} exceeds ten digits; the naming convention needs widening`);
	}
	return text.padStart(PAD, '0');
}

/** `candidates.base.0050842630-0050842929.parquet` — bounds inclusive. */
export function derivedFileName(
	family: DerivedFamily,
	chain: string,
	fromBlock: number,
	toBlock: number,
): string {
	validateChain(chain);
	if (toBlock < fromBlock) {
		throw new Error(`Range is inverted: ${fromBlock} > ${toBlock}`);
	}
	return `${family}.${chain}.${pad(fromBlock)}-${pad(toBlock)}.parquet`;
}

/** Absolute path for a Derived file, under its build directory. */
export function derivedFilePath(opts: {
	dataDir: string;
	build: string;
	family: DerivedFamily;
	chain: string;
	fromBlock: number;
	toBlock: number;
}): string {
	validateBuild(opts.build);
	const name = derivedFileName(opts.family, opts.chain, opts.fromBlock, opts.toBlock);
	return join(opts.dataDir, 'derived', opts.build, name);
}

/**
 * Absolute path for a cache file. Deliberately NOT under a build directory —
 * a cache holds facts about the chain, not about a build, and discarding it
 * with a bad build would throw away work that is still correct.
 */
export function cacheFilePath(opts: { dataDir: string; name: CacheName; chain: string }): string {
	validateChain(opts.chain);
	return join(opts.dataDir, 'cache', `${opts.name}.${opts.chain}.parquet`);
}
