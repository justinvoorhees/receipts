import { buildSeedRows, type IngestMeta } from './buildSeedRows.js';
import { classifyRange, finalizedHead, rpcCall } from './finality.js';
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
	/** Sanity ceiling on `toBlock - fromBlock + 1`. Defaults to `DEFAULT_MAX_BLOCKS`. */
	maxBlocks?: number;
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
 * Ceiling on how many blocks one all-or-nothing run may attempt.
 *
 * The pilot is 300 blocks (~900 RPC calls). There is no chunking and no
 * resumability, so a range is either fully assembled in memory and written or
 * entirely wasted — which makes an accidentally enormous range not a slow run
 * but a very expensive way to reach an OOM. A few thousand blocks is well past
 * anything v0.1 has a reason to ask for, and `--max-blocks` raises it
 * deliberately rather than by typo.
 */
export const DEFAULT_MAX_BLOCKS = 5_000;

/**
 * The range itself, checked before a single RPC call is spent.
 *
 * `NaN` deserves particular attention: `toBlock < opts.fromBlock` and
 * `span > maxBlocks` are both FALSE when either bound is NaN, so a
 * comparison-only check waves an unusable range straight through to the
 * fetch loop.
 */
function assertBlockRange(fromBlock: number, toBlock: number, maxBlocks: number): void {
	if (!Number.isSafeInteger(fromBlock) || fromBlock < 0) {
		throw new Error(`fromBlock must be a non-negative integer, got ${fromBlock}`);
	}
	if (!Number.isSafeInteger(toBlock) || toBlock < 0) {
		throw new Error(`toBlock must be a non-negative integer, got ${toBlock}`);
	}
	if (toBlock < fromBlock) {
		throw new Error(`Range is inverted: ${fromBlock} > ${toBlock}`);
	}
	assertPositiveInteger(maxBlocks, 'maxBlocks');
	const span = toBlock - fromBlock + 1;
	if (span > maxBlocks) {
		throw new Error(
			`Range ${fromBlock}-${toBlock} is ${span} blocks, past the ${maxBlocks}-block ceiling. ` +
				`Ingest is all-or-nothing and holds the whole range in memory, so a range this size ` +
				`is roughly ${span * 3} RPC calls with nothing written if any one of them fails. ` +
				`Split it, or raise --max-blocks deliberately.`,
		);
	}
}

/**
 * `source` is stamped on EVERY row of a file that policy says can never be
 * rewritten, so `--source "$TCA_RPC_URL"` would write the API key into the
 * permanent archive. The value is never echoed back here — a rejection message
 * naming the offending value would leak exactly the secret being refused.
 */
function assertSourceLabel(source: string): void {
	if (typeof source !== 'string' || source.trim() === '') {
		throw new Error('source must be a non-empty provenance label (--source)');
	}
	if (source.includes('://')) {
		throw new Error(
			'source must be a provenance label, never a URL (--source): it is stamped on every ' +
				'row of a file that is never rewritten, and TCA_RPC_URL carries an API key. ' +
				'Pass a label such as "quicknode-base-mainnet".',
		);
	}
}

/**
 * One `eth_chainId` call per RUN — not per block — to check that the endpoint
 * is the chain the operator says it is.
 *
 * `chain_id` is otherwise a pure operator assertion via `--chain-id`, and
 * `chain` is an uncorrelated filename slug: point TCA_RPC_URL at Ethereum
 * mainnet and you get a perfectly well-formed `traces.base.*` file stamped
 * `chain_id = 8453`, full of mainnet blocks, permanently in the canonical
 * archive. Nothing downstream could ever detect it.
 */
async function assertEndpointChain(rpcUrl: string, expected: number): Promise<void> {
	const reported = await rpcCall<string>(rpcUrl, 'eth_chainId', []);
	const actual = Number.parseInt(reported, 16);
	// The reported value is provider-controlled text and is never interpolated.
	if (!Number.isFinite(actual)) {
		throw new Error(
			`Endpoint returned an unparseable eth_chainId; refusing to stamp chain_id ${expected} ` +
				`on rows whose chain it cannot vouch for.`,
		);
	}
	if (actual !== expected) {
		throw new Error(
			`Endpoint is chain ${actual}, but --chain-id says ${expected}. Every row would be ` +
				`stamped with the wrong chain_id in a file that is never rewritten. Point ` +
				`TCA_RPC_URL at chain ${expected}, or pass --chain-id ${actual}.`,
		);
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
	// `Promise.all` rejects on the first failure, but it cannot TELL the other
	// runners — they keep pulling items and issuing calls into an endpoint
	// that, in the likeliest failure mode, is already rate-limiting us. A
	// failure at block 5 of a 300-block run used to spend ~885 more calls
	// before the process noticed, which is how a real pilot attempt died. The
	// run is doomed either way (ingest is all-or-nothing), so stop paying for
	// it.
	let aborted = false;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (!aborted && next < items.length) {
			const index = next++;
			try {
				results[index] = await worker(items[index]!);
			} catch (err) {
				aborted = true;
				throw err;
			}
			onDone?.(++done, items.length);
		}
	});
	await Promise.all(runners);
	return results;
}

export async function ingestRange(opts: IngestOptions): Promise<IngestResult> {
	// Everything below runs BEFORE any RPC call, and is validated here rather
	// than only in the CLI: `ingestRange` is exported from index.ts, so the
	// CLI's own flag parsing is not the only way in. A bad value must fail
	// before it can be spent on RPC calls, and long before it can be stamped
	// into a file that is never rewritten.
	assertPositiveInteger(opts.concurrency, 'concurrency');
	// `chain_id` reaches every row. `Number('abc')` is NaN, JSON.stringify
	// renders NaN as `null`, and DuckDB then writes NULL down the whole
	// column without an error at any layer.
	assertPositiveInteger(opts.chainId, 'chainId');
	assertSourceLabel(opts.source);
	assertBlockRange(opts.fromBlock, opts.toBlock, opts.maxBlocks ?? DEFAULT_MAX_BLOCKS);

	await assertEndpointChain(opts.rpcUrl, opts.chainId);
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
		async (blockNumber) => {
			const payloads = await fetchBlockPayloads(opts.rpcUrl, blockNumber);
			// The admission rule is a property of the ROW: `block_number <=
			// finalized head`. What was checked above is the REQUESTED range —
			// a tag, sent to an endpoint that is free to answer with something
			// else. `block_number` is then derived from the RESPONSE, so
			// without this reconciliation an endpoint answering every request
			// with one block yields a well-formed, correctly-named Seed file
			// whose rows were never tested against the finalized head at all.
			const delivered = Number.parseInt(payloads.block.number, 16);
			if (delivered !== blockNumber) {
				throw new Error(
					`Requested block ${blockNumber} but the endpoint returned block ${delivered} ` +
						`(${JSON.stringify(payloads.block.number)}). Refusing to admit a row whose ` +
						`block_number was never checked against the finalized head.`,
				);
			}
			return buildSeedRows(payloads, meta);
		},
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
