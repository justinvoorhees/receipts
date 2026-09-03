import { buildSeedRows, type IngestMeta } from './buildSeedRows.js';
import { classifyRange, finalizedHead } from './finality.js';
import { fetchBlockPayloads } from './fetchBlock.js';
import type { Finality, SeedRow } from './schema.js';
import { seedFilePath } from './seedPath.js';
import { writeSeedParquet } from './writeSeedParquet.js';

/**
 * ingest.ts — one range in, one Seed file out.
 *
 * Deliberately NOT resumable and NOT incremental in v0.1: a partial Seed file
 * is worse than no Seed file, because a later reader cannot tell the difference
 * between "this range had no swaps" and "ingest died halfway". The whole range
 * is assembled in memory and written once, or nothing is written at all.
 *
 * At the pilot's scale that is fine: ~34,000 rows and ~580 MB of JSON. A range
 * large enough to strain memory is the trigger to add chunking, and the
 * filename convention already accommodates splitting.
 */

export interface IngestOptions {
	rpcUrl: string;
	chain: string;
	chainId: number;
	fromBlock: number;
	toBlock: number;
	dataDir: string;
	source: string;
	allowUnfinalized: boolean;
	concurrency: number;
	onProgress?: (done: number, total: number) => void;
}

export interface IngestResult {
	outPath: string;
	rowCount: number;
	fromBlock: number;
	toBlock: number;
	finality: Finality;
}

/** Resolve `[F - span + 1, F]` where F is the current finalized head. */
export async function finalizedWindow(
	rpcUrl: string,
	span: number,
): Promise<{ fromBlock: number; toBlock: number }> {
	const head = await finalizedHead(rpcUrl);
	return { fromBlock: head - span + 1, toBlock: head };
}

/**
 * `Array.from({ length })` silently treats any non-positive-integer `length`
 * (0, a negative number, NaN, a fraction) as an empty array — it does not
 * throw. A bad `concurrency` value would therefore launch ZERO workers,
 * `worker` would never run, and `mapWithConcurrency` would quietly return a
 * same-length-but-all-holes array that `.flat()` elides into nothing,
 * spending zero RPC calls and producing no signal pointing at the cause. This
 * is the one check both `mapWithConcurrency` and `ingestRange` share, so a
 * bad value is rejected the moment it is known rather than laundered into a
 * silently-empty result somewhere downstream.
 */
function assertPositiveInteger(value: number, label: string): void {
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${label} must be a positive integer, got ${value}`);
	}
}

/**
 * Run `worker` over `items` with at most `limit` in flight at once, returning
 * results in INPUT order regardless of completion order.
 *
 * Exported so `ingest.test.ts` can pin the concurrency bound and the ordering
 * guarantee directly — `ingestRange` itself is only exercised end-to-end by
 * Task 7's live test, which cannot observe either property.
 */
export async function mapWithConcurrency<T>(
	items: number[],
	limit: number,
	worker: (item: number) => Promise<T>,
	onDone?: (done: number, total: number) => void,
): Promise<T[]> {
	assertPositiveInteger(limit, 'concurrency limit');
	const results = new Array<T>(items.length);
	let next = 0;
	let done = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await worker(items[index]!);
			onDone?.(++done, items.length);
		}
	});
	await Promise.all(runners);
	return results;
}

export async function ingestRange(opts: IngestOptions): Promise<IngestResult> {
	if (opts.toBlock < opts.fromBlock) {
		throw new Error(`Range is inverted: ${opts.fromBlock} > ${opts.toBlock}`);
	}
	// Validated here too, ahead of the finalizedHead() RPC call below, so a
	// programmatic caller (ingestRange is exported from index.ts, not just
	// reachable through the CLI's own --concurrency parsing) fails before
	// spending any RPC calls rather than after.
	assertPositiveInteger(opts.concurrency, 'concurrency');

	const head = await finalizedHead(opts.rpcUrl);
	const finality = classifyRange(opts.toBlock, head, opts.allowUnfinalized);
	const ingestedAt = new Date().toISOString();
	const meta: IngestMeta = {
		chainId: opts.chainId,
		finality,
		ingestedAt,
		source: opts.source,
	};

	const blocks = Array.from(
		{ length: opts.toBlock - opts.fromBlock + 1 },
		(_, i) => opts.fromBlock + i,
	);

	const perBlock = await mapWithConcurrency(
		blocks,
		opts.concurrency,
		async (blockNumber) => buildSeedRows(await fetchBlockPayloads(opts.rpcUrl, blockNumber), meta),
		opts.onProgress,
	);

	const rows: SeedRow[] = perBlock.flat();
	const outPath = seedFilePath({
		dataDir: opts.dataDir,
		chain: opts.chain,
		fromBlock: opts.fromBlock,
		toBlock: opts.toBlock,
		finalized: finality === 'finalized',
	});

	const rowCount = await writeSeedParquet(rows, outPath);
	return { outPath, rowCount, fromBlock: opts.fromBlock, toBlock: opts.toBlock, finality };
}
