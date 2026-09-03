import { join } from 'node:path';

/**
 * seedPath.ts — where a Seed file lives, and what it is called.
 *
 * Two conventions are enforced here, both load-bearing:
 *
 * 1. Block bounds are zero-padded to ten digits, so LEXICAL sort equals
 *    NUMERIC sort. A DuckDB glob then returns files in block order for free.
 *    Ten digits reaches block 9,999,999,999 — about 630 years of Base at 2s.
 *
 * 2. Finalized and unfinalized files are separated PHYSICALLY, not by a flag
 *    someone has to remember to check. `data/seeds/*.parquet` is by
 *    construction the canonical archive, ONLY for well-formed chain names.
 *    The non-recursive glob cannot see into `provisional/` as long as the chain
 *    parameter is validated to contain no path separators or traversal sequences.
 */

const PAD = 10;
const CHAIN_PATTERN = /^[a-z0-9_-]+$/;

function validateChain(chain: string): void {
	if (!CHAIN_PATTERN.test(chain)) {
		throw new Error(`Chain name must match [a-z0-9_-]+, got "${chain}"`);
	}
}

function pad(block: number): string {
	if (!Number.isInteger(block) || block < 0) {
		throw new Error(`Block number must be a non-negative integer, got ${block}`);
	}
	const text = String(block);
	// Reject exponential notation (e.g. "1e+21") and any non-numeric string
	if (!/^\d+$/.test(text) || text.length > PAD) {
		throw new Error(`Block ${block} exceeds ten digits; the naming convention needs widening`);
	}
	return text.padStart(PAD, '0');
}

/** `traces.base.0050830910-0050831209.parquet` — bounds inclusive. */
export function seedFileName(chain: string, fromBlock: number, toBlock: number): string {
	validateChain(chain);
	if (toBlock < fromBlock) {
		throw new Error(`Range is inverted: ${fromBlock} > ${toBlock}`);
	}
	return `traces.${chain}.${pad(fromBlock)}-${pad(toBlock)}.parquet`;
}

/**
 * Absolute path for a Seed file. `finalized: false` routes into `provisional/`,
 * which is the entire enforcement mechanism for the spec's admission rule.
 */
export function seedFilePath(opts: {
	dataDir: string;
	chain: string;
	fromBlock: number;
	toBlock: number;
	finalized: boolean;
}): string {
	const name = seedFileName(opts.chain, opts.fromBlock, opts.toBlock);
	const dir = opts.finalized
		? join(opts.dataDir, 'seeds')
		: join(opts.dataDir, 'seeds', 'provisional');
	return join(dir, name);
}
